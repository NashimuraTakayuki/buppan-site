// ============================================================
// アプリケーション本体
// ============================================================

// ---- グローバル状態変数 ----
let lineUserId = ""; // LINE連携済みの場合にユーザーIDが入る
let lineSource = ""; // アクセス元の公式LINEを識別するスクールID（URLパラメータ ?source= から取得）
let globalProducts = []; // スプレッドシートから取得した商品一覧
let cart = []; // カートの中身
let currentSelectedProduct = null; // モーダルで選択中の商品
let customerInfo = { email: "", school: "", memberName: "" };
let currentCategory = "すべて";
let isProductLoaded = false; // 商品データ取得完了フラグ
let memberDiscountRate = 0; // 会員特典情報シートから取得した割引率（%）

// ============================================================
// 初期化（ページ読み込み時）
// ============================================================
window.onload = async function () {
	// --- LocalStorage からお客様情報を復元 ---
	const savedCustomer = localStorage.getItem("aslish_customer");
	if (savedCustomer) {
		try {
			const info = JSON.parse(savedCustomer);
			customerInfo = info;
			if (info.email) document.getElementById("input-email").value = info.email;
			if (info.memberName) document.getElementById("input-name").value = info.memberName;
		} catch (e) {}
	}

	// --- LocalStorage からカートを復元 ---
	const savedCart = localStorage.getItem("aslish_cart");
	if (savedCart) {
		try {
			cart = JSON.parse(savedCart);
		} catch (e) {}
	}

	// --- LINE Login コールバック処理 ---
	const params = new URLSearchParams(window.location.search);
	const lineCode = params.get("code");
	const isLineApp = /Line\//.test(navigator.userAgent);

	// --- アクセス元スクールIDの取得（LIFFリンクに ?source=<スクールID> を付与して使用）---
	// LIFFを経由するとクエリパラメータが liff.state に包まれるため両方チェックする
	lineSource = params.get("source") || "";
	const liffState = params.get("liff.state") || "";
	let liffStateDecoded = "";
	if (!lineSource && liffState) {
		try {
			liffStateDecoded = decodeURIComponent(liffState);
			const liffParams = new URLSearchParams(liffStateDecoded.replace(/^\?/, ""));
			lineSource = liffParams.get("source") || "";
		} catch (e) {
			liffStateDecoded = "(decode error: " + e.message + ")";
		}
	}
	// LINE Login リダイレクト後も source を引き継ぐため localStorage に退避・復元する
	let sourceFrom = "";
	const stateParam = params.get("state") || "";
	if (lineSource) {
		// URLから source が取得できた場合 → localStorage に保存して使用
		sourceFrom = liffState ? "liff.state" : "URLパラメータ";
		localStorage.setItem("aslish_line_source", lineSource);
	} else if (lineCode) {
		// LINE Login リダイレクト後（URL に code がある）
		// → まず state パラメータから復元（最も確実）、なければ localStorage にフォールバック
		const stateParts = stateParam.split("|");
		if (stateParts[1]) {
			lineSource = stateParts[1];
			sourceFrom = "stateパラメータ";
		} else {
			lineSource = localStorage.getItem("aslish_line_source") || "";
			sourceFrom = "localStorage(フォールバック)";
		}
		if (lineSource) localStorage.setItem("aslish_line_source", lineSource);
	} else {
		// source も code もない直接アクセス → 未選択状態にし、古い値をクリア
		sourceFrom = "なし(直接アクセス)";
		localStorage.removeItem("aslish_line_source");
		lineSource = "";
	}

	// --- スクール一覧を先に取得（スクール別チャンネルIDの判定に必要）---
	// 返却フォーマット: [{ id, name, lineChannelId }, ...]
	let schoolData = [];
	try {
		schoolData = await gasGet("getSchoolList");
	} catch (e) {
		document.getElementById("loading").innerText = "エラー: スクール情報の取得に失敗しました";
	}

	// URLパラメータが移行前の「スクール名」だった場合、正規の「スクールID」に変換しておく
	if (lineSource) {
		const match = schoolData.find((s) => s.id === lineSource || s.name === lineSource);
		if (match && match.id && lineSource !== match.id) {
			lineSource = match.id;
			localStorage.setItem("aslish_line_source", lineSource);
		}
	}

	if (lineCode) {
		try {
			// スクールIDを渡してGAS側で正しいチャンネルのシークレットを使って交換
			const data = await gasPost("exchangeLineCode", { code: lineCode, schoolId: lineSource });
			if (data.error) {
				alert("LINE Login Error: " + data.error);
			} else {
				lineUserId = data.userId || "";
			}
		} catch (e) {
			console.error("LINE code exchange failed:", e);
			alert("LINE code exchange failed: " + e.message);
		}
		// URL から code を除去
		history.replaceState({}, "", window.location.pathname);
	}

	// --- LINE連携バナーの表示 ---
	const statusEl = document.getElementById("line-status");
	if (lineUserId) {
		statusEl.style.display = "block";
		// LINE UserID で顧客情報を取得してフォームに自動入力
		gasGet("getCustomerInfoByLineId", { lineUserId })
			.then(prefillCustomerInfo)
			.catch(() => {});
	} else if (isLineApp && !lineCode) {
		// LINE アプリ内でアクセスしていて未連携なら、スクール別チャンネルIDで認証へリダイレクト
		// 無限ループを防ぐため、code がある（認証から戻ってきた）場合はリダイレクトしない
		const schoolEntry = (schoolData || []).find(
			(s) => s && (s.id === lineSource || s.name === lineSource),
		);
		// sourceが特定のスクールに対応している場合のみLINE Loginへリダイレクト
		// sourceなし・スクール不明の場合はフォールバックせず、ユーザーに手動でスクールを選ばせる
		const channelId = schoolEntry && schoolEntry.lineChannelId;
		if (channelId) {
			// スクールが特定できた場合のみLINE Loginへリダイレクト
			// lineSource を state パラメータに埋め込んでリダイレクト後も確実に復元できるようにする
			window.location.href = buildLineAuthUrl(channelId, lineSource);
			return;
		}
		// スクールが特定できない場合はフォールバックせず、未選択状態のまま通常表示に進む
		console.warn("[LINE Login] sourceからスクールを特定できないため、自動ログインをスキップします。");
	}

	// --- ログイン画面を表示（スクール一覧は取得済み）---
	document.getElementById("loading").style.display = "none";
	document.getElementById("login-view").style.display = "block";
	initSchoolSelect(schoolData);

	// バックグラウンドで商品データ・割引率を並行取得
	gasGet("getProductAndInventoryData")
		.then((products) => {
			globalProducts = products;
			isProductLoaded = true;
			if (document.getElementById("product-list-view").style.display === "block") {
				initData();
				updateCartUI();
			}
		})
		.catch((err) => console.error("商品取得エラー:", err));

	fetchMemberDiscountRate()
		.then((rate) => {
			memberDiscountRate = rate;
			if (lineUserId && statusEl) {
				statusEl.textContent = "✓ LINEアカウント連携済み (会員特典: " + rate + "%OFF)";
			}
		})
		.catch(() => {
			memberDiscountRate = 0;
		});

	// --- バリデーションイベントの一括登録 ---
	Object.keys(VALIDATORS).forEach((id) => {
		const el = document.getElementById(id);
		if (!el) return;
		if (el.tagName === "SELECT") {
			el.addEventListener("change", () => validateField(id));
		} else {
			el.addEventListener("blur", () => validateField(id));
			el.addEventListener("input", () => {
				if (el.classList.contains("invalid")) validateField(id);
			});
		}
	});
};

