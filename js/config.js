// ============================================================
// 設定・定数
// ここを変更するだけでAPIエンドポイントやLINEの設定を切り替えられます
// ============================================================

/** GAS（バックエンド）のエンドポイント */
const GAS_URL =
	"https://script.google.com/macros/s/AKfycbzi7X-uyxvxDIQyiwGeaYyyM_ks6aSvpmJs8uj3jcv8RcPf78cANXWH14L7h2SZY7RkZg/exec";

/** LINE Login コールバックURL（Cloudflare Pages のデプロイ先に合わせる） */
const REDIRECT_URI = "https://buppan-site.weathered-hill-1bba.workers.dev/";

/** Cloudflare KV カタログAPI（同一ドメインの Worker route を想定） */
const PUBLIC_CATALOG_URL = "https://buppan-catalog-api.weathered-hill-1bba.workers.dev/catalog";

/**
 * KVカタログ切替フラグ。
 * true にすると PUBLIC_CATALOG_URL を優先し、失敗時は従来の GAS getInitialData に戻る。
 */
// const USE_KV_CATALOG = false;
const USE_KV_CATALOG = true;

/** KVカタログ取得のタイムアウト（ms） */
const CATALOG_FETCH_TIMEOUT_MS = 2500;

/**
 * LINE Login 認証URL を生成する
 * channelId はスプレッドシートの「スクール設定」シートの
 * 「LINEログインチャンネルID」列から取得してください（ハードコード不要）
 *
 * sourceId を渡すと state パラメータに "aslish_sales|{sourceId}" として埋め込む。
 * LINE Login リダイレクト後も state から確実に復元できる（liff.state 解析に依存しない）。
 */
function buildLineAuthUrl(channelId, sourceId) {
	const state = "aslish_sales" + (sourceId ? "|" + sourceId : "");
	return (
		"https://access.line.me/oauth2/v2.1/authorize" +
		"?response_type=code" +
		"&client_id=" +
		channelId +
		"&redirect_uri=" +
		encodeURIComponent(REDIRECT_URI) +
		"&state=" +
		encodeURIComponent(state) +
		"&scope=profile" +
		"&bot_prompt=normal"
	);
}
