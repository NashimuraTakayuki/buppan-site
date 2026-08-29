// ============================================================
// 永続キャッシュ（PropertiesService）
// シートが編集されるまで保持する。
// - onEdit が編集を検知して該当キャッシュを invalidate
// - submitOrder は在庫を書き換えた直後に invalidate（onEdit はプログラム書込では発火しないため）
// - 緊急時は onOpen メニューの「キャッシュを全クリア」で invalidateAllCaches を実行
// ============================================================
const CACHE_KEYS = {
	products: "pcache_products", // 商品一覧（マスタ）
	inventory: "pcache_inventory", // 商品在庫
	schools: "pcache_schools", // スクール設定（全行 raw データ）
	discount: "pcache_discount", // 会員特典情報
	config: "pcache_config", // システム設定
};

// シート名 → そのシートが編集されたときに無効化すべきキャッシュキー
const SHEET_CACHE_MAP = {
	商品一覧: [CACHE_KEYS.products],
	商品在庫: [CACHE_KEYS.inventory],
	スクール設定: [CACHE_KEYS.schools],
	会員特典情報: [CACHE_KEYS.discount],
	システム設定: [CACHE_KEYS.config],
};

const PUBLIC_CATALOG_KV = {
	liveKey: "publicCatalog:v1",
	stagingKey: "publicCatalog:staging",
	backupPrefix: "publicCatalog:backup:",
	dirtyKey: "publicCatalog.dirty",
	dirtyReasonKey: "publicCatalog.dirtyReason",
	dirtyAtKey: "publicCatalog.dirtyAt",
	lastPublishedAtKey: "publicCatalog.lastPublishedAt",
	lastPublishedVersionKey: "publicCatalog.lastPublishedVersion",
};

const PUBLIC_CATALOG_SHEETS = {
	商品一覧: true,
	商品在庫: true,
	スクール設定: true,
	会員特典情報: true,
};

/**
 * 永続キャッシュから値を取得。なければ loader() を実行して保存。
 * PropertiesService は 1値=9KB 制限があるため、保存失敗時はキャッシュをあきらめて
 * 生の値を返す（読み取りパスは止めない）。
 */
function getPersistent(key, loader) {
	const props = PropertiesService.getScriptProperties();
	const cached = props.getProperty(key);
	if (cached) {
		try {
			return JSON.parse(cached);
		} catch (e) {
			Logger.log("[cache] JSONパース失敗、キャッシュを破棄: " + key);
			props.deleteProperty(key);
		}
	}
	const fresh = loader();
	try {
		props.setProperty(key, JSON.stringify(fresh));
	} catch (e) {
		Logger.log("[cache] put失敗（キャッシュなしで継続）: " + key + " / " + e.message);
	}
	return fresh;
}

function invalidatePersistent(key) {
	PropertiesService.getScriptProperties().deleteProperty(key);
	Logger.log("[cache] 無効化: " + key);
}

function invalidateAllCaches() {
	Object.values(CACHE_KEYS).forEach(invalidatePersistent);
	try {
		SpreadsheetApp.getActiveSpreadsheet().toast("キャッシュを全クリアしました", "🔄", 3);
	} catch (e) {}
}

// ============================================================
// フォールバック設定値（スプレッドシートで管理できない場合のみ使用）
// 通常はスプレッドシートの「システム設定」シートで管理してください
// ============================================================
const CONFIG_DEFAULTS = {
	lineLogin: {
		channelId: "2009818388",
		channelSecret: "6ed3d4dad5547ffbbaad7f90a9be9844",
		redirectUri: "https://buppan-site.weathered-hill-1bba.workers.dev/",
	},
	defaultNotification: {
		messagingApiToken:
			"rNhZPNlb4KrpNO5C/bWejdweak8hbnjVblBDE+guMphhtvzrzAULWcIdOwgCXdXHOHXJRr8UHglys10eHh4tCrJAw0n2Tpmi3uPbo1Vre7zs77yy3c2YwSFdZX/7KUo+mnw1Yh27b7r3yuRkRgub0gdB04t89/1O/w1cDnyilFU=",
		adminLineUserId: "Ud97518e18c40d4de6d83537a7a05d6c1",
	},
	notification: {
		// 購入者宛て確認メールの送信可否（「システム設定」シートで true / false を指定）
		// 未設定時は送信しない
		customerEmailEnabled: false,
		// 注文発生時の管理者宛通知メールの宛先（カンマ区切りで複数指定可）
		// 通常は「システム設定」シートの notification.adminEmails で管理する
		adminEmails: "",
	},
};

// ============================================================
// スプレッドシートの「システム設定」シートから設定を読み込む
// シートがない場合や値が空の場合は CONFIG_DEFAULTS を使用
// シート列構成: 設定キー | 値
// ============================================================
function getConfig() {
	return getPersistent(CACHE_KEYS.config, function () {
		const config = JSON.parse(JSON.stringify(CONFIG_DEFAULTS)); // deep copy
		try {
			const ss = SpreadsheetApp.getActiveSpreadsheet();
			const sheet = ss.getSheetByName("システム設定");
			if (!sheet) return config;
			const rows = sheet.getDataRange().getValues();
			const map = {};
			rows.forEach((row) => {
				const key = String(row[0]).trim();
				const val = String(row[1]).trim();
				if (key && val) map[key] = val;
			});
			const ov = (path, obj) => {
				const keys = path.split(".");
				let cur = obj;
				for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
				if (map[path]) cur[keys[keys.length - 1]] = map[path];
			};
			ov("lineLogin.channelId", config);
			ov("lineLogin.channelSecret", config);
			ov("lineLogin.redirectUri", config);
			ov("defaultNotification.messagingApiToken", config);
			ov("defaultNotification.adminLineUserId", config);
			ov("notification.customerEmailEnabled", config);
			ov("notification.adminEmails", config);
		} catch (e) {
			Logger.log("[getConfig] シート読み込みエラー（デフォルト値を使用）: " + e.message);
		}
		return config;
	});
}

function isConfigEnabled(value) {
	return value === true || String(value).trim().toLowerCase() === "true";
}

// 後方互換: 既存コードが CONFIG.xxx を参照できるようエイリアスを提供
// （各リクエストの先頭で呼ばれる doGet/doPost 内で上書きされる）
let CONFIG = CONFIG_DEFAULTS;

// ----------------------------------------------------
// スプレッドシートへのログ記録ヘルパー
// level: 'INFO' | 'WARN' | 'ERROR'
// source: 呼び出し元の関数名
// ----------------------------------------------------
function writeLog(level, source, message) {
	// GASエディタの実行ログにも出力
	Logger.log("[" + level + "][" + source + "] " + message);

	try {
		const ss = SpreadsheetApp.getActiveSpreadsheet();
		let logSheet = ss.getSheetByName("実行ログ");
		if (!logSheet) {
			logSheet = ss.insertSheet("実行ログ");
			const headers = ["タイムスタンプ", "レベル", "関数名", "メッセージ"];
			logSheet.appendRow(headers);
			logSheet.setFrozenRows(1);
			logSheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f3f4f6");
			logSheet.setColumnWidth(1, 165);
			logSheet.setColumnWidth(2, 65);
			logSheet.setColumnWidth(3, 190);
			logSheet.setColumnWidth(4, 520);
		}
		logSheet.appendRow([new Date(), level, source, message]);

		// 1000行を超えたら古い行から削除（ヘッダー行は残す）
		const lastRow = logSheet.getLastRow();
		if (lastRow > 1001) {
			logSheet.deleteRows(2, lastRow - 1001);
		}
	} catch (e) {
		Logger.log("[writeLog] ログシートへの書き込みに失敗: " + e.message);
	}
}

// ----------------------------------------------------
// GET リクエスト：読み取り系APIエンドポイント
// ----------------------------------------------------
function doGet(e) {
	CONFIG = getConfig(); // スプレッドシートから最新の設定を読み込む
	const action = e && e.parameter && e.parameter.action;
	let result;
	try {
		switch (action) {
			case "getInitialData":
				result = getInitialData();
				break;
			case "getProductAndInventoryData":
				result = getProductAndInventoryData();
				break;
			case "getSchoolList":
				result = getSchoolList();
				break;
			case "getCustomerInfoByLineId":
				result = getCustomerInfoByLineId(e.parameter.lineUserId);
				break;
			case "getMemberDiscountRate":
				result = getMemberDiscountRate();
				break;
			default:
				result = { error: "Unknown action: " + action };
		}
	} catch (err) {
		writeLog("ERROR", "doGet", "action=" + action + " / " + err.message);
		result = { error: err.message };
	}
	return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
		ContentService.MimeType.JSON,
	);
}

