// ============================================================
// アプリケーション本体
// ============================================================

import { LINE_AUTH_URL } from './config'
import {
  fetchSchoolList,
  fetchProducts,
  fetchCustomerByLineId,
  exchangeLineCode,
  postOrder,
} from './api'
import {
  parsePrice,
  buildPriceHTML,
  normalizeDriveUrl,
  validateAll,
  validateField,
  registerValidationEvents,
} from './utils'
import type { Product, CartItem, CustomerInfo } from './types'

// ============================================================
// グローバル状態
// ============================================================

let lineUserId             = ''          // LINE連携済みの場合にユーザーIDが入る
let globalProducts: Product[] = []       // スプレッドシートから取得した商品一覧
let cart: CartItem[]          = []       // カートの中身
let currentSelectedProduct: Product | null = null
let customerInfo: CustomerInfo = { email: '', school: '', memberName: '' }
let currentCategory = 'すべて'
let isProductLoaded = false              // 商品データ取得完了フラグ

// ============================================================
// 初期化
// ============================================================

window.onload = async () => {
  // LocalStorage からお客様情報を復元
  const savedCustomer = localStorage.getItem('aslish_customer')
  if (savedCustomer) {
    try {
      const info: CustomerInfo = JSON.parse(savedCustomer)
      customerInfo = info
      getEl<HTMLInputElement>('input-email').value = info.email      ?? ''
      getEl<HTMLInputElement>('input-name').value  = info.memberName ?? ''
    } catch { /* 無視 */ }
  }

  // LocalStorage からカートを復元
  const savedCart = localStorage.getItem('aslish_cart')
  if (savedCart) {
    try { cart = JSON.parse(savedCart) } catch { /* 無視 */ }
  }

  // LINE Login コールバック処理
  const params   = new URLSearchParams(window.location.search)
  const lineCode = params.get('code')
  const isLineApp = /Line\//.test(navigator.userAgent)

  if (lineCode) {
    try {
      const data = await exchangeLineCode(lineCode)
      lineUserId = data.userId ?? ''
    } catch (e) {
      console.error('LINE code exchange failed:', e)
    }
    history.replaceState({}, '', window.location.pathname)
  }

  // LINE連携バナーの表示
  if (lineUserId) {
    getEl('line-status').style.display = 'block'
    fetchCustomerByLineId(lineUserId)
      .then(prefillCustomerInfo)
      .catch(() => {})
  } else if (isLineApp) {
    window.location.href = LINE_AUTH_URL
    return
  }

  // スクール一覧を取得してログイン画面を表示
  fetchSchoolList()
    .then((schools) => {
      getEl('loading').style.display       = 'none'
      getEl('login-view').style.display    = 'block'
      initSchoolSelect(schools)

      // バックグラウンドで商品データを取得
      fetchProducts()
        .then((products) => {
          globalProducts  = products as Product[]
          isProductLoaded = true
          if (getEl('product-list-view').style.display === 'block') initData()
        })
        .catch((err) => console.error('商品取得エラー:', err))
    })
    .catch(() => {
      getEl('loading').innerText = 'エラー: スクール情報の取得に失敗しました'
    })

  registerValidationEvents()
}

// ============================================================
// ヘルパー
// ============================================================

/** getElementById のラッパー（型付き） */
function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null
  if (!el) throw new Error(`Element #${id} not found`)
  return el
}

// ============================================================
// スクール選択肢の初期化
// ============================================================

function initSchoolSelect(schools: string[]): void {
  const select = getEl<HTMLSelectElement>('input-school')
  if (!schools || schools.length === 0) {
    select.innerHTML = '<option value="">スクール一覧の取得に失敗しました</option>'
    return
  }
  select.innerHTML = '<option value="">スクールを選択してください</option>'
  schools.forEach((school) => {
    const option = document.createElement('option')
    option.value       = school
    option.textContent = school
    if (customerInfo.school === school) option.selected = true
    select.appendChild(option)
  })
  ;['input-email', 'input-name', 'input-school'].forEach((id) => {
    if ((document.getElementById(id) as HTMLInputElement)?.value) validateField(id)
  })
}

// ============================================================
// LINE から取得した顧客情報をフォームに自動入力
// ============================================================

