// ----------------------------------------------------
// GET リクエスト：読み取り系APIエンドポイント
// ----------------------------------------------------
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  let result;
  try {
    switch (action) {
      case 'getProductAndInventoryData':
        result = getProductAndInventoryData();
        break;
      case 'getSchoolList':
        result = getSchoolList();
        break;
      case 'getCustomerInfoByLineId':
        result = getCustomerInfoByLineId(e.parameter.lineUserId);
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    Logger.log('[doGet] エラー: ' + err.message);
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------
// POST リクエスト：書き込み系 & LINE認証APIエンドポイント
// ----------------------------------------------------
function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const action = data.action;
  let result;
  try {
    switch (action) {
      case 'submitOrder':
        result = submitOrder(data.payload);
        break;
      case 'exchangeLineCode':
        result = { userId: getLineUserIdFromCode(data.code) };
        break;
      default:
        result = { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    Logger.log('[doPost] エラー: ' + err.message);
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------
// LINE Login OAuthコードをユーザーIDに交換
// ----------------------------------------------------
function getLineUserIdFromCode(code) {
  const CHANNEL_ID     = '2009555332';
  const CHANNEL_SECRET = 'e33b101940df1867d28259321e2f4b8b';
  const REDIRECT_URI   = 'https://venerable-sawine-2fec62.netlify.app/';

  // アクセストークン取得
  const tokenRes = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=authorization_code'
           + '&code='          + encodeURIComponent(code)
           + '&redirect_uri='  + encodeURIComponent(REDIRECT_URI)
           + '&client_id='     + CHANNEL_ID
           + '&client_secret=' + CHANNEL_SECRET,
    muteHttpExceptions: true
  });
  const tokenData = JSON.parse(tokenRes.getContentText());
  if (!tokenData.access_token) throw new Error('トークン取得失敗: ' + tokenRes.getContentText());

  // プロフィール（userId）取得
  const profileRes = UrlFetchApp.fetch('https://api.line.me/v2/profile', {
    headers: { Authorization: 'Bearer ' + tokenData.access_token },
    muteHttpExceptions: true
  });
  const profile = JSON.parse(profileRes.getContentText());
  if (!profile.userId) throw new Error('プロフィール取得失敗: ' + profileRes.getContentText());

  return profile.userId;
}

// ----------------------------------------------------
// スクール一覧をフロントエンドに渡す関数
// ----------------------------------------------------
function getSchoolList() {
  Logger.log('[getSchoolList] 開始');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('スクール一覧');
  if (!sheet) {
    Logger.log('[getSchoolList] スクール一覧シートが見つかりません');
    return [];
  }
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  data.shift(); // ヘッダー行を除く
  const schools = data.map(row => String(row[0]).trim()).filter(s => s.length > 0);
  Logger.log('[getSchoolList] スクール数: ' + schools.length);
  return schools;
}

// ----------------------------------------------------
// 在庫変更履歴を記録するヘルパー関数
// ----------------------------------------------------
function logInventoryChange(sku, before, after, reason, relatedId, changedBy) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logSheet = ss.getSheetByName('在庫変更履歴');
  if (!logSheet) {
    logSheet = ss.insertSheet('在庫変更履歴');
    const header = ['タイムスタンプ', 'SKU', '変更前', '変更後', '変更量', '変更理由', '関連ID', '変更者'];
    logSheet.appendRow(header);
    logSheet.setFrozenRows(1);
    logSheet.getRange(1, 1, 1, header.length).setFontWeight('bold').setBackground('#f3f4f6');
    Logger.log('[logInventoryChange] 在庫変更履歴シートを新規作成');
  }
  const delta = (typeof before === 'number' && typeof after === 'number') ? after - before : '不明';
  logSheet.appendRow([
    new Date(),
    sku,
    before,
    after,
    delta,
    reason,
    relatedId || '',
    changedBy || 'システム'
  ]);
  Logger.log('[logInventoryChange] SKU: ' + sku + ' / ' + before + ' → ' + after + ' / ' + reason);
}

// ----------------------------------------------------
// フロントエンドに商品と在庫の統合データを渡す関数
// ----------------------------------------------------
function getProductAndInventoryData() {
  try {
    Logger.log('[getProductAndInventoryData] 開始');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const productSheet = ss.getSheetByName('商品一覧');
    if (!productSheet) throw new Error("「商品一覧」シートが見つかりません。");
    const productData = productSheet.getDataRange().getValues();
    const productHeaders = productData.shift();
    const displayIdx = productHeaders.indexOf('サイト掲載');

    const products = [];
    productData.forEach(row => {
      if (displayIdx !== -1 && row[displayIdx] !== '表示') return;
      let obj = {};
      productHeaders.forEach((header, i) => obj[header] = row[i]);
      products.push(obj);
    });
    Logger.log('[getProductAndInventoryData] 掲載商品数: ' + products.length);

    const inventorySheet = ss.getSheetByName('商品在庫');
    if (!inventorySheet) throw new Error("「商品在庫」シートが見つかりません。");
    const inventoryData = inventorySheet.getDataRange().getValues();
    if (inventoryData.length === 0) throw new Error("「商品在庫」シートが空です。");
    const inventoryHeaders = inventoryData.shift();

    const inventory = inventoryData.map(row => {
      let obj = {};
      inventoryHeaders.forEach((header, i) => obj[header] = row[i]);
      return obj;
    });

    products.forEach(product => {
      product.stockList = inventory.filter(inv => String(inv['商品ID']) === String(product['商品ID']));
    });

    Logger.log('[getProductAndInventoryData] 完了');
    return JSON.parse(JSON.stringify(products));

  } catch (e) {
    Logger.log('[getProductAndInventoryData] エラー: ' + e.message);
    throw e;
  }
}

// ----------------------------------------------------
// カートの一括注文と個人情報を処理する関数
// ----------------------------------------------------
function submitOrder(payload) {
  Logger.log('[submitOrder] 開始 - メールアドレス: ' + payload.customerInfo.email + ', カート商品数: ' + payload.cart.length);
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 購入履歴シートの確認・作成
  let historySheet = ss.getSheetByName('購入履歴');
  if (!historySheet) {
    historySheet = ss.insertSheet('購入履歴');
    historySheet.appendRow(['注文ID', 'タイムスタンプ', 'メールアドレス', '参加スクール', '会員氏名', 'SKU', '注文数', '小計金額', 'ステータス', 'LINE UserID']);
    Logger.log('[submitOrder] 購入履歴シートを新規作成');
  }

  const inventorySheet = ss.getSheetByName('商品在庫');
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(10000);
    Logger.log('[submitOrder] ロック取得成功');

    const inventoryData = inventorySheet.getDataRange().getValues();
    const skuIndex = inventoryData[0].indexOf('SKU');
    const stockIndex = inventoryData[0].indexOf('在庫数');

    // 1. 全カート商品の在庫チェック
    let stockUpdates = [];
    for (let item of payload.cart) {
      let targetRow = -1;
      let currentStock = 0;
      for (let i = 1; i < inventoryData.length; i++) {
        if (inventoryData[i][skuIndex] === item.sku) {
          targetRow = i + 1;
          currentStock = Number(inventoryData[i][stockIndex]);
          break;
        }
      }
      Logger.log('[submitOrder] SKU: ' + item.sku + ' / 在庫: ' + currentStock + ' / 注文数: ' + item.quantity);
      if (targetRow === -1 || currentStock < item.quantity) {
        Logger.log('[submitOrder] 在庫不足エラー - SKU: ' + item.sku);
        return { success: false, message: `【在庫不足】 ${item.sku} の在庫が確保できませんでした。他の人が先に購入した可能性があります。` };
      }
      stockUpdates.push({ row: targetRow, sku: item.sku, currentStock: currentStock, newStock: currentStock - item.quantity });
    }

    // 2. 注文IDを先に生成（在庫変更履歴にも記録するため）
    const orderId = 'ORD-' + Utilities.getUuid().split('-')[0].toUpperCase();
    const timestamp = new Date();

    // 3. 在庫のマイナス処理（引き当て）＋変更履歴記録
    stockUpdates.forEach(update => {
      inventorySheet.getRange(update.row, stockIndex + 1).setValue(update.newStock);
      logInventoryChange(update.sku, update.currentStock, update.newStock, '注文', orderId, payload.customerInfo.email);
    });
    Logger.log('[submitOrder] 在庫引き当て完了');

    // 4. 購入履歴への一括書き込み
    const rowsToAppend = payload.cart.map(item => [
      orderId, timestamp, payload.customerInfo.email, payload.customerInfo.school,
      payload.customerInfo.memberName, item.sku, item.quantity, item.price * item.quantity, '未入金',
      payload.lineUserId || ''
    ]);
    historySheet.getRange(historySheet.getLastRow() + 1, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
    Logger.log('[submitOrder] 購入履歴書き込み完了 - 注文ID: ' + orderId);

    // 5. 購入者への確認メール送信
    try {
      const totalAmount = payload.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const itemLines = payload.cart.map(item =>
        `・${item.productName}（${item.variation}）× ${item.quantity}個　¥${(item.price * item.quantity).toLocaleString()}`
      ).join('\n');
      const mailBody = `${payload.customerInfo.memberName} 様\n\n`
        + `この度はご注文いただきありがとうございます。\n`
        + `以下の内容で注文を受け付けました。\n\n`
        + `━━━━━━━━━━━━━━━━━━\n`
        + `【注文ID】 ${orderId}\n`
        + `【注文日時】 ${Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')}\n`
        + `【参加スクール】 ${payload.customerInfo.school}\n`
        + `━━━━━━━━━━━━━━━━━━\n\n`
        + `【ご注文商品】\n${itemLines}\n\n`
        + `【合計金額】 ¥${totalAmount.toLocaleString()}（税込）\n\n`
        + `━━━━━━━━━━━━━━━━━━\n`
        + `※お支払いは月謝と合わせてご案内いたします。\n\n`
        + `アスリッシュ陸上スクール 物販システム`;
      MailApp.sendEmail({
        to: payload.customerInfo.email,
        subject: `【アスリッシュ物販】ご注文受付のお知らせ（注文ID: ${orderId}）`,
        body: mailBody
      });
      Logger.log('[submitOrder] 確認メール送信完了 - 宛先: ' + payload.customerInfo.email);
    } catch (mailError) {
      // メール送信に失敗しても注文自体は成功扱いにする
      Logger.log('[submitOrder] メール送信エラー（注文は完了）: ' + mailError.message);
    }

    const totalAmount = payload.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const itemLines = payload.cart.map(item =>
      `・${item.productName}（${item.variation}）×${item.quantity}個`
    ).join('\n');

    // 6. 管理者へのLINE通知
    try {
      const ADMIN_USER_ID = 'Ud97518e18c40d4de6d83537a7a05d6c1';
      const adminMessage = `🛍️ 新規注文が入りました！\n\n`
        + `【注文ID】 ${orderId}\n`
        + `【注文日時】 ${Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')}\n`
        + `【氏名】 ${payload.customerInfo.memberName}\n`
        + `【スクール】 ${payload.customerInfo.school}\n`
        + `【メール】 ${payload.customerInfo.email}\n\n`
        + `【注文商品】\n${itemLines}\n\n`
        + `【合計金額】 ¥${totalAmount.toLocaleString()}（税込）`;
      sendLineNotification(ADMIN_USER_ID, adminMessage);
      Logger.log('[submitOrder] 管理者LINE通知送信完了');
    } catch (lineError) {
      Logger.log('[submitOrder] 管理者LINE通知エラー（注文は完了）: ' + lineError.message);
    }

    // 7. お客さんへのLINE通知
    if (payload.lineUserId) {
      try {
        const customerMessage = `${payload.customerInfo.memberName} さん\n\n`
          + `ご注文ありがとうございます！✅\n`
          + `以下の内容で受け付けました。\n\n`
          + `【注文ID】 ${orderId}\n`
          + `【注文日時】 ${Utilities.formatDate(timestamp, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')}\n\n`
          + `【ご注文商品】\n${itemLines}\n\n`
          + `【合計金額】 ¥${totalAmount.toLocaleString()}（税込）\n\n`
          + `お支払いは月謝と合わせてご案内します。\n`
          + `アスリッシュ陸上スクール`;
        sendLineNotification(payload.lineUserId, customerMessage);
        Logger.log('[submitOrder] お客さんLINE通知送信完了 - UserID: ' + payload.lineUserId);
      } catch (lineError) {
        Logger.log('[submitOrder] お客さんLINE通知エラー（注文は完了）: ' + lineError.message);
      }
    } else {
      Logger.log('[submitOrder] LINE UserIDなし - お客さんへの通知をスキップ');
    }

    // 8. 顧客情報の保存・更新（次回アクセス時の自動入力用）
    if (payload.lineUserId) {
      try {
        upsertCustomerInfo(ss, payload.lineUserId, payload.customerInfo);
        Logger.log('[submitOrder] 顧客情報保存完了');
      } catch (e) {
        Logger.log('[submitOrder] 顧客情報保存エラー（注文は完了）: ' + e.message);
      }
    }

    return { success: true, message: "注文が正常に完了しました！", orderId: orderId };

  } catch (e) {
    Logger.log('[submitOrder] システムエラー: ' + e.message);
    return { success: false, message: "システムエラーが発生しました: " + e.message };
  } finally {
    lock.releaseLock();
    Logger.log('[submitOrder] ロック解放');
  }
}

// ----------------------------------------------------
// 【管理者用】SKU自動展開 ＆ シート保護機能
// ----------------------------------------------------
function generateSKUs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const productSheet = ss.getSheetByName('商品一覧');
  let inventorySheet = ss.getSheetByName('商品在庫');

  if (!inventorySheet) {
    inventorySheet = ss.insertSheet('商品在庫');
  }

  let inventoryData = inventorySheet.getDataRange().getValues();
  const expectedHeaders = ['SKU', '商品ID', 'サイズ', 'カラー', '在庫数'];

  if (inventoryData.length === 0 || (inventoryData.length === 1 && String(inventoryData[0][0]).trim() === "")) {
    inventorySheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
    inventoryData = [expectedHeaders];
  }

  const existingSKUs = new Set();
  if (inventoryData.length > 1) {
    const skuIndex = inventoryData[0].indexOf('SKU');
    for (let i = 1; i < inventoryData.length; i++) {
      existingSKUs.add(inventoryData[i][skuIndex]);
    }
  }

  const productData = productSheet.getDataRange().getValues();
  const headers = productData.shift();
  const idIdx = headers.indexOf('商品ID');
  const sizeIdx = headers.indexOf('サイズ');
  const colorIdx = headers.indexOf('カラー');

  const newRows = [];

  productData.forEach(row => {
    console.log(String(row[idIdx]))
    const productId = String(row[idIdx]).trim();
    if (!productId) return;

    const sizes = String(row[sizeIdx]).split(',').map(s => s.trim()).filter(s => s !== "");
    const colors = String(row[colorIdx]).split(',').map(c => c.trim()).filter(c => c !== "");

    if (sizes.length === 0) sizes.push("Free");
    if (colors.length === 0) colors.push("None");

    sizes.forEach(size => {
      colors.forEach(color => {
        const sku = `${productId}-${size}-${color}`;
        if (!existingSKUs.has(sku)) {
          newRows.push([sku, productId, size, color, 0]);
        }
      });
    });
  });

  if (newRows.length > 0) {
    inventorySheet.getRange(inventorySheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    SpreadsheetApp.getUi().alert(`${newRows.length}件の新しいSKUを追加しました。\n在庫数を入力してください。`);
  } else {
    SpreadsheetApp.getUi().alert('新しい組み合わせはありませんでした。最新の状態です。');
  }

  // --- 【追加】在庫シートの保護（誤操作防止） ---
  // シート全体を保護し、編集時に警告を出すように設定
  let protection = inventorySheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0];
  if (!protection) {
    protection = inventorySheet.protect().setDescription('在庫シートの誤操作防止');
  }
  // 「在庫数」列（E列）のみ保護から除外（警告なしで編集可能）
  const unprotected = inventorySheet.getRange('E:E');
  protection.setUnprotectedRanges([unprotected]);

  // オーナー（管理者）でも警告を出す設定（Warning Only）
  protection.setWarningOnly(true);
}

// ----------------------------------------------------
// 顧客情報の取得（LINE UserIDをキーに検索）
// ----------------------------------------------------
function getCustomerInfoByLineId(lineUserId) {
  if (!lineUserId) return null;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('顧客情報');
    if (!sheet) return null;
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return null;
    const headers = data[0];
    const lineIdIdx = headers.indexOf('LINE UserID');
    const emailIdx  = headers.indexOf('メールアドレス');
    const schoolIdx = headers.indexOf('参加スクール');
    const nameIdx   = headers.indexOf('会員氏名');
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][lineIdIdx]) === String(lineUserId)) {
        return { email: data[i][emailIdx], school: data[i][schoolIdx], memberName: data[i][nameIdx] };
      }
    }
    return null;
  } catch (e) {
    Logger.log('[getCustomerInfoByLineId] エラー: ' + e.message);
    return null;
  }
}