// ----------------------------------------------------
// POST リクエスト：書き込み系 & LINE認証APIエンドポイント
// ----------------------------------------------------
function doPost(e) {
	CONFIG = getConfig(); // スプレッドシートから最新の設定を読み込む
	let data;
	try {
		data = JSON.parse(e.postData.contents);
	} catch (err) {
		return ContentService.createTextOutput(JSON.stringify({ error: "Invalid JSON" })).setMimeType(
			ContentService.MimeType.JSON,
		);
	}

	const action = data.action;
	let result;
	try {
		switch (action) {
			case "submitOrder":
				result = submitOrder(data.payload);
				break;
			case "exchangeLineCode":
				// schoolId を優先。後方互換のため schoolName が来た場合も受ける（IDとして扱う）
				result = {
					userId: getLineUserIdFromCode(data.code, data.schoolId || data.schoolName || ""),
				};
				break;
			default:
				result = { error: "Unknown action: " + action };
		}
	} catch (err) {
		writeLog("ERROR", "doPost", "action=" + action + " / " + err.message);
		result = { error: err.message };
	}
	return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
		ContentService.MimeType.JSON,
	);
}

// ----------------------------------------------------
// スクールごとのLINEログインチャンネル設定を取得
// 引数: schoolId（スクールID。空文字なら何もせずに空オブジェクトを返す）
// スクール設定シートの列: スクールID | LINEログインチャンネルID | LINEログインチャンネルシークレット
// ----------------------------------------------------
function getSchoolLoginConfig(schoolId) {
	try {
		const { headers, rows } = getSchoolSettingsRaw();
		if (rows.length === 0) return {};
		const idIdx = headers.indexOf("スクールID");
		const channelIdIdx = headers.indexOf("LINEログインチャンネルID");
		const channelSecretIdx = headers.indexOf("LINEログインチャンネルシークレット");
		if (idIdx === -1 || channelIdIdx === -1 || channelSecretIdx === -1) return {};
		const target = String(schoolId || "").trim();
		if (!target) {
			// schoolIdが空の場合はフォールバックせず空を返す（CONFIG_DEFAULTSに委ねる）
			return {};
		}
		for (let i = 0; i < rows.length; i++) {
			if (String(rows[i][idIdx]).trim() === target) {
				const channelId = String(rows[i][channelIdIdx]).trim();
				const channelSecret = String(rows[i][channelSecretIdx]).trim();
				if (channelId && channelSecret) return { channelId, channelSecret };
			}
		}
	} catch (e) {
		writeLog("ERROR", "getSchoolLoginConfig", e.message);
	}
	return {};
}

// ----------------------------------------------------
// LINE Login OAuthコードをユーザーIDに交換
// 引数: code, schoolId（スクールID。空ならデフォルトのチャンネル設定を使用）
// ----------------------------------------------------
function getLineUserIdFromCode(code, schoolId) {
	// チャンネルIDのシングルソース: スクール設定シートの「LINEログインチャンネルID」列
	// schoolIdが空の場合もgetSchoolLoginConfig内でシートの最初のエントリを参照する
	const loginConfig = getSchoolLoginConfig(schoolId);
	const CHANNEL_ID = loginConfig.channelId || CONFIG.lineLogin.channelId;
	const CHANNEL_SECRET = loginConfig.channelSecret || CONFIG.lineLogin.channelSecret;
	const REDIRECT_URI = CONFIG.lineLogin.redirectUri;

	// アクセストークン取得
	const tokenRes = UrlFetchApp.fetch("https://api.line.me/oauth2/v2.1/token", {
		method: "post",
		contentType: "application/x-www-form-urlencoded",
		payload:
			"grant_type=authorization_code" +
			"&code=" +
			encodeURIComponent(code) +
			"&redirect_uri=" +
			encodeURIComponent(REDIRECT_URI) +
			"&client_id=" +
			CHANNEL_ID +
			"&client_secret=" +
			CHANNEL_SECRET,
		muteHttpExceptions: true,
	});
	const tokenData = JSON.parse(tokenRes.getContentText());
	if (!tokenData.access_token) {
		const msg = "トークン取得失敗: " + tokenRes.getContentText();
		writeLog("ERROR", "getLineUserIdFromCode", msg);
		throw new Error(msg);
	}

	// プロフィール（userId）取得
	const profileRes = UrlFetchApp.fetch("https://api.line.me/v2/profile", {
		headers: { Authorization: "Bearer " + tokenData.access_token },
		muteHttpExceptions: true,
	});
	const profile = JSON.parse(profileRes.getContentText());
	if (!profile.userId) {
		const msg = "プロフィール取得失敗: " + profileRes.getContentText();
		writeLog("ERROR", "getLineUserIdFromCode", msg);
		throw new Error(msg);
	}

	return profile.userId;
}

// ----------------------------------------------------
// スクール設定シートの全行 raw データを永続キャッシュから取得
// getSchoolList / getSchoolConfig の共通基盤
// 返却: { headers: string[], rows: any[][] }
// ----------------------------------------------------
function getSchoolSettingsRaw() {
	return getPersistent(CACHE_KEYS.schools, function () {
		const ss = SpreadsheetApp.getActiveSpreadsheet();
		const sheet = ss.getSheetByName("スクール設定");
		if (!sheet) {
			writeLog("ERROR", "getSchoolSettingsRaw", "スクール設定シートが見つかりません");
			return { headers: [], rows: [] };
		}
		const data = sheet.getDataRange().getValues();
		if (data.length === 0) return { headers: [], rows: [] };
		return { headers: data[0], rows: data.slice(1) };
	});
}

// ----------------------------------------------------
// スクール一覧をフロントエンドに渡す関数（スクール設定シートから取得）
// 返却フォーマット: [{ id, name, lineChannelId }, ...]
// ----------------------------------------------------
function getSchoolList() {
	Logger.log("[getSchoolList] 開始");
	const { headers, rows } = getSchoolSettingsRaw();
	if (rows.length === 0) return [];
	const nameIdx = headers.indexOf("スクール名");
	const idIdx = headers.indexOf("スクールID");
	const channelIdIdx = headers.indexOf("LINEログインチャンネルID");
	if (nameIdx === -1) {
		writeLog("ERROR", "getSchoolList", "スクール設定シートに「スクール名」列が見つかりません");
		return [];
	}
	const schools = rows
		.filter((row) => String(row[nameIdx]).trim().length > 0)
		.map((row) => ({
			id: idIdx !== -1 ? String(row[idIdx]).trim() : "",
			name: String(row[nameIdx]).trim(),
			lineChannelId: channelIdIdx !== -1 ? String(row[channelIdIdx]).trim() : "",
		}));
	Logger.log("[getSchoolList] スクール数: " + schools.length);
	return schools;
}

// ----------------------------------------------------
// 在庫変更履歴を記録するヘルパー関数
// ----------------------------------------------------
function logInventoryChange(sku, before, after, reason, relatedId, changedBy) {
	const ss = SpreadsheetApp.getActiveSpreadsheet();
	let logSheet = ss.getSheetByName("在庫変更履歴");
	if (!logSheet) {
		logSheet = ss.insertSheet("在庫変更履歴");
		const header = [
			"タイムスタンプ",
			"SKU",
			"変更前",
			"変更後",
			"変更量",
			"変更理由",
			"関連ID",
			"変更者",
		];
		logSheet.appendRow(header);
		logSheet.setFrozenRows(1);
		logSheet.getRange(1, 1, 1, header.length).setFontWeight("bold").setBackground("#f3f4f6");
		Logger.log("[logInventoryChange] 在庫変更履歴シートを新規作成");
	}
	const delta = typeof before === "number" && typeof after === "number" ? after - before : "不明";
	logSheet.appendRow([
		new Date(),
		sku,
		before,
		after,
		delta,
		reason,
		relatedId || "",
		changedBy || "システム",
	]);
	Logger.log("[logInventoryChange] SKU: " + sku + " / " + before + " → " + after + " / " + reason);
}

// ----------------------------------------------------
// 商品一覧（マスタ）を永続キャッシュから取得
// ----------------------------------------------------
function getProductsMaster() {
	return getPersistent(CACHE_KEYS.products, function () {
		const ss = SpreadsheetApp.getActiveSpreadsheet();
		const productSheet = ss.getSheetByName("商品一覧");
		if (!productSheet) throw new Error("「商品一覧」シートが見つかりません。");
		const productData = productSheet.getDataRange().getValues();
		const productHeaders = productData.shift();
		const displayIdx = productHeaders.indexOf("サイト掲載");

		const products = [];
		productData.forEach((row) => {
			if (displayIdx !== -1 && row[displayIdx] !== "表示") return;
			const obj = {};
			productHeaders.forEach((header, i) => (obj[header] = row[i]));
			products.push(obj);
		});
		Logger.log("[getProductsMaster] 掲載商品数: " + products.length);
		return products;
	});
}