// ============================================================
// スクール選択肢の初期化
// schools: [{ id, name, lineChannelId }, ...]
// ============================================================
function initSchoolSelect(schools) {
	const select = document.getElementById("input-school");
	if (!schools || schools.length === 0) {
		select.innerHTML = '<option value="">スクール一覧の取得に失敗しました</option>';
		return;
	}
	// 旧形式（文字列のみ／name のみ）にも一応対応しておく
	const normalized = schools.map((s) => {
		if (typeof s === "string") return { id: "", name: s, lineChannelId: "" };
		return {
			id: String(s.id || "").trim(),
			name: String(s.name || "").trim(),
			lineChannelId: String(s.lineChannelId || "").trim(),
		};
	});

	select.innerHTML = '<option value="">スクールを選択してください</option>';

	// lineSource はスクールID（または移行前のスクール名）。一致するスクールを探して、その「名前」を初期選択にする
	const sourceMatch = lineSource
		? normalized.find((s) => s.id === lineSource || s.name === lineSource)
		: null;
	const sourceName = sourceMatch ? sourceMatch.name : "";

	// 名前でマッチした場合、lineSource を正規のID（s00X）で上書き（標準化）
	if (sourceMatch && lineSource !== sourceMatch.id) {
		lineSource = sourceMatch.id;
		localStorage.setItem("aslish_line_source", lineSource);
	}

	// 優先順位: LIFFリンクのsource（=スクールID）から解決した名前 > LocalStorageの school 名 > 未選択
	const initialSchool = sourceName || customerInfo.school;

	normalized.forEach((s) => {
		const option = document.createElement("option");
		option.value = s.name;
		option.textContent = s.name;
		if (initialSchool === s.name) option.selected = true;
		select.appendChild(option);
	});

	if (!customerInfo.school && sourceName) {
		customerInfo.school = sourceName;
	}

	// 不正なlineSource（IDが見つからない）はlocalStorageからクリアして混乱を避ける
	// in-memory も空にしておくことで以降のAPI呼び出し（注文等）にも不正値が混ざらないようにする
	if (lineSource && !sourceMatch) {
		localStorage.removeItem("aslish_line_source");
		lineSource = "";
	}

	// LocalStorage に値があればバリデーション（緑枠）を適用
	["input-email", "input-name", "input-school"].forEach((id) => {
		if (document.getElementById(id).value) validateField(id);
	});
}

