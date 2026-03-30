// ============================================================
// GAS API ヘルパー
// バックエンド（Google Apps Script）との通信を担う
// ============================================================

import { GAS_URL } from './config'
import type { OrderPayload, OrderResponse, CustomerInfoResponse } from './types'

/** GAS への GET リクエスト（データ取得系） */
async function gasGet<T>(action: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ action, ...params }).toString()
  const res = await fetch(`${GAS_URL}?${qs}`)
  return res.json() as Promise<T>
}

/** GAS への POST リクエスト（注文・認証系） */
async function gasPost<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify({ action, ...data }),
  })
  return res.json() as Promise<T>
}

// ---- 各APIを型付きでラップ ----

/** スクール一覧を取得 */
export const fetchSchoolList = (): Promise<string[]> =>
  gasGet<string[]>('getSchoolList')

/** 商品＋在庫データを取得 */
export const fetchProducts = () =>
  gasGet<ReturnType<typeof import('./types')['Product'][]>>('getProductAndInventoryData')

/** LINE UserID で顧客情報を取得 */
export const fetchCustomerByLineId = (lineUserId: string): Promise<CustomerInfoResponse> =>
  gasGet('getCustomerInfoByLineId', { lineUserId })

/** LINE OAuth コードをユーザーIDに交換 */
export const exchangeLineCode = (code: string): Promise<{ userId: string }> =>
  gasPost('exchangeLineCode', { code })

/** 注文を送信 */
export const postOrder = (payload: OrderPayload): Promise<OrderResponse> =>
  gasPost('submitOrder', { payload })