// ----------------------------------------------------
// 商品在庫を永続キャッシュから取得
// onEdit（手動編集）と submitOrder（注文時の引き当て）の両方で invalidate される
// ----------------------------------------------------
function getInventoryData() {
	return getPersistent(CACHE_KEYS.inventory, function () {
		const ss = SpreadsheetApp.getActiveSpreadsheet();
		const inventorySheet = ss.getSheetByName("商品在庫");
		if (!inventorySheet) throw new Error("「商品在庫」シートが見つかりません。");
		const inventoryData = inventorySheet.getDataRange().getValues();
		if (inventoryData.length === 0) throw new Error("「商品在庫」シートが空です。");
		const inventoryHeaders = inventoryData.shift();

		const inventory = inventoryData.map((row) => {
			const obj = {};
			inventoryHeaders.forEach((header, i) => (obj[header] = row[i]));
			return obj;
		});
		Logger.log("[getInventoryData] 在庫件数: " + inventory.length);
		return inventory;
	});
}

// ----------------------------------------------------
// 集約エンドポイント：初回ページロードに必要な全データを1リクエストで返す
// 個別エンドポイント（getProductAndInventoryData / getSchoolList / getMemberDiscountRate）も
// 後方互換のため残してある
//
// 耐障害性: 1つの取得が失敗しても他は返せるよう個別にtry-catchする
// （元の app.js は schools 取得失敗以外は非ブロッキングだった挙動を維持）
// ----------------------------------------------------
function getInitialData() {
	const result = {
		products: [],
		schools: [],
		discountRate: { discountRate: 0 },
	};
	try {
		result.products = getProductAndInventoryData();
	} catch (e) {
		Logger.log("[getInitialData] products取得エラー（空配列で継続）: " + e.message);
		result.productsError = e.message;
	}
	try {
		result.schools = getSchoolList();
	} catch (e) {
		Logger.log("[getInitialData] schools取得エラー: " + e.message);
		result.schoolsError = e.message;
	}
	try {
		result.discountRate = getMemberDiscountRate();
	} catch (e) {
		Logger.log("[getInitialData] discount取得エラー: " + e.message);
		result.discountRateError = e.message;
	}
	return result;
}

// ----------------------------------------------------
// フロントエンドに商品と在庫の統合データを渡す関数
// 商品マスタと在庫を別キャッシュで持ち、結合は毎回 Map ベースで行う（O(P+I)）
// 結合時は Object.assign でシャローコピー → キャッシュオブジェクトの汚染を防止
// ----------------------------------------------------
function getProductAndInventoryData() {
	try {
		Logger.log("[getProductAndInventoryData] 開始");
		const products = getProductsMaster();
		const inventory = getInventoryData();

		// 商品ID → 在庫リスト の Map を構築（O(I)）
		const inventoryByProductId = new Map();
		inventory.forEach((inv) => {
			const id = String(inv["商品ID"]);
			if (!inventoryByProductId.has(id)) inventoryByProductId.set(id, []);
			inventoryByProductId.get(id).push(inv);
		});

		// 結合（O(P)）。Object.assign でシャローコピーしてキャッシュを汚染しない
		const merged = products.map((p) =>
			Object.assign({}, p, {
				stockList: inventoryByProductId.get(String(p["商品ID"])) || [],
			}),
		);

		Logger.log("[getProductAndInventoryData] 完了");
		return merged;
	} catch (e) {
		Logger.log("[getProductAndInventoryData] エラー: " + e.message);
		throw e;
	}
}

// ----------------------------------------------------
// Cloudflare KV 公開カタログ連携
// 表示高速化用の公開JSONだけをKVへ同期する。注文確定時の最新在庫チェックは
// 従来どおり submitOrder 内でスプレッドシートを直接確認する。
// ----------------------------------------------------
function buildPublicCatalogSnapshot() {
	const now = new Date();
	const version =
		Utilities.formatDate(now, "Asia/Tokyo", "yyyyMMddHHmmss") +
		"-" +
		Utilities.getUuid().split("-")[0];
	const snapshot = {
		schemaVersion: 1,
		version,
		generatedAt: now.toISOString(),
		products: getProductAndInventoryData(),
		schools: getSchoolList(),
		discountRate: getMemberDiscountRate(),
	};
	validatePublicCatalogSnapshot(snapshot);
	return snapshot;
}

function validatePublicCatalogSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== "object") {
		throw new Error("公開カタログがオブジェクトではありません");
	}
	if (!Array.isArray(snapshot.products)) {
		throw new Error("公開カタログに products がありません");
	}
	if (!Array.isArray(snapshot.schools)) {
		throw new Error("公開カタログに schools がありません");
	}
	if (!snapshot.discountRate || typeof snapshot.discountRate !== "object") {
		throw new Error("公開カタログに discountRate がありません");
	}

	const forbiddenKeys = {
		LINEログインチャンネルシークレット: true,
		Messaging_API_Token: true,
		管理者LINE_UserID: true,
		channelSecret: true,
		messagingApiToken: true,
		adminLineUserId: true,
		adminId: true,
		メールアドレス: true,
		"LINE UserID": true,
	};
	const scan = (value, path) => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => scan(item, path + "[" + index + "]"));
			return;
		}
		if (!value || typeof value !== "object") return;
		Object.keys(value).forEach((key) => {
			if (forbiddenKeys[key]) {
				throw new Error("公開カタログに含めてはいけないキーがあります: " + path + "." + key);
			}
			scan(value[key], path ? path + "." + key : key);
		});
	};
	scan(snapshot, "catalog");
	return true;
}

function getCloudflareKvSettings() {
	const props = PropertiesService.getScriptProperties();
	const settings = {
		accountId: props.getProperty("CF_ACCOUNT_ID"),
		namespaceId: props.getProperty("CF_KV_NAMESPACE_ID"),
		apiToken: props.getProperty("CF_API_TOKEN"),
	};
	const missing = [];
	if (!settings.accountId) missing.push("CF_ACCOUNT_ID");
	if (!settings.namespaceId) missing.push("CF_KV_NAMESPACE_ID");
	if (!settings.apiToken) missing.push("CF_API_TOKEN");
	if (missing.length > 0) {
		throw new Error("Cloudflare KV設定が不足しています: " + missing.join(", "));
	}
	return settings;
}

function hasCloudflareKvSettings() {
	const props = PropertiesService.getScriptProperties();
	return (
		!!props.getProperty("CF_ACCOUNT_ID") &&
		!!props.getProperty("CF_KV_NAMESPACE_ID") &&
		!!props.getProperty("CF_API_TOKEN")
	);
}

function cloudflareKvValueUrl(key) {
	const settings = getCloudflareKvSettings();
	return (
		"https://api.cloudflare.com/client/v4/accounts/" +
		encodeURIComponent(settings.accountId) +
		"/storage/kv/namespaces/" +
		encodeURIComponent(settings.namespaceId) +
		"/values/" +
		encodeURIComponent(key)
	);
}

function cloudflareKvRequest(method, key, payload) {
	const settings = getCloudflareKvSettings();
	const options = {
		method,
		muteHttpExceptions: true,
		headers: {
			Authorization: "Bearer " + settings.apiToken,
		},
	};
	if (payload !== undefined) {
		options.contentType = "application/json";
		options.payload = payload;
	}

	const response = UrlFetchApp.fetch(cloudflareKvValueUrl(key), options);
	const code = response.getResponseCode();
	const text = response.getContentText();
	if (method === "get" && code === 404) return null;
	if (code < 200 || code >= 300) {
		throw new Error("Cloudflare KV " + method + " failed: HTTP " + code + " / " + text);
	}
	if (method !== "get" && text) {
		let parsed = null;
		try {
			parsed = JSON.parse(text);
		} catch (e) {
			parsed = null;
		}
		if (parsed && parsed.success === false) {
			throw new Error("Cloudflare KV " + method + " failed: " + JSON.stringify(parsed.errors || parsed));
		}
	}
	return text;
}

function cloudflareKvGet(key) {
	return cloudflareKvRequest("get", key);
}

function cloudflareKvPut(key, value) {
	return cloudflareKvRequest("put", key, value);
}

function publishPublicCatalogToKv(reason) {
	const snapshot = buildPublicCatalogSnapshot();
	const json = JSON.stringify(snapshot);
	const liveKey = PUBLIC_CATALOG_KV.liveKey;
	const stagingKey = PUBLIC_CATALOG_KV.stagingKey;
	const backupKey = PUBLIC_CATALOG_KV.backupPrefix + snapshot.version;
	const props = PropertiesService.getScriptProperties();

	const current = cloudflareKvGet(liveKey);
	if (current) {
		cloudflareKvPut(backupKey, current);
	}

	cloudflareKvPut(stagingKey, json);
	const staged = cloudflareKvGet(stagingKey);
	if (!staged) throw new Error("KV staging の読み戻しに失敗しました");
	const stagedSnapshot = JSON.parse(staged);
	validatePublicCatalogSnapshot(stagedSnapshot);
	if (stagedSnapshot.version !== snapshot.version) {
		throw new Error("KV staging の version が一致しません");
	}

	cloudflareKvPut(liveKey, staged);
	props.deleteProperty(PUBLIC_CATALOG_KV.dirtyKey);
	props.deleteProperty(PUBLIC_CATALOG_KV.dirtyReasonKey);
	props.deleteProperty(PUBLIC_CATALOG_KV.dirtyAtKey);
	props.setProperty(PUBLIC_CATALOG_KV.lastPublishedAtKey, snapshot.generatedAt);
	props.setProperty(PUBLIC_CATALOG_KV.lastPublishedVersionKey, snapshot.version);

	writeLog(
		"INFO",
		"publishPublicCatalogToKv",
		"KV公開カタログ更新完了 - version=" +
			snapshot.version +
			" / reason=" +
			(reason || "(none)") +
			" / bytes=" +
			json.length,
	);
	return {
		success: true,
		version: snapshot.version,
		generatedAt: snapshot.generatedAt,
		backupKey: current ? backupKey : "",
		bytes: json.length,
	};
}