// ============================================================
// LINE から取得した顧客情報をフォームに自動入力
// ============================================================
function prefillCustomerInfo(info) {
	if (!info) return;
	if (info.email) document.getElementById("input-email").value = info.email;
	if (info.memberName) document.getElementById("input-name").value = info.memberName;
	// lineSource がある場合はLIFFリンクの source を優先するためスクールの上書きをしない
	if (info.school && !lineSource) {
		const trySet = (attempt) => {
			const select = document.getElementById("input-school");
			for (let i = 0; i < select.options.length; i++) {
				if (select.options[i].value === info.school) {
					select.selectedIndex = i;
					return;
				}
			}
			if (attempt < 10) setTimeout(() => trySet(attempt + 1), 200);
		};
		trySet(0);
	}
	["input-email", "input-name"].forEach((id) => {
		if (document.getElementById(id).value) validateField(id);
	});
}

// ============================================================
// 商品データ初期化（タブ＋グリッド描画）
// ============================================================
function initData() {
	if (!globalProducts || globalProducts.length === 0) {
		document.getElementById("app").innerHTML =
			'<p style="grid-column: 1 / -1; text-align:center;">現在表示できる商品がありません。</p>';
		document.getElementById("category-tabs").innerHTML = "";
		return;
	}
	renderCategoryTabs();
	renderProductGrid("すべて");
}

// ============================================================
// カテゴリタブの描画
// ============================================================
const CATEGORY_ORDER = ["すべて", "低学年", "高学年", "中学生", "大人"];

function renderCategoryTabs() {
	const tabContainer = document.getElementById("category-tabs");
	tabContainer.innerHTML = "";
	const categories = ["すべて"];
	globalProducts.forEach((p) => {
		const catString = p["カテゴリ"];
		if (catString) {
			const cats = String(catString)
				.split(",")
				.map((c) => c.trim())
				.filter((c) => c !== "");
			cats.forEach((cat) => {
				if (!categories.includes(cat)) categories.push(cat);
			});
		}
	});
	// 指定順にソート（CATEGORY_ORDERにないカテゴリーは末尾）
	categories.sort((a, b) => {
		const ai = CATEGORY_ORDER.indexOf(a);
		const bi = CATEGORY_ORDER.indexOf(b);
		if (ai === -1 && bi === -1) return 0;
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});
	categories.forEach((cat) => {
		const tab = document.createElement("div");
		tab.className = `tab-item ${cat === currentCategory ? "active" : ""}`;
		tab.innerText = cat;
		tab.onclick = () => {
			currentCategory = cat;
			renderCategoryTabs();
			renderProductGrid(cat);
		};
		tabContainer.appendChild(tab);
	});
}

