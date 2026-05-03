// ============================================================
// 設定・定数
// ここを変更するだけでAPIエンドポイントやLINEの設定を切り替えられます
// ============================================================

/** GAS（バックエンド）のエンドポイント */
const GAS_URL =
	"https://script.google.com/macros/s/AKfycbzi7X-uyxvxDIQyiwGeaYyyM_ks6aSvpmJs8uj3jcv8RcPf78cANXWH14L7h2SZY7RkZg/exec";

/** LINE Login コールバックURL（Netlifyのデプロイ先に合わせる） */
const REDIRECT_URI = "https://buppan-site.weathered-hill-1bba.workers.dev/";

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