function publishInitialPublicCatalogToKv() {
	return publishPublicCatalogToKv("initial");
}

function markPublicCatalogDirty(reason) {
	const props = PropertiesService.getScriptProperties();
	props.setProperty(PUBLIC_CATALOG_KV.dirtyKey, "1");
	props.setProperty(PUBLIC_CATALOG_KV.dirtyReasonKey, reason || "(no reason)");
	props.setProperty(PUBLIC_CATALOG_KV.dirtyAtKey, new Date().toISOString());
	Logger.log("[publicCatalog] dirty: " + (reason || "(no reason)"));
}

function publishDirtyPublicCatalog() {
	const props = PropertiesService.getScriptProperties();
	if (props.getProperty(PUBLIC_CATALOG_KV.dirtyKey) !== "1") {
		return { skipped: true, reason: "not dirty" };
	}
	if (!hasCloudflareKvSettings()) {
		return { skipped: true, reason: "Cloudflare KV settings are missing" };
	}
	const reason = props.getProperty(PUBLIC_CATALOG_KV.dirtyReasonKey) || "dirty trigger";
	return publishPublicCatalogToKv(reason);
}

function restorePublicCatalogFromBackup(version) {
	if (!version) throw new Error("復元するバックアップ version を指定してください");
	const backupKey =
		String(version).indexOf(PUBLIC_CATALOG_KV.backupPrefix) === 0
			? String(version)
			: PUBLIC_CATALOG_KV.backupPrefix + String(version);
	const backup = cloudflareKvGet(backupKey);
	if (!backup) throw new Error("バックアップが見つかりません: " + backupKey);
	const snapshot = JSON.parse(backup);
	validatePublicCatalogSnapshot(snapshot);
	cloudflareKvPut(PUBLIC_CATALOG_KV.stagingKey, backup);
	cloudflareKvPut(PUBLIC_CATALOG_KV.liveKey, backup);
	PropertiesService.getScriptProperties().setProperty(
		PUBLIC_CATALOG_KV.lastPublishedVersionKey,
		snapshot.version || backupKey,
	);
	writeLog("WARN", "restorePublicCatalogFromBackup", "KV公開カタログを復元: " + backupKey);
	return { success: true, restoredFrom: backupKey, version: snapshot.version || "" };
}

function setupPublicCatalogPublishTrigger() {
	ScriptApp.getProjectTriggers().forEach((trigger) => {
		if (trigger.getHandlerFunction() === "publishDirtyPublicCatalog") {
			ScriptApp.deleteTrigger(trigger);
		}
	});
	ScriptApp.newTrigger("publishDirtyPublicCatalog").timeBased().everyMinutes(1).create();
	return { success: true, handler: "publishDirtyPublicCatalog", everyMinutes: 1 };
}

// ----------------------------------------------------
// 購入履歴シートに書き込む行配列を構築する（純関数・テスト対象）
// 列: 注文ID, タイムスタンプ, メール, スクール, 氏名, SKU, 注文数,
//     支払金額小計, 最終支払額, ステータス, LINE UserID
// 最終支払額・ステータス（未入金）は注文の先頭行のみに記入し、
// 明細行（タイムセール割引・会員特典割引・2品目以降）は空欄とする
// ----------------------------------------------------
function buildHistoryRows(orderId, timestamp, payload, discountAmount, finalTotalAmount) {
	const rows = [];
	const base = [
		orderId,
		timestamp,
		payload.customerInfo.email,
		payload.customerInfo.school,
		payload.customerInfo.memberName,
	];
	const lineUserId = payload.lineUserId || "";

	payload.cart.forEach((item) => {
		const normalSubtotal = (item.normalPrice || item.price) * item.quantity;
		const timesaleDiscount = normalSubtotal - item.price * item.quantity;
		const isFirstRow = rows.length === 0;

		// 1. 商品行（通常価格で記録）
		rows.push(
			base.concat([
				item.sku,
				item.quantity,
				normalSubtotal,
				isFirstRow ? finalTotalAmount : "",
				isFirstRow ? "未入金" : "",
				lineUserId,
			]),
		);

		// 2. タイムセール割引行（別の行として記録。支払金額小計にマイナス差分を入れる）
		if (timesaleDiscount > 0) {
			rows.push(
				base.concat([
					`タイムセール割引 (${item.sku})`,
					item.quantity,
					-timesaleDiscount,
					"",
					"",
					lineUserId,
				]),
			);
		}
	});

	// 3. 会員特典割引行（支払金額小計にマイナス値を設定）
	if (discountAmount > 0) {
		rows.push(base.concat(["会員特典割引", 1, -discountAmount, "", "", lineUserId]));
	}

	return rows;
}