// ============================================================
// 商品グリッドの描画
// ============================================================
function renderProductGrid(category) {
	const app = document.getElementById("app");
	app.innerHTML = "";

	const filteredProducts =
		category === "すべて"
			? globalProducts
			: globalProducts.filter((p) => {
					const catString = p["カテゴリ"] || "";
					const cats = String(catString)
						.split(",")
						.map((c) => c.trim());
					return cats.includes(category);
				});

	if (filteredProducts.length === 0) {
		app.innerHTML =
			'<p style="grid-column: 1 / -1; text-align:center; padding: 20px; color: #666;">このカテゴリの商品はありません。</p>';
		return;
	}

	filteredProducts.forEach((p) => {
		let totalStock = 0;
		if (p.stockList) p.stockList.forEach((s) => (totalStock += Number(s["在庫数"]) || 0));
		const isOutOfStock = totalStock <= 0;

		const rawThumbnails = p["サムネイル画像"] ? String(p["サムネイル画像"]) : "";
		const thumbUrls = rawThumbnails
			.split(/[\s,]+/)
			.map(normalizeDriveUrl)
			.filter((u) => u.length > 0);
		const imgSrc = thumbUrls[0] || "";
		const imgHtml = imgSrc
			? `<img src="${imgSrc}" class="product-img" alt="${p["商品名"]}" onerror="this.style.display='none'">`
			: `<div class="product-img" style="display:flex; align-items:center; justify-content:center; color:#999; font-size:0.8rem;">No Image</div>`;

		const card = document.createElement("div");
		card.className = `product-card ${isOutOfStock ? "out-of-stock" : ""}`;
		card.onclick = () => openModal(p["商品ID"]);
		card.innerHTML = `
      <div>
        ${imgHtml}
        <div class="product-title">${p["商品名"]}</div>
      </div>
      <div class="product-price">${isOutOfStock ? "在庫切れ" : buildPriceHTML(p, memberDiscountRate, !!lineUserId)}</div>
    `;
		app.appendChild(card);
	});
}

// ============================================================
// スケルトンローディング表示
// ============================================================
function renderSkeleton() {
	const tabContainer = document.getElementById("category-tabs");
	tabContainer.innerHTML = `
    <div class="skeleton-tabs">
      <div class="skeleton-tab"></div>
      <div class="skeleton-tab"></div>
      <div class="skeleton-tab"></div>
    </div>
  `;
	const app = document.getElementById("app");
	app.innerHTML = "";
	for (let i = 0; i < 6; i++) {
		app.innerHTML += `
      <div class="skeleton-card">
        <div class="skeleton-img"></div>
        <div class="skeleton-text"></div>
        <div class="skeleton-text price"></div>
      </div>
    `;
	}
}

// ============================================================
// 画面遷移
// ============================================================

function hideAllViews() {
	document.getElementById("login-view").style.display = "none";
	document.getElementById("product-list-view").style.display = "none";
	document.getElementById("cart-view").style.display = "none";
	document.getElementById("complete-view").style.display = "none";
	document.getElementById("floating-bar").style.display = "none";
}

/** 情報入力完了 → 商品一覧へ */
function startShopping() {
	if (!validateAll()) return;
	customerInfo = {
		email: document.getElementById("input-email").value.trim(),
		school: document.getElementById("input-school").value.trim(),
		memberName: document.getElementById("input-name").value.trim(),
	};
	localStorage.setItem("aslish_customer", JSON.stringify(customerInfo));
	hideAllViews();
	document.getElementById("product-list-view").style.display = "block";
	window.scrollTo(0, 0);
	if (isProductLoaded) {
		initData();
	} else {
		renderSkeleton();
	}
	updateCartUI();
}

/** お客様情報を修正する */
function editUserInfo() {
	hideAllViews();
	document.getElementById("login-view").style.display = "block";
	window.scrollTo(0, 0);
}

/** カート画面へ */
function goToCart() {
	if (!isProductLoaded) {
		alert("商品データの読み込みが完了するまでお待ちください。");
		return;
	}
	hideAllViews();
	document.getElementById("cart-view").style.display = "block";
	renderEditableCart();
	const infoDiv = document.getElementById("cart-customer-info");
	if (infoDiv) {
		infoDiv.innerHTML = `
      <div><span>氏名:</span> ${customerInfo.memberName || ""}</div>
      <div><span>スクール:</span> ${customerInfo.school || ""}</div>
      <div><span>メール:</span> ${customerInfo.email || ""}</div>
    `;
	}
	window.scrollTo(0, 0);
	// --- 初期表示の更新 ---
	updateCartUI();
}

/** 商品一覧に戻る */
function backToShopping() {
	hideAllViews();
	document.getElementById("product-list-view").style.display = "block";
	updateCartUI();
	window.scrollTo(0, 0);
}

