// ============================================================
// ユーティリティ関数
// ============================================================

import type { Product } from './types'

/**
 * 価格パース
 * ¥記号・カンマ・空文字などが混入していても安全に数値化する
 * 例: "¥4,500" → 4500 / "" → 0 / 3630 → 3630
 */
export function parsePrice(value: number | string | undefined | null): number {
  if (typeof value === 'number') return value
  const str = String(value ?? '').replace(/[^\d.]/g, '')
  const num = parseFloat(str)
  return isNaN(num) ? 0 : num
}

/**
 * 価格表示HTML生成
 *
 * 【会員価格の表示条件】
 *   1. LINE連携済み（isLineMember = true）
 *   2. スプレッドシートに「通常価格」が設定されている
 *   3. 通常価格 > 価格（実際に値引きされている）
 *   4. 「会員価格(割合%)」列に数値が入っている
 *
 * 上記をすべて満たす場合：
 *   - 通常価格を打ち消し線（グレー）で表示
 *   - 会員価格を LINE グリーンで表示
 *   - 「会員価格」タグを付与
 *
 * それ以外はシンプルに価格のみ表示（非会員への割引情報は見せない）
 */
export function buildPriceHTML(product: Product, isLineMember: boolean): string {
  const price       = parsePrice(product['価格'])
  const normalPrice = parsePrice(product['通常価格'])
  const memberRate  = parsePrice(product['会員価格(割合%)'])

  const showMemberPrice =
    isLineMember &&
    normalPrice > 0 &&
    normalPrice > price &&
    memberRate > 0

  if (!showMemberPrice) {
    return `¥${price.toLocaleString()}`
  }

  return `
    <div class="price-display">
      <span class="price-original">¥${normalPrice.toLocaleString()}</span>
      <span class="price-member">¥${price.toLocaleString()}</span>
      <div class="discount-tags">
        <span class="discount-tag tag-member">会員価格</span>
      </div>
    </div>`
}

/**
 * Google Drive URL → <img> で直接表示できる URL に変換
 * drive.google.com/file/d/{ID} や uc?id={ID} 形式に対応
 */
export function normalizeDriveUrl(url: string): string {
  if (!url) return ''
  url = url.trim()
  const fileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/)
  if (fileMatch) return `https://lh3.googleusercontent.com/d/${fileMatch[1]}`
  const ucMatch = url.match(/drive\.google\.com\/uc\?(?:[^&]+&)*id=([a-zA-Z0-9_-]+)/)
  if (ucMatch) return `https://lh3.googleusercontent.com/d/${ucMatch[1]}`
  return url
}

// ============================================================
// フォームバリデーション
// ============================================================

interface ValidatorRule {
  test: (v: string) => boolean
  msg: string
}

/** 各フィールドのバリデーションルール */
const VALIDATORS: Record<string, ValidatorRule> = {
  'input-email': {
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()),
    msg:  'メールアドレスの形式が正しくありません',
  },
  'input-school': {
    test: (v) => v.trim().length > 0,
    msg:  '参加スクールを選択してください',
  },
  'input-name': {
    test: (v) => v.trim().length > 0,
    msg:  '会員氏名を入力してください',
  },
}

/** 単一フィールドをバリデートして OK/NG を返す（エラーメッセージも更新） */
export function validateField(id: string): boolean {
  const el        = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
  const validator = VALIDATORS[id]
  if (!el || !validator) return true

  const isValid = validator.test(el.value)
  let errEl = document.getElementById(`${id}-error`)
  if (!errEl) {
    errEl = document.createElement('p')
    errEl.id        = `${id}-error`
    errEl.className = 'field-error'
    el.insertAdjacentElement('afterend', errEl)
  }
  if (isValid) {
    el.classList.remove('invalid')
    el.classList.add('valid')
    errEl.textContent = ''
  } else {
    el.classList.remove('valid')
    el.classList.add('invalid')
    errEl.textContent = validator.msg
  }
  return isValid
}

/** 全フィールドをバリデートして、全て OK なら true を返す */
export function validateAll(): boolean {
  return Object.keys(VALIDATORS)
    .map((id) => validateField(id))
    .every((result) => result)
}

/** バリデーションイベントを全フィールドに登録する */
export function registerValidationEvents(): void {
  Object.keys(VALIDATORS).forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
    if (!el) return
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => validateField(id))
    } else {
      el.addEventListener('blur',  () => validateField(id))
      el.addEventListener('input', () => {
        if (el.classList.contains('invalid')) validateField(id)
      })
    }
  })
}