// ----------------------------------------------------
// 顧客情報の保存・更新（LINE UserIDをキーにupsert）
// ----------------------------------------------------
function upsertCustomerInfo(ss, lineUserId, customerInfo) {
  let sheet = ss.getSheetByName('顧客情報');
  if (!sheet) {
    sheet = ss.insertSheet('顧客情報');
    sheet.appendRow(['LINE UserID', 'メールアドレス', '参加スクール', '会員氏名', '最終更新']);
  }
  const data = sheet.getDataRange().getValues();
  const lineIdIdx = data[0].indexOf('LINE UserID');
  const timestamp = new Date();
  const newRow = [lineUserId, customerInfo.email, customerInfo.school, customerInfo.memberName, timestamp];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][lineIdIdx]) === String(lineUserId)) {
      sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
      return;
    }
  }
  sheet.appendRow(newRow);
}

// ----------------------------------------------------
// LINE通知送信（管理者・お客さん共用）
// ----------------------------------------------------
function sendLineNotification(userId, message) {
  const LINE_TOKEN = 'rNhZPNlb4KrpNO5C/bWejdweak8hbnjVblBDE+guMphhtvzrzAULWcIdOwgCXdXHOHXJRr8UHglys10eHh4tCrJAw0n2Tpmi3uPbo1Vre7zs77yy3c2YwSFdZX/7KUo+mnw1Yh27b7r3yuRkRgub0gdB04t89/1O/w1cDnyilFU=';

  const payload = JSON.stringify({
    to: userId,
    messages: [{ type: 'text', text: message }]
  });

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_TOKEN },
    payload: payload,
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', options);
  const responseCode = response.getResponseCode();
  Logger.log('[sendLineNotification] レスポンスコード: ' + responseCode);
  if (responseCode !== 200) {
    throw new Error('LINE API エラー: ' + responseCode + ' / ' + response.getContentText());
  }
}

