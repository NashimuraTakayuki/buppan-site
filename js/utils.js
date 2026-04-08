// ============================================================
// ユーティリティ関数
// ============================================================

/**
 * 価格パース
 * ¥記号・カンマ・空文字などが混入していても安全に数値化する
 * 例: "¥4,500" → 4500 / "" → 0 / 3630 → 3630
 */
function parsePrice(value) {
	if (typeof value === "number") return value;
	const str = String(value).replace(/[^\d.]/g, "");
	const num = parseFloat(str);
	return isNaN(num) ? 0 : num;
}

/**
 * 価格表示HTML生成 (画像デザイン対応版)
 *
 * @param {Object} product 商品データ
 * @param {number} memberRate 会員割引率 (0-100)
 * @param {boolean} isLinked LINE連携済みかどうか
 */
function buildPriceHTML(product, memberRate = 0, isLinked = false) {
	const normalPrice = parsePrice(product["通常価格(円)"]);
	const timesalePrice = parsePrice(product["タイムセール価格(円)"]);

	// タイムセール価格が有効か
	const hasTimesale = timesalePrice > 0 && timesalePrice < normalPrice;

	// 基準価格（会員割引のベース。タイムセール中ならその価格、そうでなければ通常価格）
	const basePrice = hasTimesale ? timesalePrice : normalPrice;

	// 会員価格の計算（LINE連携されている場合のみ有効）
	// ルール: 会員価格 = 基準価格 * (1 - 割引率 / 100)
	const hasMemberDiscount = isLinked && memberRate > 0;
	const memberPrice = hasMemberDiscount ? Math.floor(basePrice * (1 - memberRate / 100)) : basePrice;

	let html = '<div class="price-display">';

	if (isLinked) {
		// --- LINE連携済みユーザー向け表示 ---
		if (hasTimesale) {
			// 【画像2相当】タイムセール中
			html += `
        <div class="discount-badges" style="margin-bottom: 2px;">
          <span class="badge badge-timesale">タイムセール</span>
        </div>
        <div class="price-row">
          <span class="price-original price-strike">¥${normalPrice.toLocaleString()}</span>
          <span class="price-timesale-strike price-strike">¥${timesalePrice.toLocaleString()}</span>
        </div>
        <div class="price-member-final">
          ¥${memberPrice.toLocaleString()}
        </div>
      `;
		} else if (hasMemberDiscount) {
			// 【画像3相当】通常価格(打借し) + 会員価格(緑太字/横並び)
			html += `
        <div class="price-row">
          <span class="price-original price-strike">¥${normalPrice.toLocaleString()}</span>
          <span class="price-member-text">¥${memberPrice.toLocaleString()}</span>
        </div>
      `;
		} else {
			// 連携済みだが会員割引率が0の場合
			html += `<div class="price-base">¥${normalPrice.toLocaleString()}</div>`;
		}
	} else {
		// --- 未連携ユーザー向け表示 ---
		if (hasTimesale) {
			// 【画像1相当】通常価格(打越し) + タイムセール価格(赤太字) を横並び
			html += `
        <div class="discount-badges" style="margin-bottom: 2px;">
          <span class="badge badge-timesale">タイムセール</span>
        </div>
        <div class="price-row">
          <span class="price-original price-strike">¥${normalPrice.toLocaleString()}</span>
          <span class="price-timesale-text">¥${timesalePrice.toLocaleString()}</span>
        </div>
      `;
		} else {
			// 割引なし
			html += `<div class="price-base">¥${normalPrice.toLocaleString()}</div>`;
		}
	}

	html += '</div>';
	return html;
}

/**
 * Google Drive URL → <img> で直接表示できる URL に変換
 * drive.google.com/file/d/{ID} や uc?id={ID} 形式に対応
 */
function normalizeDriveUrl(url) {
	if (!url) return "";
	url = url.trim();

	// すでに https://lh3.googleusercontent.com/d/ 形式ならそのまま
	if (url.startsWith("https://lh3.googleusercontent.com/d/")) return url;

	let fileId = "";

	// 1. /file/d/{ID}/ 形式
	const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
	if (fileMatch) {
		fileId = fileMatch[1];
	} else {
		// 2. ?id={ID} または &id={ID} 形式（uc?id=, open?id= など）
		const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
		if (idMatch) {
			fileId = idMatch[1];
		}
	}

	if (fileId) {
		return "https://lh3.googleusercontent.com/d/" + fileId;
	}

	// 形式に合致しない場合はそのまま返す
	return url;
}

// ============================================================
// GAS API ヘルパー
// ============================================================

/** GAS への GET リクエスト（データ取得系） */
async function gasGet(action, params = {}) {
	const qs = new URLSearchParams({ action, ...params }).toString();
	const res = await fetch(`${GAS_URL}?${qs}`);
	return res.json();
}

/**
 * 会員特典情報シートから割引率（%）を取得
 * 「会員特典情報」シートの B1 セルの値を返す
 * 例: { discountRate: 20 } → カート合計から 20% 引き
 */
async function fetchMemberDiscountRate() {
	const data = await gasGet("getMemberDiscountRate");
	return typeof data.discountRate === "number" ? data.discountRate : 0;
}

/** GAS への POST リクエスト（注文・認証系） */
async function gasPost(action, data = {}) {
	const res = await fetch(GAS_URL, {
		method: "POST",
		body: JSON.stringify({ action, ...data }),
	});
	return res.json();
}

// ============================================================
// フォームバリデーション
// ============================================================

/** 各フィールドのバリデーションルール */
const VALIDATORS = {
	"input-email": {
		test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
		msg: "メールアドレスの形式が正しくありません",
	},
	"input-school": {
		test: (v) => v.trim().length > 0,
		msg: "参加スクールを選択してください",
	},
	"input-name": {
		test: (v) => v.trim().length > 0,
		msg: "会員氏名を入力してください",
	},
};

/** 単一フィールドをバリデートして OK/NG を返す（エラーメッセージも更新） */
function validateField(id) {
	const el = document.getElementById(id);
	const validator = VALIDATORS[id];
	if (!el || !validator) return true;
	const isValid = validator.test(el.value);
	let errEl = document.getElementById(id + "-error");
	if (!errEl) {
		errEl = document.createElement("p");
		errEl.id = id + "-error";
		errEl.className = "field-error";
		el.insertAdjacentElement("afterend", errEl);
	}
	if (isValid) {
		el.classList.remove("invalid");
		el.classList.add("valid");
		errEl.textContent = "";
	} else {
		el.classList.remove("valid");
		el.classList.add("invalid");
		errEl.textContent = validator.msg;
	}
	return isValid;
}

/** 全フィールドをバリデートして、全て OK なら true を返す */
function validateAll() {
	return Object.keys(VALIDATORS)
		.map((id) => validateField(id))
		.every((result) => result);
}