// ----------------------------------------------------
// カートの一括注文と個人情報を処理する関数
// ----------------------------------------------------
function submitOrder(payload) {
	writeLog(
		"INFO",
		"submitOrder",
		"開始 - メール: " +
			payload.customerInfo.email +
			" / スクール: " +
			payload.customerInfo.school +
			" / スクールID: " +
			(payload.lineSource || "(なし)") +
			" / カート商品数: " +
			payload.cart.length,
	);
	const ss = SpreadsheetApp.getActiveSpreadsheet();

	// 購入履歴シートの確認・作成
	let historySheet = ss.getSheetByName("購入履歴");
	const historyHeaders = [
		"注文ID",
		"タイムスタンプ",
		"メールアドレス",
		"参加スクール",
		"会員氏名",
		"SKU",
		"注文数",
		"支払金額小計",
		"最終支払額",
		"ステータス",
		"LINE UserID",
	];

	if (!historySheet) {
		historySheet = ss.insertSheet("購入履歴");
		historySheet.appendRow(historyHeaders);
		Logger.log("[submitOrder] 購入履歴シートを新規作成");
	} else {
		// 既存シートのヘッダーチェック（古い形式の場合は強制更新）
		const currentHeaders = historySheet
			.getRange(1, 1, 1, historySheet.getLastColumn())
			.getValues()[0];
		// 「最終支払額」列がない旧形式の場合は、既存データの整合を保つため
		// 「支払金額小計」の右に列を挿入してからヘッダーを更新する
		if (currentHeaders.indexOf("最終支払額") === -1 && currentHeaders.indexOf("支払金額小計") !== -1) {
			historySheet.insertColumnAfter(currentHeaders.indexOf("支払金額小計") + 1);
			Logger.log("[submitOrder] 購入履歴シートに「最終支払額」列を挿入");
		}
		if (
			currentHeaders.indexOf("支払金額小計") === -1 ||
			currentHeaders.indexOf("最終支払額") === -1 ||
			currentHeaders.length !== historyHeaders.length
		) {
			historySheet.getRange(1, 1, 1, historyHeaders.length).setValues([historyHeaders]);
			Logger.log("[submitOrder] 購入履歴シートのヘッダーを最新形式に更新");
		}
	}

	const inventorySheet = ss.getSheetByName("商品在庫");
	const lock = LockService.getScriptLock();

	try {
		lock.waitLock(10000);
		Logger.log("[submitOrder] ロック取得成功");

		const inventoryData = inventorySheet.getDataRange().getValues();
		const skuIndex = inventoryData[0].indexOf("SKU");
		const stockIndex = inventoryData[0].indexOf("在庫数");

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
			Logger.log(
				"[submitOrder] SKU: " +
					item.sku +
					" / 在庫: " +
					currentStock +
					" / 注文数: " +
					item.quantity,
			);
			if (targetRow === -1 || currentStock < item.quantity) {
				writeLog(
					"WARN",
					"submitOrder",
					"在庫不足 - SKU: " +
						item.sku +
						" / 在庫: " +
						currentStock +
						" / 注文数: " +
						item.quantity,
				);
				return {
					success: false,
					message: `【在庫不足】 ${item.sku} の在庫が確保できませんでした。他の人が先に購入した可能性があります。`,
				};
			}
			stockUpdates.push({
				row: targetRow,
				sku: item.sku,
				currentStock: currentStock,
				newStock: currentStock - item.quantity,
			});
		}

		// 2. 注文IDを先に生成（在庫変更履歴にも記録するため）
		const orderId = "ORD-" + Utilities.getUuid().split("-")[0].toUpperCase();
		const timestamp = new Date();

		// 3. 在庫のマイナス処理（引き当て）＋変更履歴記録
		stockUpdates.forEach((update) => {
			inventorySheet.getRange(update.row, stockIndex + 1).setValue(update.newStock);
			logInventoryChange(
				update.sku,
				update.currentStock,
				update.newStock,
				"注文",
				orderId,
				payload.customerInfo.email,
			);
		});
		// 在庫キャッシュを無効化（onEdit はプログラム書込では発火しないため明示的に呼ぶ）
		invalidatePersistent(CACHE_KEYS.inventory);
		markPublicCatalogDirty("submitOrder inventory update: " + orderId);
		Logger.log("[submitOrder] 在庫引き当て完了");

		// 4. 購入履歴への一括書き込み
		// 会員特典割引の計算（LINE連携済みの場合のみ）
		let discountRate = 0;
		if (payload.lineUserId) {
			discountRate = getMemberDiscountRate().discountRate;
		}
		const subtotalAmount = payload.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
		const discountAmount = discountRate > 0 ? Math.round(subtotalAmount * (discountRate / 100)) : 0;
		const finalTotalAmount = subtotalAmount - discountAmount;

		const rowsToAppend = buildHistoryRows(orderId, timestamp, payload, discountAmount, finalTotalAmount);

		const startRow = historySheet.getLastRow() + 1;
		historySheet
			.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length)
			.setValues(rowsToAppend);

		// 最終支払額列の強調書式（列は背景色、金額セルは太字）
		try {
			const finalCol = historyHeaders.indexOf("最終支払額") + 1;
			historySheet.getRange(startRow, finalCol, rowsToAppend.length, 1).setBackground("#FAEEDA");
			historySheet.getRange(startRow, finalCol).setFontWeight("bold");
		} catch (formatError) {
			// 書式設定の失敗は注文成立に影響させない
			writeLog(
				"WARN",
				"submitOrder",
				"書式設定エラー（注文は完了） - 注文ID: " + orderId + " / " + formatError.message,
			);
		}

		writeLog(
			"INFO",
			"submitOrder",
			"購入履歴書き込み完了 - 注文ID: " +
				orderId +
				" / 合計: ¥" +
				finalTotalAmount.toLocaleString(),
		);
		try {
			publishDirtyPublicCatalog();
		} catch (kvError) {
			writeLog(
				"WARN",
				"submitOrder",
				"KV公開カタログ更新エラー（注文は完了） - 注文ID: " +
					orderId +
					" / " +
					kvError.message,
			);
		}

			// 金額表記用の文字列作成 (割引の有無で分岐)
		let amountText = `【小計金額】 ¥${subtotalAmount.toLocaleString()}\n`;
		if (discountAmount > 0) {
			amountText += `【会員特典割引】 -¥${discountAmount.toLocaleString()} (${discountRate}%OFF)\n`;
		}
		amountText += `【合計金額】 ¥${finalTotalAmount.toLocaleString()}（税込）\n`;

		// 5. 購入者への確認メール送信
		if (isConfigEnabled(getConfig().notification.customerEmailEnabled)) {
			try {
				const itemLines = payload.cart
					.map(
						(item) =>
							`・${item.productName}（${item.variation}）× ${item.quantity}個　¥${(item.price * item.quantity).toLocaleString()}`,
					)
					.join("\n");
				const mailBody =
					`${payload.customerInfo.memberName} 様\n\n` +
					`この度はご注文いただきありがとうございます。\n` +
					`以下の内容で注文を受け付けました。\n\n` +
					`━━━━━━━━━━━━━━━━━━\n` +
					`【注文ID】 ${orderId}\n` +
					`【注文日時】 ${Utilities.formatDate(timestamp, "Asia/Tokyo", "yyyy/MM/dd HH:mm")}\n` +
					`【参加スクール】 ${payload.customerInfo.school}\n` +
					`━━━━━━━━━━━━━━━━━━\n\n` +
					`【ご注文商品】\n${itemLines}\n\n` +
					amountText +
					`\n` +
					`━━━━━━━━━━━━━━━━━━\n` +
					`※お支払いは月会費と合わせてご案内いたします。\n\n` +
					`アスリッシュ陸上スクール`;
				MailApp.sendEmail({
					to: payload.customerInfo.email,
					subject: `【アスリッシュ物販】ご注文受付のお知らせ（注文ID: ${orderId}）`,
					body: mailBody,
				});
				Logger.log("[submitOrder] 確認メール送信完了 - 宛先: " + payload.customerInfo.email);
			} catch (mailError) {
				// メール送信に失敗しても注文自体は成功扱いにする
				writeLog(
					"ERROR",
					"submitOrder",
					"メール送信エラー（注文は完了） - 宛先: " +
						payload.customerInfo.email +
						" / " +
						mailError.message,
				);
			}
		} else {
			writeLog(
				"INFO",
				"submitOrder",
				"購入者向け確認メールは設定により送信スキップ - 注文ID: " + orderId,
			);
		}

		const itemLinesSimple = payload.cart
			.map((item) => `・${item.productName}（${item.variation}）×${item.quantity}個`)
			.join("\n");

		// 6. 管理者へのLINE通知（アクセス元公式LINEのチャネルで送信）
		// スクールID（payload.lineSource）優先で設定検索、なければスクール名で検索
		const schoolIdentifier = payload.lineSource || payload.customerInfo.school;
		const schoolConfig = getSchoolConfig(schoolIdentifier);
		// 管理者向け通知本文（LINE・メール共通）
		const adminMessage =
			`🛍️ 新規注文が入りました！\n\n` +
			`【注文ID】 ${orderId}\n` +
			`【注文日時】 ${Utilities.formatDate(timestamp, "Asia/Tokyo", "yyyy/MM/dd HH:mm")}\n` +
			`【氏名】 ${payload.customerInfo.memberName}\n` +
			`【スクール】 ${payload.customerInfo.school}\n` +
			`【メール】 ${payload.customerInfo.email}\n\n` +
			`【注文商品】\n${itemLinesSimple}\n\n` +
			amountText;
		try {
			sendLineNotification(schoolConfig.adminId, adminMessage, schoolConfig.token);
			writeLog(
				"INFO",
				"submitOrder",
				"管理者LINE通知送信完了 - 検索キー: " +
					schoolIdentifier +
					" / adminId: " +
					schoolConfig.adminId,
			);
		} catch (lineError) {
			writeLog(
				"ERROR",
				"submitOrder",
				"管理者LINE通知エラー（注文は完了） - 検索キー: " +
					schoolIdentifier +
					" / " +
					lineError.message,
			);
		}

		// 6.5. 管理者への通知メール（LINE通知と併存。宛先は「システム設定」シートで管理）
		try {
			const adminEmails = String(getConfig().notification.adminEmails || "")
				.split(",")
				.map((addr) => addr.trim())
				.filter((addr) => addr);
			if (adminEmails.length === 0) {
				writeLog(
					"WARN",
					"submitOrder",
					"管理者通知メールの宛先未設定のため送信スキップ（システム設定シートの notification.adminEmails を設定してください） - 注文ID: " +
						orderId,
				);
			} else {
				MailApp.sendEmail({
					to: adminEmails.join(","),
					subject: `【アスリッシュ物販】新規注文のお知らせ（注文ID: ${orderId}）`,
					body: adminMessage,
				});
				writeLog(
					"INFO",
					"submitOrder",
					"管理者通知メール送信完了 - 宛先: " + adminEmails.join(",") + " / 注文ID: " + orderId,
				);
			}
		} catch (adminMailError) {
			writeLog(
				"ERROR",
				"submitOrder",
				"管理者通知メールエラー（注文は完了） - 注文ID: " + orderId + " / " + adminMailError.message,
			);
		}

		// 7. お客さんへのLINE通知
		if (payload.lineUserId) {
			try {
				const customerMessage =
					`${payload.customerInfo.memberName} さん\n\n` +
					`ご注文ありがとうございます！✅\n` +
					`以下の内容で受け付けました。\n\n` +
					`【注文ID】 ${orderId}\n` +
					`【注文日時】 ${Utilities.formatDate(timestamp, "Asia/Tokyo", "yyyy/MM/dd HH:mm")}\n\n` +
					`【ご注文商品】\n${itemLinesSimple}\n\n` +
					amountText +
					`\n` +
					`お支払いは月会費と合わせてご案内します。\n` +
					`アスリッシュ陸上スクール`;
				sendLineNotification(payload.lineUserId, customerMessage, schoolConfig.token);
				Logger.log("[submitOrder] お客さんLINE通知送信完了 - UserID: " + payload.lineUserId);
			} catch (lineError) {
				writeLog(
					"ERROR",
					"submitOrder",
					"お客さんLINE通知エラー（注文は完了） - UserID: " +
						payload.lineUserId +
						" / " +
						lineError.message,
				);
			}
		} else {
			Logger.log("[submitOrder] LINE UserIDなし - お客さんへの通知をスキップ");
		}

		// 8. 顧客情報の保存・更新（次回アクセス時の自動入力用）
		if (payload.lineUserId) {
			try {
				upsertCustomerInfo(ss, payload.lineUserId, payload.customerInfo);
				Logger.log("[submitOrder] 顧客情報保存完了");
			} catch (e) {
				Logger.log("[submitOrder] 顧客情報保存エラー（注文は完了）: " + e.message);
			}
		}

		return { success: true, message: "注文が正常に完了しました！", orderId: orderId };
	} catch (e) {
		writeLog("ERROR", "submitOrder", "システムエラー: " + e.message);
		return { success: false, message: "システムエラーが発生しました: " + e.message };
	} finally {
		lock.releaseLock();
		Logger.log("[submitOrder] ロック解放");
	}
}