function prefillCustomerInfo(info: CustomerInfo | null): void {
  if (!info) return
  if (info.email)      getEl<HTMLInputElement>('input-email').value = info.email
  if (info.memberName) getEl<HTMLInputElement>('input-name').value  = info.memberName
  if (info.school) {
    const trySet = (attempt: number) => {
      const select = getEl<HTMLSelectElement>('input-school')
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === info.school) { select.selectedIndex = i; return }
      }
      if (attempt < 10) setTimeout(() => trySet(attempt + 1), 200)
    }
    trySet(0)
  }
  ;['input-email', 'input-name'].forEach((id) => {
    if ((document.getElementById(id) as HTMLInputElement)?.value) validateField(id)
  })
}

// ============================================================
// 商品データ初期化
// ============================================================

function initData(): void {
  if (!globalProducts || globalProducts.length === 0) {
    getEl('app').innerHTML =
      '<p style="grid-column: 1 / -1; text-align:center;">現在表示できる商品がありません。</p>'
    getEl('category-tabs').innerHTML = ''
    return
  }
  renderCategoryTabs()
  renderProductGrid('すべて')
}

// ============================================================
// カテゴリタブの描画
// ============================================================

function renderCategoryTabs(): void {
  const tabContainer = getEl('category-tabs')
  tabContainer.innerHTML = ''
  const categories = ['すべて']
  globalProducts.forEach((p) => {
    if (p['カテゴリ'] && !categories.includes(p['カテゴリ'])) categories.push(p['カテゴリ'])
  })
  categories.forEach((cat) => {
    const tab = document.createElement('div')
    tab.className = `tab-item ${cat === currentCategory ? 'active' : ''}`
    tab.innerText = cat
    tab.onclick   = () => {
      currentCategory = cat
      renderCategoryTabs()
      renderProductGrid(cat)
    }
    tabContainer.appendChild(tab)
  })
}

// ============================================================
// 商品グリッドの描画
// ============================================================

function renderProductGrid(category: string): void {
  const app = getEl('app')
  app.innerHTML = ''

  const filtered =
    category === 'すべて'
      ? globalProducts
      : globalProducts.filter((p) => p['カテゴリ'] === category)

  if (filtered.length === 0) {
    app.innerHTML =
      '<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color: #666;">このカテゴリの商品はありません。</p>'
    return
  }

  filtered.forEach((p) => {
    const totalStock = (p.stockList ?? []).reduce((s, item) => s + (Number(item['在庫数']) || 0), 0)
    const isOutOfStock = totalStock <= 0

    const imgSrc  = normalizeDriveUrl(p['サムネイル画像'] ? String(p['サムネイル画像']) : '')
    const imgHtml = imgSrc
      ? `<img src="${imgSrc}" class="product-img" alt="${p['商品名']}" onerror="this.style.display='none'">`
      : `<div class="product-img" style="display:flex;align-items:center;justify-content:center;color:#999;font-size:0.8rem;">No Image</div>`

    const card = document.createElement('div')
    card.className = `product-card ${isOutOfStock ? 'out-of-stock' : ''}`
    card.onclick   = () => openModal(p['商品ID'])
    card.innerHTML = `
      <div>
        ${imgHtml}
        <div class="product-title">${p['商品名']}</div>
      </div>
      <div class="product-price">${isOutOfStock ? '在庫切れ' : buildPriceHTML(p, !!lineUserId)}</div>
    `
    app.appendChild(card)
  })
}

// ============================================================
// スケルトンローディング
// ============================================================

function renderSkeleton(): void {
  getEl('category-tabs').innerHTML = `
    <div class="skeleton-tabs">
      <div class="skeleton-tab"></div>
      <div class="skeleton-tab"></div>
      <div class="skeleton-tab"></div>
    </div>`
  const app = getEl('app')
  app.innerHTML = ''
  for (let i = 0; i < 6; i++) {
    app.innerHTML += `
      <div class="skeleton-card">
        <div class="skeleton-img"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text price"></div>
      </div>`
  }
}

// ============================================================
// 画面遷移
// ============================================================

function hideAllViews(): void {
  ;['login-view', 'product-list-view', 'cart-view', 'complete-view', 'floating-bar'].forEach(
    (id) => { getEl(id).style.display = 'none' }
  )
}

export function startShopping(): void {
  if (!validateAll()) return
  customerInfo = {
    email:      getEl<HTMLInputElement>('input-email').value.trim(),
    school:     getEl<HTMLSelectElement>('input-school').value.trim(),
    memberName: getEl<HTMLInputElement>('input-name').value.trim(),
  }
  localStorage.setItem('aslish_customer', JSON.stringify(customerInfo))
  hideAllViews()
  getEl('product-list-view').style.display = 'block'
  window.scrollTo(0, 0)
  if (isProductLoaded) initData()
  else renderSkeleton()
  updateCartUI()
}

