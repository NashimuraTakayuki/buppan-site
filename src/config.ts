// ============================================================
// 設定・定数
// LINE設定や API URL を変更する場合はここだけ編集すればOK
// ============================================================

/** GAS（バックエンド）のエンドポイント */
export const GAS_URL =
  'https://script.google.com/macros/s/AKfycbzi7X-uyxvxDIQyiwGeaYyyM_ks6aSvpmJs8uj3jcv8RcPf78cANXWH14L7h2SZY7RkZg/exec'

/** LINE Login チャネルID */
export const LINE_CHANNEL_ID = '2009555332'

/** LINE Login コールバックURL（Netlifyのデプロイ先に合わせる） */
export const REDIRECT_URI = 'https://venerable-sawine-2fec62.netlify.app/'

/** LINE Login 認証URL（自動生成） */
export const LINE_AUTH_URL =
  'https://access.line.me/oauth2/v2.1/authorize' +
  '?response_type=code' +
  '&client_id=' + LINE_CHANNEL_ID +
  '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) +
  '&state=aslish_sales' +
  '&scope=profile'