// ----------------------------------------------------
// 【管理者用】SKU自動展開 ＆ シート保護機能
// ----------------------------------------------------
function generateSKUs(isAuto) {
	const isAutoRun = isAuto === true;
	const ss = SpreadsheetApp.getActiveSpreadsheet();
	const productSheet = ss.getSheetByName("商品一覧");
	let inventorySheet = ss.getSheetByName("商品在庫");

	if (!inventorySheet) {
		inventorySheet = ss.insertSheet("商品在庫");
	}

	let inventoryData = inventorySheet.getDataRange().getValues();
	const expectedHeaders = ["SKU", "商品ID", "サイズ", "カラー", "在庫数"];

	if (
		inventoryData.length === 0 ||
		(inventoryData.length === 1 && String(inventoryData[0][0]).trim() === "")
	) {
		inventorySheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
		inventoryData = [expectedHeaders];
	}

	const existingSKUs = new Set();
	if (inventoryData.length > 1) {
		const skuIndex = inventoryData[0].indexOf("SKU");
		for (let i = 1; i < inventoryData.length; i++) {
			existingSKUs.add(inventoryData[i][skuIndex]);
		}
	}

	const productData = productSheet.getDataRange().getValues();
	const headers = productData.shift();
	const idIdx = headers.indexOf("商品ID");
	const sizeIdx = headers.indexOf("サイズ");
	const colorIdx = headers.indexOf("カラー");

	const newRows = [];

	productData.forEach((row) => {
		console.log(String(row[idIdx]));
		const productId = String(row[idIdx]).trim();
		if (!productId) return;

		const sizes = String(row[sizeIdx])
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== "");
		const colors = String(row[colorIdx])
			.split(",")
			.map((c) => c.trim())
			.filter((c) => c !== "");

		if (sizes.length === 0) sizes.push("Free");
		if (colors.length === 0) colors.push("None");

		sizes.forEach((size) => {
			colors.forEach((color) => {
				const sku = `${productId}-${size}-${color}`;
				if (!existingSKUs.has(sku)) {
					newRows.push([sku, productId, size, color, 0]);
				}
			});
		});
	});

	if (newRows.length > 0) {
		inventorySheet
			.getRange(inventorySheet.getLastRow() + 1, 1, newRows.length, newRows[0].length)
			.setValues(newRows);
			// 商品在庫シートにプログラム書き込みしたので在庫キャッシュを無効化
			invalidatePersistent(CACHE_KEYS.inventory);
			markPublicCatalogDirty("generateSKUs inventory rows: " + newRows.length);
			if (!isAutoRun) {
			SpreadsheetApp.getUi().alert(
				`${newRows.length}件の新しいSKUを追加しました。\n在庫数を入力してください。`,
			);
		} else {
			SpreadsheetApp.getActiveSpreadsheet().toast(
				`${newRows.length}件の新しいSKUを追加しました。在庫数を入力してください。`,
				"SKU自動展開",
			);
		}
	} else {
		if (!isAutoRun) {
			SpreadsheetApp.getUi().alert("新しい組み合わせはありませんでした。最新の状態です。");
		}
	}

	// --- 【追加】在庫シートの保護（誤操作防止） ---
	try {
		// シート全体を保護し、編集時に警告を出すように設定
		let protection = inventorySheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)[0];
		if (!protection) {
			protection = inventorySheet.protect().setDescription("在庫シートの誤操作防止");
		}
		// 「在庫数」列（E列）のみ保護から除外（警告なしで編集可能）
		const unprotected = inventorySheet.getRange("E:E");
		protection.setUnprotectedRanges([unprotected]);

		// オーナー（管理者）でも警告を出す設定（Warning Only）
		protection.setWarningOnly(true);
	} catch (err) {
		console.warn("[generateSKUs] 保護設定エラー: " + err.message);
	}
}

// ----------------------------------------------------
// 会員特典情報シートから割引率を取得
// 「会員特典情報」シートの B1 セルの値（数値）を返す
// ----------------------------------------------------
function getMemberDiscountRate() {
	return getPersistent(CACHE_KEYS.discount, function () {
		try {
			const ss = SpreadsheetApp.getActiveSpreadsheet();
			const sheet = ss.getSheetByName("会員特典情報");
			if (!sheet) {
				Logger.log("[getMemberDiscountRate] 会員特典情報シートが見つかりません");
				return { discountRate: 0 };
			}
			const value = sheet.getRange("B1").getValue();
			const rate = parseFloat(String(value));
			Logger.log("[getMemberDiscountRate] 割引率: " + rate);
			return { discountRate: isNaN(rate) ? 0 : rate };
		} catch (e) {
			Logger.log("[getMemberDiscountRate] エラー: " + e.message);
			return { discountRate: 0 };
		}
	});
}

// ----------------------------------------------------
// 顧客情報の取得（LINE UserIDをキーに検索）
// ----------------------------------------------------
function getCustomerInfoByLineId(lineUserId) {
	if (!lineUserId) return null;
	try {
		const ss = SpreadsheetApp.getActiveSpreadsheet();
		const sheet = ss.getSheetByName("顧客情報");
		if (!sheet) return null;
		const data = sheet.getDataRange().getValues();
		if (data.length <= 1) return null;
		const headers = data[0];
		const lineIdIdx = headers.indexOf("LINE UserID");
		const emailIdx = headers.indexOf("メールアドレス");
		const schoolIdx = headers.indexOf("参加スクール");
		const nameIdx = headers.indexOf("会員氏名");
		for (let i = 1; i < data.length; i++) {
			if (String(data[i][lineIdIdx]) === String(lineUserId)) {
				return {
					email: data[i][emailIdx],
					school: data[i][schoolIdx],
					memberName: data[i][nameIdx],
				};
			}
		}
		return null;
	} catch (e) {
		Logger.log("[getCustomerInfoByLineId] エラー: " + e.message);
		return null;
	}
}

// ----------------------------------------------------
// 顧客情報の保存・更新（LINE UserIDをキーにupsert）
// ----------------------------------------------------
function upsertCustomerInfo(ss, lineUserId, customerInfo) {
	let sheet = ss.getSheetByName("顧客情報");
	if (!sheet) {
		sheet = ss.insertSheet("顧客情報");
		sheet.appendRow(["LINE UserID", "メールアドレス", "参加スクール", "会員氏名", "最終更新"]);
	}
	const data = sheet.getDataRange().getValues();
	const lineIdIdx = data[0].indexOf("LINE UserID");
	const timestamp = new Date();
	const newRow = [
		lineUserId,
		customerInfo.email,
		customerInfo.school,
		customerInfo.memberName,
		timestamp,
	];
	for (let i = 1; i < data.length; i++) {
		if (String(data[i][lineIdIdx]) === String(lineUserId)) {
			sheet.getRange(i + 1, 1, 1, newRow.length).setValues([newRow]);
			return;
		}
	}
	sheet.appendRow(newRow);
}