export function editUserInfo(): void {
  hideAllViews()
  getEl('login-view').style.display = 'block'
  window.scrollTo(0, 0)
}

export function goToCart(): void {
  hideAllViews()
  getEl('cart-view').style.display = 'block'
  renderEditableCart()
  getEl('cart-customer-info').innerHTML = `
    <div><span>氏名:</span> ${customerInfo.memberName}</div>
    <div><span>スクール:</span> ${customerInfo.school}</div>
    <div><span>メール:</span> ${customerInfo.email}</div>
  `
  window.scrollTo(0, 0)
}

export function backToShopping(): void {
  hideAllViews()
  getEl('product-list-view').style.display = 'block'
  updateCartUI()
  window.scrollTo(0, 0)
}

export function backToTop(): void {
  cart = []
  updateCartUI()
  hideAllViews()
  const saved = localStorage.getItem('aslish_customer')
  if (saved) {
    try {
      const info: CustomerInfo = JSON.parse(saved)
      customerInfo = info
      getEl<HTMLInputElement>('input-email').value = info.email      ?? ''
      getEl<HTMLInputElement>('input-name').value  = info.memberName ?? ''
      const select = getEl<HTMLSelectElement>('input-school')
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === info.school) { select.selectedIndex = i; break }
      }
    } catch { /* 無視 */ }
  } else {
    customerInfo = { email: '', school: '', memberName: '' }
    ;['input-email', 'input-school', 'input-name'].forEach((id) => {
      const el = document.getElementById(id) as HTMLInputElement | null
      if (!el) return
      el.value = ''
      el.classList.remove('valid', 'invalid')
      const errEl = document.getElementById(`${id}-error`)
      if (errEl) errEl.textContent = ''
    })
  }
  ;['input-email', 'input-school', 'input-name'].forEach((id) => {
    if ((document.getElementById(id) as HTMLInputElement)?.value) validateField(id)
  })
  getEl('login-view').style.display = 'block'
  window.scrollTo(0, 0)
}

// ============================================================
// 商品詳細モーダル
// ============================================================

export function openModal(productId: string): void {
  const p = globalProducts.find((prod) => String(prod['商品ID']) === String(productId))
  if (!p) return
  currentSelectedProduct = p

  // 画像ギャラリー
  const gallery = getEl('modal-images')
  gallery.innerHTML = ''
  const imgUrls = (p['詳細画像'] ? String(p['詳細画像']) : '')
    .split(',')
    .map((u) => normalizeDriveUrl(u))
    .filter((u) => u.length > 0)
  if (imgUrls.length === 0) {
    gallery.classList.add('single')
    gallery.innerHTML = '<div class="modal-img-item"><div class="modal-img-placeholder">No Image</div></div>'
  } else {
    gallery.classList.toggle('single', imgUrls.length === 1)
    imgUrls.forEach((url) => {
      const item = document.createElement('div')
      item.className = 'modal-img-item'
      item.innerHTML = `<img src="${url}" alt="${p['商品名']}" onerror="this.parentElement.innerHTML='<div class=\\'modal-img-placeholder\\'>No Image</div>'">`
      gallery.appendChild(item)
    })
  }

  getEl('modal-title').innerText           = p['商品名']
  getEl('modal-price').innerHTML           = buildPriceHTML(p, !!lineUserId)
  getEl<HTMLElement>('modal-desc').innerText = p['商品説明'] ?? ''

  // SKU 選択肢
  const skuSelect = getEl<HTMLSelectElement>('modal-sku')
  skuSelect.innerHTML = ''
  ;(p.stockList ?? []).forEach((stock) => {
    const stockNum = Number(stock['在庫数']) || 0
    const option   = document.createElement('option')
    option.value         = stock['SKU']
    option.dataset.stock = String(stockNum)
    option.text = stockNum > 0
      ? `サイズ: ${stock['サイズ']} / カラー: ${stock['カラー']} (残り ${stockNum})`
      : `サイズ: ${stock['サイズ']} / カラー: ${stock['カラー']} (在庫切れ)`
    if (stockNum <= 0) option.disabled = true
    skuSelect.appendChild(option)
  })

  getEl<HTMLInputElement>('modal-qty').value = '1'
  updateMaxQuantity()
  getEl('product-modal').classList.add('active')
}