// ----------------------------------------------------
// 在庫数の手動編集を検知して変更履歴を記録（シンプルトリガー）
// ----------------------------------------------------
function onEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== '商品在庫') return;
  if (e.range.getRow() === 1) return; // ヘッダー行は無視

  // 編集されたのが「在庫数」列かどうか確認
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const stockColIdx = headers.indexOf('在庫数'); // 0始まり
  if (e.range.getColumn() !== stockColIdx + 1) return;

  const skuColIdx = headers.indexOf('SKU');
  const sku = sheet.getRange(e.range.getRow(), skuColIdx + 1).getValue();
  const before = (e.oldValue !== undefined && e.oldValue !== '') ? Number(e.oldValue) : '不明';
  const after = (e.value !== undefined && e.value !== '') ? Number(e.value) : '不明';
  const editor = e.user ? e.user.getEmail() : '不明';

  logInventoryChange(sku, before, after, '手動変更', '', editor);
}

// ----------------------------------------------------
// スプレッドシートを開いたときのメニュー追加
// ----------------------------------------------------
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🛍️ 物販システム管理')
      .addItem('SKUを在庫シートに自動展開', 'generateSKUs')
      .addSeparator()
      .addItem('🖼️ 商品画像をアップロード', 'openUploadDialog')
      .addToUi();
}