// ----------------------------------------------------
// スクール設定の取得（スクール設定シートを参照）
// 引数: identifier（スクールIDまたはスクール名のいずれか）
// 検索順: スクールID列 → スクール名列（フォールバック）
// スクール設定シートの列: スクールID | スクール名 | Messaging_API_Token | 管理者LINE_UserID
// ----------------------------------------------------
function getSchoolConfig(identifier) {
	const DEFAULT_TOKEN = CONFIG.defaultNotification.messagingApiToken;
	const DEFAULT_ADMIN_ID = CONFIG.defaultNotification.adminLineUserId;

	try {
		const { headers, rows } = getSchoolSettingsRaw();
		if (rows.length === 0) {
			Logger.log(
				"[getSchoolConfig] スクール設定が空です。デフォルト設定を使用します。",
			);
			return { token: DEFAULT_TOKEN, adminId: DEFAULT_ADMIN_ID };
		}

		const idIdx = headers.indexOf("スクールID");
		const nameIdx = headers.indexOf("スクール名");
		const tokenIdx = headers.indexOf("Messaging_API_Token");
		const adminIdx = headers.indexOf("管理者LINE_UserID");

		if (nameIdx === -1 || tokenIdx === -1 || adminIdx === -1) {
			Logger.log(
				"[getSchoolConfig] スクール設定シートの列が不足しています。デフォルト設定を使用します。",
			);
			return { token: DEFAULT_TOKEN, adminId: DEFAULT_ADMIN_ID };
		}

		const target = String(identifier || "").trim();
		if (!target) return { token: DEFAULT_TOKEN, adminId: DEFAULT_ADMIN_ID };

		const matchRow = (row) => {
			const token = String(row[tokenIdx]).trim();
			const adminId = String(row[adminIdx]).trim();
			if (token && adminId) return { token, adminId };
			return null;
		};

		// 1. まず スクールID 列で検索
		if (idIdx !== -1) {
			for (let i = 0; i < rows.length; i++) {
				if (String(rows[i][idIdx]).trim() === target) {
					const result = matchRow(rows[i]);
					if (result) {
						Logger.log("[getSchoolConfig] スクールID「" + target + "」の設定を取得しました。");
						return result;
					}
				}
			}
		}

		// 2. スクール名 列にフォールバック（顧客情報のスクール名で検索する場合）
		for (let i = 0; i < rows.length; i++) {
			if (String(rows[i][nameIdx]).trim() === target) {
				const result = matchRow(rows[i]);
				if (result) {
					Logger.log("[getSchoolConfig] スクール名「" + target + "」の設定を取得しました。");
					return result;
				}
			}
		}

		writeLog(
			"WARN",
			"getSchoolConfig",
			"スクール「" + target + "」の設定が見つかりません。デフォルト設定を使用します。",
		);
		return { token: DEFAULT_TOKEN, adminId: DEFAULT_ADMIN_ID };
	} catch (e) {
		writeLog("ERROR", "getSchoolConfig", e.message + " / デフォルト設定を使用します。");
		return { token: DEFAULT_TOKEN, adminId: DEFAULT_ADMIN_ID };
	}
}

// ----------------------------------------------------
// LINE通知送信（管理者・お客さん共用）
// token: Messaging API Channel Access Token（省略時はデフォルトチャネル）
// ----------------------------------------------------
function sendLineNotification(userId, message, token) {
	const LINE_TOKEN = token || CONFIG.defaultNotification.messagingApiToken;

	const payload = JSON.stringify({
		to: userId,
		messages: [{ type: "text", text: message }],
	});

	const options = {
		method: "post",
		contentType: "application/json",
		headers: { Authorization: "Bearer " + LINE_TOKEN },
		payload: payload,
		muteHttpExceptions: true,
	};

	const response = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", options);
	const responseCode = response.getResponseCode();
	Logger.log("[sendLineNotification] レスポンスコード: " + responseCode);
	if (responseCode !== 200) {
		const errMsg = "LINE API エラー: " + responseCode + " / " + response.getContentText();
		writeLog("ERROR", "sendLineNotification", "userId: " + userId + " / " + errMsg);
		throw new Error(errMsg);
	}
}

// ----------------------------------------------------
// 在庫数の手動編集を検知して変更履歴を記録、およびSKU自動展開（シンプルトリガー）
// スクール設定シートではスクールID自動採番とURL自動生成も行う
// ----------------------------------------------------
function onEdit(e) {
	if (!e || !e.range) return;
	const sheet = e.range.getSheet();
	const sheetName = sheet.getName();

	// 編集されたシートに対応する永続キャッシュを無効化
	// （SKU自動展開や在庫変更ログの処理よりも先に実行することで、
	//  もし以降の処理で例外が出ても少なくともキャッシュは破棄されている状態にする）
	const cacheKeys = SHEET_CACHE_MAP[sheetName];
	if (cacheKeys) {
		cacheKeys.forEach(invalidatePersistent);
	}
	if (PUBLIC_CATALOG_SHEETS[sheetName]) {
		markPublicCatalogDirty("sheet edit: " + sheetName);
	}

	// 商品一覧シートが編集された場合はSKUを自動展開
	if (sheetName === "商品一覧") {
		if (e.range.getRow() > 1) {
			// ヘッダー行以外の編集なら
			generateSKUs(true);
		}
		return;
	}

	// スクール設定シートの編集 → IDの自動採番 & URLの自動生成
	if (sheetName === "スクール設定") {
		if (e.range.getRow() > 1) {
			handleSchoolSettingEdit(e);
		}
		return;
	}

	// 以降は「商品在庫」シートの編集検知
	if (sheetName !== "商品在庫") return;
	if (e.range.getRow() === 1) return; // ヘッダー行は無視

	// 編集されたのが「在庫数」列かどうか確認
	const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
	const stockColIdx = headers.indexOf("在庫数"); // 0始まり
	if (e.range.getColumn() !== stockColIdx + 1) return;

	const skuColIdx = headers.indexOf("SKU");
	const sku = sheet.getRange(e.range.getRow(), skuColIdx + 1).getValue();
	const before = e.oldValue !== undefined && e.oldValue !== "" ? Number(e.oldValue) : "不明";
	const after = e.value !== undefined && e.value !== "" ? Number(e.value) : "不明";
	const editor = e.user ? e.user.getEmail() : "不明";

	logInventoryChange(sku, before, after, "手動変更", "", editor);
}

// ----------------------------------------------------
// スクール設定シートの編集ハンドラ
// - スクール名が入力されていてスクールIDが空なら、連番（s001, s002, ...）でIDを自動採番
// - LINEログインチャンネルIDが入力されていてURLが空なら、同じチャンネルIDの既存行から
//   LIFFのURL（?以前のベース部分）をコピーして ?source=<新ID> を付与する
// ----------------------------------------------------
function handleSchoolSettingEdit(e) {
	const sheet = e.range.getSheet();
	const editedRow = e.range.getRow();
	const lastCol = sheet.getLastColumn();
	const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

	const idIdx = headers.indexOf("スクールID");
	const nameIdx = headers.indexOf("スクール名");
	const channelIdIdx = headers.indexOf("LINEログインチャンネルID");
	const urlIdx = headers.indexOf("リッチメニューに追加するURL");

	if (idIdx === -1 || nameIdx === -1) return; // 列がなければ何もしない

	const rowValues = sheet.getRange(editedRow, 1, 1, lastCol).getValues()[0];
	const name = String(rowValues[nameIdx] || "").trim();
	let currentId = String(rowValues[idIdx] || "").trim();

	// 1. ID自動採番：スクール名が入っていて、スクールIDが未入力なら
	if (name && !currentId) {
		currentId = generateNextSchoolId(sheet, idIdx);
		sheet.getRange(editedRow, idIdx + 1).setValue(currentId);
		writeLog(
			"INFO",
			"handleSchoolSettingEdit",
			"ID自動採番: 行" + editedRow + " " + name + " → " + currentId,
		);
	}

	// 2. URL自動生成：チャンネルIDが入っていて、URLが空ならテンプレートから生成
	if (urlIdx !== -1 && channelIdIdx !== -1 && currentId) {
		const url = String(rowValues[urlIdx] || "").trim();
		const channelId = String(rowValues[channelIdIdx] || "").trim();
		if (channelId && !url) {
			const liffBase = findLiffBaseForChannel(sheet, channelIdIdx, urlIdx, channelId, editedRow);
			if (liffBase) {
				const newUrl = liffBase + "?source=" + encodeURIComponent(currentId);
				sheet.getRange(editedRow, urlIdx + 1).setValue(newUrl);
				writeLog("INFO", "handleSchoolSettingEdit", "URL自動生成: 行" + editedRow + " → " + newUrl);
			} else {
				writeLog(
					"WARN",
					"handleSchoolSettingEdit",
					"行" +
						editedRow +
						": チャンネルID " +
						channelId +
						" のLIFF URLサンプルが見つからず、URL自動生成をスキップ",
				);
			}
		}
	}
}

// 既存のスクールIDから次の連番（s001, s002, ...）を生成
function generateNextSchoolId(sheet, idIdx) {
	const lastRow = sheet.getLastRow();
	let maxNum = 0;
	if (lastRow >= 2) {
		const idCol = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
		idCol.forEach((r) => {
			const m = String(r[0] || "").match(/^s(\d+)$/);
			if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
		});
	}
	return "s" + String(maxNum + 1).padStart(3, "0");
}

// 同じチャンネルIDの行で既に設定済みのURLからLIFFベース（?以前）を取り出す
// excludeRow: 自分自身の行は除外
function findLiffBaseForChannel(sheet, channelIdIdx, urlIdx, channelId, excludeRow) {
	const lastRow = sheet.getLastRow();
	if (lastRow < 2) return null;
	const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
	for (let i = 0; i < data.length; i++) {
		if (i + 2 === excludeRow) continue;
		if (String(data[i][channelIdIdx] || "").trim() !== channelId) continue;
		const u = String(data[i][urlIdx] || "").trim();
		if (!u) continue;
		const qi = u.indexOf("?");
		return qi !== -1 ? u.substring(0, qi) : u;
	}
	return null;
}