export function closeModal(): void {
  getEl('product-modal').classList.remove('active')
  currentSelectedProduct = null
}

export function updateMaxQuantity(): void {
  const skuSelect      = getEl<HTMLSelectElement>('modal-sku')
  const selectedOption = skuSelect.options[skuSelect.selectedIndex]
  const maxStock       = selectedOption ? Number(selectedOption.dataset.stock) : 0
  const qtyInput       = getEl<HTMLInputElement>('modal-qty')
  const addBtn         = getEl<HTMLButtonElement>('modal-add-btn')
  qtyInput.max = String(maxStock)
  if (maxStock <= 0) {
    addBtn.disabled  = true
    addBtn.innerText = '在庫切れ'
  } else {
    addBtn.disabled  = false
    addBtn.innerText = 'カートに入れる'
    if (Number(qtyInput.value) > maxStock) qtyInput.value = String(maxStock)
  }
}

export function changeModalQty(delta: number): void {
  const qtyInput = getEl<HTMLInputElement>('modal-qty')
  const newQty   = Number(qtyInput.value) + delta
  const maxStock = Number(qtyInput.max)
  if (newQty < 1 || newQty > maxStock) return
  qtyInput.value = String(newQty)
}

// ============================================================
// カート操作
// ============================================================

export function addToCart(): void {
  if (!currentSelectedProduct) return
  const skuSelect      = getEl<HTMLSelectElement>('modal-sku')
  const selectedOption = skuSelect.options[skuSelect.selectedIndex]
  const sku            = skuSelect.value
  const qty            = Number(getEl<HTMLInputElement>('modal-qty').value)
  const maxStock       = Number(selectedOption.dataset.stock)

  if (qty > maxStock) { alert('在庫数を超えてカートに入れることはできません。'); return }

  const existing = cart.find((item) => item.sku === sku)
  if (existing) {
    if (existing.quantity + qty > maxStock) {
      alert(`すでにカートに ${existing.quantity} 個入っています。在庫(${maxStock}個)を超える追加はできません。`)
      return
    }
    existing.quantity += qty
  } else {
    cart.push({
      sku,
      productName: currentSelectedProduct['商品名'],
      variation:   selectedOption.text.split(' (')[0],
      price:       parsePrice(currentSelectedProduct['価格']),
      normalPrice: parsePrice(currentSelectedProduct['通常価格']),
      memberRate:  parsePrice(currentSelectedProduct['会員価格(割合%)']),
      quantity:    qty,
      maxStock,
    })
  }
  updateCartUI()
  closeModal()
}

export function updateCartUI(): void {
  localStorage.setItem('aslish_cart', JSON.stringify(cart))
  const count = cart.reduce((s, item) => s + item.quantity, 0)
  const total = cart.reduce((s, item) => s + item.price * item.quantity, 0)
  const isProductListVisible = getEl('product-list-view').style.display === 'block'
  if (count > 0 && isProductListVisible) {
    getEl('float-count').innerText = String(count)
    getEl('float-total').innerText = total.toLocaleString()
    getEl('floating-bar').style.display = 'block'
  } else {
    getEl('floating-bar').style.display = 'none'
  }
}

function renderEditableCart(): void {
  const container = getEl('editable-cart-container')
  container.innerHTML = ''
  const submitBtn = getEl<HTMLButtonElement>('submit-btn')

  if (cart.length === 0) {
    container.innerHTML = '<p style="color:#666; text-align:center;">カートは空です。</p>'
    submitBtn.disabled  = true
    return
  }

  submitBtn.disabled = false
  let total = 0

  cart.forEach((item, index) => {
    total += item.price * item.quantity

    const showMemberPrice =
      !!lineUserId && item.normalPrice > 0 && item.normalPrice > item.price && item.memberRate > 0

    const cartPriceHTML = showMemberPrice
      ? `<div style="text-align:right;">
           <div class="discount-tags" style="justify-content:flex-end;margin-bottom:2px;">
             <span class="discount-tag tag-member">会員価格</span>
           </div>
           <span class="price-original">¥${(item.normalPrice * item.quantity).toLocaleString()}</span><br>
           <span class="price-member">¥${(item.price * item.quantity).toLocaleString()}</span>
         </div>`
      : `<div style="font-weight:bold;color:var(--primary-color);">¥${(item.price * item.quantity).toLocaleString()}</div>`

    const div = document.createElement('div')
    div.className = 'cart-item'
    div.innerHTML = `
      <div class="cart-item-header">
        <div class="cart-item-details">
          <strong>${item.productName}</strong><br>
          <span style="font-size:0.85rem;color:#666;">${item.variation}</span>
        </div>
        ${cartPriceHTML}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span class="cart-item-remove" onclick="window.removeCartItem(${index})">削除</span>
        <div class="qty-control">
          <button type="button" onclick="window.changeQty(${index}, -1)">-</button>
          <input type="number" readonly value="${item.quantity}">
          <button type="button" onclick="window.changeQty(${index}, 1)">+</button>
        </div>
      </div>`
    container.appendChild(div)
  })

  const totalDiv = document.createElement('div')
  totalDiv.className = 'total-amount'
  totalDiv.innerHTML = `合計: ¥<span>${total.toLocaleString()}</span>`
  container.appendChild(totalDiv)
}