/** トップに戻る（カートをリセットし、入力情報を引き継ぐ） */
function backToTop() {
	cart = [];
	updateCartUI();
	hideAllViews();
	const savedCustomer = localStorage.getItem("aslish_customer");
	if (savedCustomer) {
		try {
			const info = JSON.parse(savedCustomer);
			customerInfo = info;
			if (info.email) document.getElementById("input-email").value = info.email;
			if (info.memberName) document.getElementById("input-name").value = info.memberName;
			if (info.school) {
				const select = document.getElementById("input-school");
				for (let i = 0; i < select.options.length; i++) {
					if (select.options[i].value === info.school) {
						select.selectedIndex = i;
						break;
					}
				}
			}
		} catch (e) {}
	} else {
		customerInfo = { email: "", school: "", memberName: "" };
		["input-email", "input-school", "input-name"].forEach((id) => {
			const el = document.getElementById(id);
			if (!el) return;
			el.value = "";
			el.classList.remove("valid", "invalid");
			const errEl = document.getElementById(id + "-error");
			if (errEl) errEl.textContent = "";
		});
	}
	["input-email", "input-school", "input-name"].forEach((id) => {
		if (document.getElementById(id).value) validateField(id);
	});
	document.getElementById("login-view").style.display = "block";
	window.scrollTo(0, 0);
}

// ============================================================
// 商品詳細モーダル
// ============================================================

const APPAREL_ORDER = [
	"XS",
	"S",
	"M",
	"L",
	"XL",
	"XXL",
	"2XL",
	"3XL",
	"XXXL",
	"4XL",
	"4L",
	"3L",
	"2L",
	"LL",
];

function sortSizes(sizes) {
	const allNumeric = sizes.every((s) => !isNaN(parseFloat(s)) && s.trim() !== "");
	if (allNumeric) {
		return [...sizes].sort((a, b) => parseFloat(a) - parseFloat(b));
	}
	const allApparel = sizes.every((s) => APPAREL_ORDER.includes(s.toUpperCase()));
	if (allApparel) {
		return [...sizes].sort(
			(a, b) => APPAREL_ORDER.indexOf(a.toUpperCase()) - APPAREL_ORDER.indexOf(b.toUpperCase()),
		);
	}
	return [...sizes].sort((a, b) => {
		const aNum = parseFloat(a);
		const bNum = parseFloat(b);
		if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
		const aIdx = APPAREL_ORDER.indexOf(a.toUpperCase());
		const bIdx = APPAREL_ORDER.indexOf(b.toUpperCase());
		if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
		if (aIdx !== -1) return -1;
		if (bIdx !== -1) return 1;
		return a.localeCompare(b, "ja");
	});
}

function makeSizeBtnGroup(container, items, onSelect) {
	container.innerHTML = "";
	items.forEach((item, i) => {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.value = item.value;
		if (item.stock !== undefined) {
			btn.dataset.stock = item.stock;
			btn.dataset.sku = item.sku || "";
		}
		btn.textContent = item.label;
		const outOfStock = item.stock !== undefined && item.stock <= 0;
		btn.disabled = outOfStock;
		btn.className = "size-btn" + (outOfStock ? " disabled" : "");
		btn.addEventListener("click", () => {
			if (btn.disabled) return;
			container.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("selected"));
			btn.classList.add("selected");
			onSelect(btn);
		});
		container.appendChild(btn);
	});
	// 最初の有効なボタンを選択状態にする
	const firstValid = container.querySelector(".size-btn:not(:disabled)");
	if (firstValid) firstValid.classList.add("selected");
	else if (container.firstChild) container.firstChild.classList.add("selected");
}

function openModal(productId) {
	const p = globalProducts.find((prod) => String(prod["商品ID"]) === String(productId));
	if (!p) return;
	currentSelectedProduct = p;
	console.log(p);
	// 画像ギャラリー
	const imageGallery = document.getElementById("modal-images");
	imageGallery.innerHTML = "";

	// サムネイル画像と詳細画像を統合（サムネイルを優先的に1枚目にする）
	const rawThumbnails = p["サムネイル画像"] ? String(p["サムネイル画像"]) : "";
	const rawDetails = p["詳細画像"] ? String(p["詳細画像"]) : "";

	const allUrls = [...rawThumbnails.split(/[\s,]+/), ...rawDetails.split(/[\s,]+/)]
		.map((u) => normalizeDriveUrl(u))
		.filter((u) => u.length > 0);

	// 重複を省きつつ順序を維持
	const imgUrls = [...new Set(allUrls)];

	if (imgUrls.length === 0) {
		imageGallery.classList.add("single");
		imageGallery.innerHTML =
			'<div class="modal-img-item"><div class="modal-img-placeholder">No Image</div></div>';
	} else {
		imageGallery.classList.toggle("single", imgUrls.length === 1);
		imgUrls.forEach((url) => {
			const item = document.createElement("div");
			item.className = "modal-img-item";
			item.innerHTML = `<img src="${url}" alt="${p["商品名"]}" onerror="this.parentElement.innerHTML='<div class=\\'modal-img-placeholder\\'>No Image</div>'">`;
			imageGallery.appendChild(item);
		});
	}

	document.getElementById("modal-title").innerText = p["商品名"];

	document.getElementById("modal-price").innerHTML = buildPriceHTML(
		p,
		memberDiscountRate,
		!!lineUserId,
	);
	document.getElementById("modal-desc").innerText = p["商品説明"] || "";

	// SKU（サイズ/カラー）選択肢の初期化（分割版）
	const rawSizes = [];
	p.stockList.forEach((stock) => {
		const s = String(stock["サイズ"]);
		if (!rawSizes.includes(s)) rawSizes.push(s);
	});
	const sizes = sortSizes(rawSizes);

	const sizeSelect = document.getElementById("modal-size");
	makeSizeBtnGroup(
		sizeSelect,
		sizes.map((s) => ({ value: s, label: s })),
		() => onSizeChange(),
	);

	const hasNoSize =
		sizes.length === 0 ||
		(sizes.length === 1 &&
			(!sizes[0] ||
				sizes[0] === "None" ||
				sizes[0] === "-" ||
				sizes[0] === "なし" ||
				sizes[0].trim() === ""));
	sizeSelect.style.display = hasNoSize ? "none" : "";

	// サイズに合わせてカラーを初期生成し、数量更新
	onSizeChange();

	document.getElementById("modal-qty").value = 1;
	updateMaxQuantity();
	document.getElementById("product-modal").classList.add("active");
	document.body.style.overflow = "hidden";
}