// ----------------------------------------------------
// スプレッドシートを開いたときのメニュー追加
// ----------------------------------------------------
function onOpen() {
	const ui = SpreadsheetApp.getUi();
	ui.createMenu("🛍️ 物販システム管理")
		.addItem("SKUを在庫シートに自動展開", "generateSKUs")
		.addSeparator()
			.addItem("🖼️ 商品画像をアップロード", "openUploadDialog")
			.addSeparator()
			.addItem("🔄 キャッシュを全クリア", "invalidateAllCaches")
			.addItem("☁️ KV公開カタログを手動更新", "publishInitialPublicCatalogToKv")
			.addItem("⏱️ KV更新トリガーをセットアップ", "setupPublicCatalogPublishTrigger")
			.addSeparator()
			.addItem("📊 購入履歴を最終支払額形式へ移行（1回のみ）", "migrateHistoryFinalAmount")
			.addToUi();
}

// ============================================================
// 【管理者用・1回実行】購入履歴シートを「最終支払額」形式へ移行する
// 要件定義 v1.2を基にし、行グループ化は行わない移行スクリプト。
// 1. バックアップシートを作成
// 2. 「最終支払額」列を挿入しヘッダー更新（submitOrder側の自動挿入と同一ロジック）
// 3. 注文IDごとに支払金額小計を集計し、先頭行に最終支払額を記入（背景色＋太字）
// 4. 先頭行以外のステータスをクリア（食い違いはWARNログに記録）
// 5. 検証: 最終支払額列のSUM == 支払金額小計列のSUM
// ============================================================
function migrateHistoryFinalAmount() {
	const ss = SpreadsheetApp.getActiveSpreadsheet();
	const sheet = ss.getSheetByName("購入履歴");
	if (!sheet) throw new Error("「購入履歴」シートが見つかりません");

	// 1. バックアップ作成
	const backupName =
		"購入履歴_backup_" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmmss");
	sheet.copyTo(ss).setName(backupName);
	Logger.log("[migrate] バックアップ作成: " + backupName);

	// 2. 「最終支払額」列の挿入（未挿入の場合のみ）
	let headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
	if (headers.indexOf("最終支払額") === -1) {
		const subtotalIdx = headers.indexOf("支払金額小計");
		if (subtotalIdx === -1) throw new Error("「支払金額小計」列が見つかりません");
		sheet.insertColumnAfter(subtotalIdx + 1);
		sheet.getRange(1, subtotalIdx + 2).setValue("最終支払額");
		headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
	}
	const orderIdCol = headers.indexOf("注文ID") + 1;
	const subtotalCol = headers.indexOf("支払金額小計") + 1;
	const finalCol = headers.indexOf("最終支払額") + 1;
	const statusCol = headers.indexOf("ステータス") + 1;

	const lastRow = sheet.getLastRow();
	if (lastRow < 2) {
		Logger.log("[migrate] データ行なし。列挿入のみで終了");
		return;
	}
	const numRows = lastRow - 1;
	const data = sheet.getRange(2, 1, numRows, sheet.getLastColumn()).getValues();

	// 3〜4. 注文IDごとに集計（行は注文IDごとに連続している前提。念のため非連続もキー単位で集計）
	const finalValues = []; // 最終支払額列の新しい値
	const statusValues = []; // ステータス列の新しい値
	const firstRowByOrder = {}; // 注文ID -> 先頭行index(0始まり)
	const totalByOrder = {};
	const statusByOrder = {};
	const mismatches = [];

	data.forEach((row, i) => {
		const oid = String(row[orderIdCol - 1]);
		const subtotal = Number(row[subtotalCol - 1]) || 0;
		const status = String(row[statusCol - 1] || "").trim();
		if (!(oid in firstRowByOrder)) {
			firstRowByOrder[oid] = i;
			totalByOrder[oid] = 0;
			statusByOrder[oid] = status;
		} else if (status && status !== statusByOrder[oid]) {
			mismatches.push(
				`注文ID ${oid}: 行${i + 2} のステータス「${status}」が先頭行「${statusByOrder[oid]}」と不一致`,
			);
		}
		totalByOrder[oid] += subtotal;
	});

	data.forEach((row, i) => {
		const oid = String(row[orderIdCol - 1]);
		const isFirst = firstRowByOrder[oid] === i;
		finalValues.push([isFirst ? totalByOrder[oid] : ""]);
		statusValues.push([isFirst ? statusByOrder[oid] : ""]);
	});

	sheet.getRange(2, finalCol, numRows, 1).setValues(finalValues);
	sheet.getRange(2, statusCol, numRows, 1).setValues(statusValues);

	// 最終支払額列の強調書式（列全体に背景色、金額セルのみ太字）
	sheet.getRange(1, finalCol, lastRow, 1).setBackground("#FAEEDA").setFontWeight("normal");
	Object.keys(firstRowByOrder).forEach((oid) => {
		sheet.getRange(firstRowByOrder[oid] + 2, finalCol).setFontWeight("bold");
	});

	// 4. 食い違いログ
	mismatches.forEach((msg) => writeLog("WARN", "migrateHistoryFinalAmount", msg));

	// 5. 検証
	const subtotalSum = data.reduce((sum, row) => sum + (Number(row[subtotalCol - 1]) || 0), 0);
	const finalSum = Object.values(totalByOrder).reduce((sum, v) => sum + v, 0);
	const ok = subtotalSum === finalSum;
	writeLog(
		ok ? "INFO" : "ERROR",
		"migrateHistoryFinalAmount",
		`移行完了 - 注文数: ${Object.keys(firstRowByOrder).length} / 小計SUM: ${subtotalSum} / 最終支払額SUM: ${finalSum} / 検証: ${ok ? "OK" : "NG"} / ステータス食い違い: ${mismatches.length}件`,
	);
	SpreadsheetApp.getUi().alert(
		ok
			? `移行が完了しました。\n注文数: ${Object.keys(firstRowByOrder).length}\n検証OK（小計SUM=最終支払額SUM: ¥${finalSum.toLocaleString()}）\nステータス食い違い: ${mismatches.length}件（ログ参照）\nバックアップ: ${backupName}`
			: `移行は完了しましたが検証NGです。ログを確認してください。\n小計SUM: ${subtotalSum} / 最終支払額SUM: ${finalSum}\nバックアップ: ${backupName}`,
	);
}

// ----------------------------------------------------
// 【管理者用】商品画像アップロードダイアログを開く
// ----------------------------------------------------
function openUploadDialog() {
	const ui = SpreadsheetApp.getUi();
	const sheet = SpreadsheetApp.getActiveSheet();
	if (sheet.getName() !== "商品一覧") {
		ui.alert("「商品一覧」シートの商品行を選択してから実行してください。");
		return;
	}
	const html = HtmlService.createHtmlOutputFromFile("upload-dialog").setWidth(440).setHeight(500);
	ui.showModalDialog(html, "🖼️ 商品画像アップロード");
}

// アクティブ行の商品情報を取得（ダイアログから呼び出し）
function getActiveRowInfo() {
	const sheet = SpreadsheetApp.getActiveSheet();
	const row = sheet.getActiveRange().getRow();
	if (row <= 1) return { error: "ヘッダー行は選択できません。商品行を選択してください。" };
	const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
	const rowData = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
	const productNameIdx = headers.indexOf("商品名");
	const thumbnailIdx = headers.indexOf("サムネイル画像");
	const detailIdx = headers.indexOf("詳細画像");
	if (thumbnailIdx < 0 && detailIdx < 0)
		return { error: "「サムネイル画像」または「詳細画像」列が見つかりません。" };
	return {
		row: row,
		productName: productNameIdx >= 0 ? String(rowData[productNameIdx]) : "（商品名なし）",
		thumbnailCol: thumbnailIdx >= 0 ? thumbnailIdx + 1 : null,
		detailCol: detailIdx >= 0 ? detailIdx + 1 : null,
	};
}

// 画像をDriveにアップロードして公開URLを返す（ダイアログから呼び出し）
function uploadImageToDrive(base64Data, fileName, mimeType) {
	Logger.log("[uploadImageToDrive] アップロード開始: " + fileName);
	const folderName = "アスリッシュ物販_商品画像";
	const folders = DriveApp.getFoldersByName(folderName);
	const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

	const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
	const file = folder.createFile(blob);
	file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

	const url = "https://lh3.googleusercontent.com/d/" + file.getId();
	Logger.log("[uploadImageToDrive] アップロード完了: " + url);
	return url;
}

// アップロード済みURLをセルに挿入
// mode='replace'のとき上書き（サムネイル用）、mode='append'のときカンマ追記（詳細画像用）
function insertImageUrls(row, imageUrlCol, newUrls, mode) {
	const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("商品一覧");
	const cell = sheet.getRange(row, imageUrlCol);
	let combined;
	if (mode === "replace") {
		combined = newUrls[0] || "";
	} else {
		const currentValue = String(cell.getValue()).trim();
		combined = currentValue ? currentValue + "," + newUrls.join(",") : newUrls.join(",");
	}
	cell.setValue(combined);
	Logger.log("[insertImageUrls] 行" + row + "に挿入(" + mode + "): " + combined);
}
