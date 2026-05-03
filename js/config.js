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
 */
function buildLineAuthUrl(channelId) {
	return (
		"https://access.line.me/oauth2/v2.1/authorize" +
		"?response_type=code" +
		"&client_id=" +
		channelId +
		"&redirect_uri=" +
		encodeURIComponent(REDIRECT_URI) +
		"&state=aslish_sales" +
		"&scope=profile" +
		"&bot_prompt=normal"
	);
}
