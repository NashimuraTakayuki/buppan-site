// ============================================================
// 型定義
// データ構造をここで一元管理する
// ============================================================

/** スプレッドシート「商品在庫」シートの1行に対応 */
export interface StockItem {
  SKU: string
  商品ID: string
  サイズ: string
  カラー: string
  在庫数: number | string
}

/** スプレッドシート「商品一覧」シートの1行に対応 */
export interface Product {
  商品ID: string
  カテゴリ: string
  商品名: string
  サイズ: string
  カラー: string
  /** 実際の販売価格（LINE会員向け割引後） */
  価格: number | string
  /** 定価。設定されていれば打ち消し線で表示される */
  通常価格: number | string
  /** 会員割引率（%）。例: 20 → 20%引き */
  '会員価格(割合%)': number | string
  商品説明: string
  サイト掲載: string
  サムネイル画像: string
  詳細画像: string
  /** getProductAndInventoryData() でバックエンドが付与する在庫リスト */
  stockList: StockItem[]
}

/** カートに入れる商品1件 */
export interface CartItem {
  sku: string
  productName: string
  variation: string
  /** 実販売価格（注文・合計計算に使用） */
  price: number
  /** 定価（カート画面での打ち消し線表示用） */
  normalPrice: number
  /** 会員割引率（打ち消し線表示の条件判定に使用） */
  memberRate: number
  quantity: number
  maxStock: number
}

/** お客様情報（フォーム入力値） */
export interface CustomerInfo {
  email: string
  school: string
  memberName: string
}

/** GAS の submitOrder に渡す注文データ */
export interface OrderPayload {
  customerInfo: CustomerInfo
  cart: CartItem[]
  lineUserId: string
}

/** GAS の submitOrder レスポンス */
export interface OrderResponse {
  success: boolean
  message: string
  orderId?: string
}

/** GAS の getCustomerInfoByLineId レスポンス */
export interface CustomerInfoResponse {
  email: string
  school: string
  memberName: string
} | null
