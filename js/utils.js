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
 * 価格表示HTML生成
 *
 * 【タイムセール価格の表示条件】
 *   1. スプレッドシートに「タイムセール価格(円)」が設定されている
 *   2. タイムセール価格 < 通常価格（実際に値引きされている）
 *   上記をすべて満たす場合のみ：
 *   - 通常価格を打ち消し線（グレー）で表示
 *   - タイムセール価格を赤で表示
 *   - 「タイムセール」タグを付与
 *
 * それ以外はシンプルに通常価格のみ表示
 *
 * ※ 会員割引はカート合計に対して「会員特典情報」シートの割引率で一括適用する
 */
function buildPriceHTML(product) {
	const normalPrice = parsePrice(product["通常価格(円)"]);
	const timesalePrice = parsePrice(product["タイムセール価格(円)"]);

	// タイムセール価格が存在し、通常価格より安い場合のみ適用
	const hasTimesale = timesalePrice > 0 && timesalePrice < normalPrice;
	const displayPrice = hasTimesale ? timesalePrice : normalPrice;

	// タイムセールの場合、通常価格に打ち消し線を入れて表示
	if (hasTimesale) {
		return `<div class="price-display">
      <span class="price-original">¥${normalPrice.toLocaleString()}</span>
      <span class="price-timesale">¥${displayPrice.toLocaleString()}</span>
      <div class="discount-tags">
        <span class="discount-tag tag-timesale">会員割引</span>
      </div>
    </div>`;
	} else {
		// それ以外は価格のみ表示
		return `¥${displayPrice.toLocaleString()}`;
	}
}

/**
 * Google Drive URL → <img> で直接表示できる URL に変換
 * drive.google.com/file/d/{ID} や uc?id={ID} 形式に対応
 */
function normalizeDriveUrl(url) {
	if (!url) return "";
	url = url.trim();
	const fileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
	if (fileMatch) return "https://lh3.googleusercontent.com/d/" + fileMatch[1];
	const ucMatch = url.match(/drive\.google\.com\/uc\?(?:[^&]+&)*id=([a-zA-Z0-9_-]+)/);
	if (ucMatch) return "https://lh3.googleusercontent.com/d/" + ucMatch[1];
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