// ----------------------------------------------------
// 【管理者用】商品画像アップロードダイアログを開く
// ----------------------------------------------------
function openUploadDialog() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== '商品一覧') {
    ui.alert('「商品一覧」シートの商品行を選択してから実行してください。');
    return;
  }
  const html = HtmlService.createHtmlOutputFromFile('upload-dialog')
    .setWidth(440)
    .setHeight(500);
  ui.showModalDialog(html, '🖼️ 商品画像アップロード');
}

// アクティブ行の商品情報を取得（ダイアログから呼び出し）
function getActiveRowInfo() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveRange().getRow();
  if (row <= 1) return { error: 'ヘッダー行は選択できません。商品行を選択してください。' };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  const productNameIdx = headers.indexOf('商品名');
  const thumbnailIdx = headers.indexOf('サムネイル画像');
  const detailIdx = headers.indexOf('詳細画像');
  if (thumbnailIdx < 0 && detailIdx < 0) return { error: '「サムネイル画像」または「詳細画像」列が見つかりません。' };
  return {
    row: row,
    productName: productNameIdx >= 0 ? String(rowData[productNameIdx]) : '（商品名なし）',
    thumbnailCol: thumbnailIdx >= 0 ? thumbnailIdx + 1 : null,
    detailCol: detailIdx >= 0 ? detailIdx + 1 : null
  };
}

// 画像をDriveにアップロードして公開URLを返す（ダイアログから呼び出し）
function uploadImageToDrive(base64Data, fileName, mimeType) {
  Logger.log('[uploadImageToDrive] アップロード開始: ' + fileName);
  const folderName = 'アスリッシュ物販_商品画像';
  const folders = DriveApp.getFoldersByName(folderName);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const url = 'https://lh3.googleusercontent.com/d/' + file.getId();
  Logger.log('[uploadImageToDrive] アップロード完了: ' + url);
  return url;
}

// アップロード済みURLをセルに挿入
// mode='replace'のとき上書き（サムネイル用）、mode='append'のときカンマ追記（詳細画像用）
function insertImageUrls(row, imageUrlCol, newUrls, mode) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('商品一覧');
  const cell = sheet.getRange(row, imageUrlCol);
  let combined;
  if (mode === 'replace') {
    combined = newUrls[0] || '';
  } else {
    const currentValue = String(cell.getValue()).trim();
    combined = currentValue ? currentValue + ',' + newUrls.join(',') : newUrls.join(',');
  }
  cell.setValue(combined);
  Logger.log('[insertImageUrls] 行' + row + 'に挿入(' + mode + '): ' + combined);
}