function closeModal() {
	document.getElementById("product-modal").classList.remove("active");
	document.body.style.overflow = "";
	currentSelectedProduct = null;
}

function onSizeChange() {
	if (!currentSelectedProduct) return;
	const sizeSelect = document.getElementById("modal-size");
	const selectedBtn = sizeSelect.querySelector(".size-btn.selected");
	const size = selectedBtn ? selectedBtn.value : "";
	const colorGroup = document.getElementById("modal-color");

	const availableStocks = currentSelectedProduct.stockList.filter(
		(stock) => String(stock["サイズ"]) === size,
	);

	makeSizeBtnGroup(
		colorGroup,
		availableStocks.map((stock) => ({
			value: String(stock["カラー"]),
			label: String(stock["カラー"]),
			stock: Number(stock["在庫数"]) || 0,
			sku: stock["SKU"],
		})),
		() => updateMaxQuantity(),
	);

	const hasNoColor =
		availableStocks.length === 0 ||
		(availableStocks.length === 1 &&
			(!availableStocks[0]["カラー"] ||
				availableStocks[0]["カラー"] === "None" ||
				availableStocks[0]["カラー"] === "-" ||
				availableStocks[0]["カラー"] === "なし" ||
				availableStocks[0]["カラー"].trim() === ""));
	colorGroup.style.display = hasNoColor ? "none" : "";

	const sizeHidden = sizeSelect.style.display === "none" || !sizeSelect.querySelector(".size-btn");
	const colorHidden = hasNoColor;
	const group = document.getElementById("modal-variant-group");
	const variantLabel = document.getElementById("modal-variant-label");

	if (sizeHidden && colorHidden) {
		group.style.display = "none";
	} else {
		group.style.display = "flex";
		if (variantLabel) {
			if (!sizeHidden && !colorHidden) variantLabel.innerText = "サイズ / カラー選択";
			else if (!sizeHidden && colorHidden) variantLabel.innerText = "サイズ選択";
			else if (sizeHidden && !colorHidden) variantLabel.innerText = "カラー選択";
		}
	}

	updateMaxQuantity();
}

function updateMaxQuantity() {
	const colorGroup = document.getElementById("modal-color");
	const selectedColorBtn = colorGroup.querySelector(".size-btn.selected");
	const maxStock = selectedColorBtn ? Number(selectedColorBtn.dataset.stock) : 0;
	const qtyInput = document.getElementById("modal-qty");
	const addBtn = document.getElementById("modal-add-btn");
	const qtyLabel = document.getElementById("modal-qty-label");

	qtyInput.max = maxStock;
	if (maxStock <= 0) {
		addBtn.disabled = true;
		addBtn.innerText = "在庫切れ";
		qtyLabel.innerHTML = `数量 <span style="font-size: 0.85rem; color: var(--danger); font-weight: normal; margin-left: 6px;">(在庫切れ)</span>`;
	} else {
		addBtn.disabled = false;
		addBtn.innerText = "カートに入れる";
		qtyLabel.innerHTML = `数量 <span style="font-size: 0.85rem; color: #666; font-weight: normal; margin-left: 6px;">(残り ${maxStock}個)</span>`;
		if (Number(qtyInput.value) > maxStock) qtyInput.value = maxStock;
	}
}