export function changeQty(index: number, delta: number): void {
  const item   = cart[index]
  const newQty = item.quantity + delta
  if (newQty <= 0) {
    if (confirm('商品をカートから削除しますか？')) removeCartItem(index)
  } else if (newQty > item.maxStock) {
    alert(`在庫数（残り${item.maxStock}個）を超えて追加することはできません。`)
  } else {
    item.quantity = newQty
    renderEditableCart()
  }
}

export function removeCartItem(index: number): void {
  cart.splice(index, 1)
  renderEditableCart()
  if (cart.length === 0) {
    setTimeout(() => { alert('カートが空になったため、商品一覧へ戻ります。'); backToShopping() }, 100)
  }
}

// ============================================================
// 注文処理
// ============================================================

export function submitOrder(): void {
  getEl('custom-confirm').classList.add('active')
}

export function closeConfirm(): void {
  getEl('custom-confirm').classList.remove('active')
}

export async function executeSubmitOrder(): Promise<void> {
  closeConfirm()
  const btn     = getEl<HTMLButtonElement>('submit-btn')
  const backBtn = document.getElementById('back-btn') as HTMLButtonElement | null
  btn.disabled   = true
  btn.innerHTML  = '<span class="btn-spinner"></span>処理中...'
  if (backBtn) backBtn.disabled = true

  try {
    const response = await postOrder({ customerInfo, cart, lineUserId })
    if (response.success) {
      cart = []
      localStorage.removeItem('aslish_cart')
      btn.disabled  = false
      btn.innerText = '注文確定'
      if (backBtn) backBtn.disabled = false
      hideAllViews()
      document.body.classList.add('is-cart-view')
      getEl('complete-order-id').innerText       = response.orderId ?? ''
      getEl('complete-view').style.display       = 'block'
      window.scrollTo(0, 0)
    } else {
      alert(response.message)
      btn.disabled  = false
      btn.innerText = '注文確定'
      if (backBtn) backBtn.disabled = false
    }
  } catch {
    alert('通信エラーが発生しました。もう一度お試しください。')
    btn.disabled  = false
    btn.innerText = '注文確定'
    if (backBtn) backBtn.disabled = false
  }
}

// ============================================================
// HTML の onclick 属性から呼び出せるようにグローバルに登録
// （Vite はモジュールスコープのため window に明示的に追加する必要がある）
// ============================================================

declare global {
  interface Window {
    startShopping:      typeof startShopping
    editUserInfo:       typeof editUserInfo
    goToCart:           typeof goToCart
    backToShopping:     typeof backToShopping
    backToTop:          typeof backToTop
    openModal:          typeof openModal
    closeModal:         typeof closeModal
    updateMaxQuantity:  typeof updateMaxQuantity
    changeModalQty:     typeof changeModalQty
    addToCart:          typeof addToCart
    changeQty:          typeof changeQty
    removeCartItem:     typeof removeCartItem
    submitOrder:        typeof submitOrder
    closeConfirm:       typeof closeConfirm
    executeSubmitOrder: typeof executeSubmitOrder
  }
}

Object.assign(window, {
  startShopping,
  editUserInfo,
  goToCart,
  backToShopping,
  backToTop,
  openModal,
  closeModal,
  updateMaxQuantity,
  changeModalQty,
  addToCart,
  changeQty,
  removeCartItem,
  submitOrder,
  closeConfirm,
  executeSubmitOrder,
})