function changeModalQty(delta) {
	const qtyInput = document.getElementById("modal-qty");
	const newQty = Number(qtyInput.value) + delta;
	const maxStock = Number(qtyInput.max);
	if (newQty < 1 || newQty > maxStock) return;
	qtyInput.value = newQty;
}

// ============================================================
// カート操作
// ============================================================

/** 商品をカートに追加 */
function addToCart() {
	const sizeSelect = document.getElementById("modal-size");
	const colorGroup = document.getElementById("modal-color");
	const selectedColorBtn = colorGroup.querySelector(".size-btn.selected");

	if (!selectedColorBtn) return; // 万が一のためのフェールセーフ

	const sku = selectedColorBtn.dataset.sku;
	const qty = Number(document.getElementById("modal-qty").value);
	const maxStock = Number(selectedColorBtn.dataset.stock);

	if (qty > maxStock) {
		alert("在庫数を超えてカートに入れることはできません。");
		return;
	}

	const existingItem = cart.find((item) => item.sku === sku);
	const variationTexts = [];
	const selectedSizeBtn = sizeSelect.querySelector(".size-btn.selected");
	if (sizeSelect.style.display !== "none" && selectedSizeBtn)
		variationTexts.push(`サイズ: ${selectedSizeBtn.value}`);
	if (colorGroup.style.display !== "none") variationTexts.push(`カラー: ${selectedColorBtn.value}`);
	const variationName = variationTexts.join(" / ");

	if (existingItem) {
		if (existingItem.quantity + qty > maxStock) {
			alert(
				`すでにカートに ${existingItem.quantity} 個入っています。在庫(${maxStock}個)を超える追加はできません。`,
			);
			return;
		}
		existingItem.quantity += qty;
	} else {
		const normalPrice = parsePrice(currentSelectedProduct["通常価格(円)"]);
		const timesalePrice = parsePrice(currentSelectedProduct["タイムセール価格(円)"]);
		const hasTimesale = timesalePrice > 0 && timesalePrice < normalPrice;

		cart.push({
			sku: sku,
			productName: currentSelectedProduct["商品名"],
			variation: variationName,
			// カート内の計算基準となる価格（タイムセール適用後）
			price: hasTimesale ? timesalePrice : normalPrice,
			// 打ち消し線で表示するための元の通常価格
			normalPrice: normalPrice,
			quantity: qty,
			maxStock: maxStock,
		});
	}

	updateCartUI();
	closeModal();
}

/** フローティングバーのカウンター・合計金額を更新 */
function updateCartUI() {
	localStorage.setItem("aslish_cart", JSON.stringify(cart));
	const bar = document.getElementById("floating-bar");
	const count = cart.reduce((sum, item) => sum + item.quantity, 0);

	let subtotal = 0;
	cart.forEach((item) => {
		subtotal += item.price * item.quantity;
	});

	// 会員特典情報シートの割引率を適用（LINE連携済みの場合のみ）
	const sheetDiscount =
		!!lineUserId && memberDiscountRate > 0 ? subtotal * (memberDiscountRate / 100) : 0;
	const total = subtotal - sheetDiscount;

	const isProductListVisible =
		document.getElementById("product-list-view").style.display === "block";
	if (isProductLoaded && count > 0 && isProductListVisible) {
		document.getElementById("float-count").innerText = count;
		document.getElementById("float-total").innerText = Math.round(total).toLocaleString();
		bar.style.display = "block";
	} else {
		bar.style.display = "none";
	}
}

/** カート画面を描画 */
function renderEditableCart() {
	const container = document.getElementById("editable-cart-container");
	container.innerHTML = "";
	let subtotal = 0;

	if (cart.length === 0) {
		container.innerHTML = '<p style="color:#666; text-align:center;">カートは空です。</p>';
		document.getElementById("submit-btn").disabled = true;
		return;
	}

	document.getElementById("submit-btn").disabled = false;

	cart.forEach((item, index) => {
		const itemSubtotal = item.price * item.quantity;
		subtotal += itemSubtotal;

		const hasTimesale = item.price < item.normalPrice;

		const cartPriceHTML = `
      <div style="text-align: right;">
        ${hasTimesale ? `<span class="price-original price-strike" style="font-size:0.8rem">¥${(item.normalPrice * item.quantity).toLocaleString()}</span><br><strong style="color:var(--danger);">¥${itemSubtotal.toLocaleString()}</strong>` : `<strong style="color:var(--primary-color);">¥${itemSubtotal.toLocaleString()}</strong>`}
      </div>`;

		const div = document.createElement("div");
		div.className = "cart-item";
		div.innerHTML = `
      <div class="cart-item-header">
        <div class="cart-item-details">
          <strong>${item.productName}</strong><br>
          <span style="font-size:0.85rem; color:#666;">${item.variation}</span>
        </div>
        ${cartPriceHTML}
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top: 8px;">
        <span class="cart-item-remove" onclick="removeCartItem(${index})">削除</span>
        <div class="qty-control">
          <button type="button" onclick="changeQty(${index}, -1)">-</button>
          <input type="number" readonly value="${item.quantity}">
          <button type="button" onclick="changeQty(${index}, 1)">+</button>
        </div>
      </div>
    `;
		container.appendChild(div);
	});

	// 会員特典情報シートの割引率をカート合計全体に適用（LINE連携済みの場合のみ）
	let sheetDiscount = 0;
	if (!!lineUserId && memberDiscountRate > 0) {
		sheetDiscount = subtotal * (memberDiscountRate / 100);
	}

	const finalTotal = subtotal - sheetDiscount;

	const totalDiv = document.createElement("div");
	totalDiv.className = "total-amount";
	totalDiv.innerHTML = `
    <div class="cart-total-row">
      <span>小計</span>
      <span>¥${Math.round(subtotal).toLocaleString()}</span>
    </div>
  `;
	if (sheetDiscount > 0) {
		totalDiv.innerHTML += `
      <div class="cart-total-row member-discount">
        <span>会員特典割引 (${memberDiscountRate}%OFF)</span>
        <span>- ¥${Math.round(sheetDiscount).toLocaleString()}</span>
      </div>
    `;
	}

	totalDiv.innerHTML += `
    <div class="cart-total-row grand-total">
      <span>合計</span>
      <span>¥${Math.round(finalTotal).toLocaleString()}</span>
    </div>
  `;
	container.appendChild(totalDiv);
}

/** カート内の数量変更 */
function changeQty(index, delta) {
	const item = cart[index];
	const newQty = item.quantity + delta;
	if (newQty <= 0) {
		if (confirm("商品をカートから削除しますか？")) removeCartItem(index);
	} else if (newQty > item.maxStock) {
		alert(`在庫数（残り${item.maxStock}個）を超えて追加することはできません。`);
	} else {
		item.quantity = newQty;
		renderEditableCart();
	}
}

/** カートから商品を削除 */
function removeCartItem(index) {
	cart.splice(index, 1);
	renderEditableCart();
	if (cart.length === 0) {
		setTimeout(() => {
			alert("カートが空になったため、商品一覧へ戻ります。");
			backToShopping();
		}, 100);
	}
}

// ============================================================
// 注文処理
// ============================================================

/** 確認モーダルを開く */
function submitOrder() {
	document.getElementById("custom-confirm").classList.add("active");
}

/** 確認モーダルを閉じる */
function closeConfirm() {
	document.getElementById("custom-confirm").classList.remove("active");
}

/** OK 押下 → 実際の注文処理 */
async function executeSubmitOrder() {
	closeConfirm();

	const payload = {
		customerInfo: customerInfo,
		cart: cart,
		lineUserId: lineUserId,
		lineSource: lineSource,
	};

	const btn = document.getElementById("submit-btn");
	const backBtn = document.getElementById("back-btn");
	btn.disabled = true;
	btn.innerHTML = '<span class="btn-spinner"></span>処理中...';
	if (backBtn) backBtn.disabled = true;

	try {
		const response = await gasPost("submitOrder", { payload });
		if (response.success) {
			cart = [];
			localStorage.removeItem("aslish_cart");
			btn.disabled = false;
			btn.innerText = "注文確定";
			if (backBtn) backBtn.disabled = false;
			hideAllViews();
			document.body.classList.add("is-cart-view");
			document.getElementById("complete-order-id").innerText = response.orderId;
			document.getElementById("complete-view").style.display = "block";
			window.scrollTo(0, 0);
		} else {
			alert(response.message);
			btn.disabled = false;
			btn.innerText = "注文確定";
			if (backBtn) backBtn.disabled = false;
		}
	} catch (e) {
		alert("通信エラーが発生しました。もう一度お試しください。");
		btn.disabled = false;
		btn.innerText = "注文確定";
		if (backBtn) backBtn.disabled = false;
	}
}
