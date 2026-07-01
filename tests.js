// ============================================================
// 回帰テスト：キャッシュ化・エンドポイント集約の前後で
// レスポンスが同一であることを検証する
// ============================================================
//
// 【使い方】
//
//   PHASE 1: 実装変更前（現状のまま）
//     1. GASエディタで captureBaseline() を実行
//        → 現状の各エンドポイントの戻り値がスナップショットとして保存される
//
//   PHASE 2: 実装変更後
//     2. キャッシュ化 / 集約エンドポイント getInitialData() を実装
//     3. GASエディタで runAllTests() を実行
//        → 新実装の戻り値がベースラインと完全一致するか検証
//        → キャッシュが効いているか、削除後に再取得されるかも検証
//
//   補助:
//     - clearBaseline()           : ベースラインを破棄してやり直し
//     - clearAllCaches()          : 全キャッシュキーを削除
//     - measureCurrentPerformance(): 現状の処理時間を10回平均で計測
//     - inspectSnapshot()         : 保存されたスナップショットの概要を表示
//
// ============================================================

const SNAPSHOT_PROP_PREFIX = "test_baseline_";
const SNAPSHOT_CHUNK_SIZE = 9000; // PropertiesService の 1値=9KB 制限対策

// 新実装で使用予定のキャッシュキー一覧（実装時に合わせてください）
const TEST_CACHE_KEYS = [
	"productInventory",
	"schools",
	"discountRate",
	"memberDiscountRate",
	"config",
	"initialData",
];

// ============================================================
// テスト基盤
// ============================================================

function assert(condition, message) {
	if (!condition) throw new Error("ASSERTION FAILED: " + message);
}

/**
 * ContentService 経由でクライアントが受け取る形に揃える。
 * Date → ISO文字列, undefined → 削除 など、JSONシリアライズで起きる
 * 正規化を事前に適用しておくことで「実装内部のDate vs ISO文字列」の
 * 偽陽性を防ぐ。
 */
function normalizeForComparison(data) {
	return JSON.parse(JSON.stringify(data));
}

/**
 * 再帰的に2つの値を比較。Date / Array / Object / プリミティブに対応。
 * 完全一致なら true。
 */
function deepEqual(a, b) {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
	if (typeof a !== "object" || typeof b !== "object") return false;

	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}

	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (keysA.length !== keysB.length) return false;
	for (let i = 0; i < keysA.length; i++) {
		if (keysA[i] !== keysB[i]) return false;
		if (!deepEqual(a[keysA[i]], b[keysA[i]])) return false;
	}
	return true;
}

/**
 * 差分を人間に分かる形で説明する。一致なら null を返す。
 * 例: "products[3].stockList[0].在庫数: 12 !== 10"
 */
function diffDescription(a, b, path) {
	path = path || "";
	if (a === b) return null;
	if (a == null || b == null) {
		return path + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b);
	}
	if (a instanceof Date && b instanceof Date) {
		if (a.getTime() === b.getTime()) return null;
		return path + ": Date差異 " + a.toISOString() + " vs " + b.toISOString();
	}
	if (typeof a !== "object" || typeof b !== "object") {
		return path + ": " + JSON.stringify(a) + " !== " + JSON.stringify(b);
	}
	if (Array.isArray(a) !== Array.isArray(b)) {
		return path + ": 配列とオブジェクトの差";
	}
	if (Array.isArray(a)) {
		if (a.length !== b.length) {
			return path + ": 配列長 " + a.length + " vs " + b.length;
		}
		for (let i = 0; i < a.length; i++) {
			const d = diffDescription(a[i], b[i], path + "[" + i + "]");
			if (d) return d;
		}
		return null;
	}
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (keysA.length !== keysB.length) {
		return (
			path +
			": キー数 " +
			keysA.length +
			"(" +
			keysA.join(",") +
			") vs " +
			keysB.length +
			"(" +
			keysB.join(",") +
			")"
		);
	}
	for (let i = 0; i < keysA.length; i++) {
		if (keysA[i] !== keysB[i]) {
			return path + ": キー名 " + keysA[i] + " vs " + keysB[i];
		}
		const d = diffDescription(a[keysA[i]], b[keysA[i]], path + "." + keysA[i]);
		if (d) return d;
	}
	return null;
}

// テスト集計
const testResults = { passed: 0, failed: 0, skipped: 0, errors: [] };

function runTest(name, fn) {
	Logger.log("▶ " + name);
	try {
		fn();
		testResults.passed++;
		Logger.log("  ✅ PASS");
	} catch (e) {
		if (e.message && e.message.indexOf("[SKIP]") === 0) {
			testResults.skipped++;
			Logger.log("  ⏭️  SKIP: " + e.message.replace("[SKIP]", "").trim());
		} else {
			testResults.failed++;
			testResults.errors.push({ name: name, error: e.message });
			Logger.log("  ❌ FAIL: " + e.message);
		}
	}
}

function skip(reason) {
	throw new Error("[SKIP] " + reason);
}

// ============================================================
// スナップショット保存・読み込み
// 9KB制限があるので JSON を分割して PropertiesService に格納する
// ============================================================

function saveSnapshot(key, data) {
	const props = PropertiesService.getScriptProperties();
	const json = JSON.stringify(normalizeForComparison(data));

	// 既存チャンクを掃除
	props.getKeys().forEach((k) => {
		if (k.indexOf(SNAPSHOT_PROP_PREFIX + key + "_") === 0) {
			props.deleteProperty(k);
		}
	});

	const chunks = [];
	for (let i = 0; i < json.length; i += SNAPSHOT_CHUNK_SIZE) {
		chunks.push(json.substring(i, i + SNAPSHOT_CHUNK_SIZE));
	}

	const toSave = {};
	toSave[SNAPSHOT_PROP_PREFIX + key + "_count"] = String(chunks.length);
	chunks.forEach((chunk, i) => {
		toSave[SNAPSHOT_PROP_PREFIX + key + "_chunk_" + i] = chunk;
	});
	props.setProperties(toSave);

	Logger.log(
		"  💾 スナップショット保存: " + key + " (" + chunks.length + " チャンク, " + json.length + " 文字)",
	);
}

function loadSnapshot(key) {
	const props = PropertiesService.getScriptProperties();
	const countStr = props.getProperty(SNAPSHOT_PROP_PREFIX + key + "_count");
	if (!countStr) {
		throw new Error(
			"ベースラインがありません: " + key + " - まず captureBaseline() を実行してください",
		);
	}
	const count = parseInt(countStr, 10);
	let json = "";
	for (let i = 0; i < count; i++) {
		const chunk = props.getProperty(SNAPSHOT_PROP_PREFIX + key + "_chunk_" + i);
		if (chunk == null) throw new Error("チャンク欠損: " + key + "_chunk_" + i);
		json += chunk;
	}
	return JSON.parse(json);
}

function hasSnapshot(key) {
	return (
		PropertiesService.getScriptProperties().getProperty(
			SNAPSHOT_PROP_PREFIX + key + "_count",
		) != null
	);
}

// ============================================================
// PHASE 1: ベースライン取得（実装変更前に1回だけ実行）
// ============================================================

function captureBaseline() {
	Logger.log("============================================");
	Logger.log("ベースライン取得開始");
	Logger.log("実行前のキャッシュをクリアします（生のシート読み込み結果を記録するため）");
	Logger.log("============================================");

	clearAllCaches();

	const products = getProductAndInventoryData();
	saveSnapshot("products", products);

	const schools = getSchoolList();
	saveSnapshot("schools", schools);

	const discountRate = getMemberDiscountRate();
	saveSnapshot("discountRate", discountRate);

	Logger.log("============================================");
	Logger.log("ベースライン取得完了");
	Logger.log("  - 商品数: " + products.length);
	Logger.log("  - スクール数: " + schools.length);
	Logger.log("  - 割引率: " + discountRate.discountRate + "%");
	Logger.log("============================================");
	Logger.log("次のステップ:");
	Logger.log("  1. キャッシュ化・getInitialData() の実装を行う");
	Logger.log("  2. runAllTests() を実行して全てPASSすることを確認する");
}

function clearBaseline() {
	const props = PropertiesService.getScriptProperties();
	let deleted = 0;
	props.getKeys().forEach((k) => {
		if (k.indexOf(SNAPSHOT_PROP_PREFIX) === 0) {
			props.deleteProperty(k);
			deleted++;
		}
	});
	Logger.log("ベースラインをクリアしました（" + deleted + " 件削除）");
}

// ============================================================
// PHASE 2: 回帰テスト本体（実装後に実行）
// ============================================================

function runAllTests() {
	testResults.passed = 0;
	testResults.failed = 0;
	testResults.skipped = 0;
	testResults.errors = [];

	Logger.log("============================================");
	Logger.log("回帰テスト開始: " + new Date().toLocaleString("ja-JP"));
	Logger.log("============================================");

	// 前提チェック
	if (!hasSnapshot("products") || !hasSnapshot("schools") || !hasSnapshot("discountRate")) {
		Logger.log("");
		Logger.log("⚠️  ベースラインが未取得です。captureBaseline() を先に実行してください。");
		return;
	}

	// --- 等価性テスト：生関数 ---
	runTest("【等価性】getProductAndInventoryData() がベースラインと一致", () => {
		clearAllCaches();
		const expected = loadSnapshot("products");
		const actual = normalizeForComparison(getProductAndInventoryData());
		const diff = diffDescription(expected, actual, "products");
		if (diff) throw new Error(diff);
	});

	runTest("【等価性】getSchoolList() がベースラインと一致", () => {
		clearAllCaches();
		const expected = loadSnapshot("schools");
		const actual = normalizeForComparison(getSchoolList());
		const diff = diffDescription(expected, actual, "schools");
		if (diff) throw new Error(diff);
	});

	runTest("【等価性】getMemberDiscountRate() がベースラインと一致", () => {
		clearAllCaches();
		const expected = loadSnapshot("discountRate");
		const actual = normalizeForComparison(getMemberDiscountRate());
		const diff = diffDescription(expected, actual, "discountRate");
		if (diff) throw new Error(diff);
	});

	// --- 等価性テスト：doGet 経由 ---
	runTest("【等価性】doGet(getProductAndInventoryData) のレスポンスが一致", () => {
		clearAllCaches();
		const res = doGet({ parameter: { action: "getProductAndInventoryData" } });
		const body = JSON.parse(res.getContent());
		const diff = diffDescription(loadSnapshot("products"), body, "doGet.products");
		if (diff) throw new Error(diff);
	});

	runTest("【等価性】doGet(getSchoolList) のレスポンスが一致", () => {
		clearAllCaches();
		const res = doGet({ parameter: { action: "getSchoolList" } });
		const body = JSON.parse(res.getContent());
		const diff = diffDescription(loadSnapshot("schools"), body, "doGet.schools");
		if (diff) throw new Error(diff);
	});

	runTest("【等価性】doGet(getMemberDiscountRate) のレスポンスが一致", () => {
		clearAllCaches();
		const res = doGet({ parameter: { action: "getMemberDiscountRate" } });
		const body = JSON.parse(res.getContent());
		const diff = diffDescription(loadSnapshot("discountRate"), body, "doGet.discountRate");
		if (diff) throw new Error(diff);
	});

	// --- 集約エンドポイントのテスト（実装後のみ動く） ---
	runTest("【集約】getInitialData() が個別エンドポイントの合算を返す", () => {
		if (typeof getInitialData !== "function") {
			skip("getInitialData が未実装");
		}
		clearAllCaches();
		const aggregated = normalizeForComparison(getInitialData());
		assert(aggregated != null, "戻り値が null/undefined");
		assert("products" in aggregated, "products キーがありません");
		assert("schools" in aggregated, "schools キーがありません");
		assert("discountRate" in aggregated, "discountRate キーがありません");

		const productDiff = diffDescription(
			loadSnapshot("products"),
			aggregated.products,
			"aggregated.products",
		);
		if (productDiff) throw new Error(productDiff);

		const schoolDiff = diffDescription(
			loadSnapshot("schools"),
			aggregated.schools,
			"aggregated.schools",
		);
		if (schoolDiff) throw new Error(schoolDiff);

		const rateDiff = diffDescription(
			loadSnapshot("discountRate"),
			aggregated.discountRate,
			"aggregated.discountRate",
		);
		if (rateDiff) throw new Error(rateDiff);
	});

	runTest("【集約】doGet(getInitialData) のレスポンスが個別エンドポイントの合算と一致", () => {
		if (typeof getInitialData !== "function") {
			skip("getInitialData が未実装");
		}
		clearAllCaches();
		const res = doGet({ parameter: { action: "getInitialData" } });
		const body = JSON.parse(res.getContent());
		const productDiff = diffDescription(
			loadSnapshot("products"),
			body.products,
			"doGet.initialData.products",
		);
		if (productDiff) throw new Error(productDiff);
		const schoolDiff = diffDescription(
			loadSnapshot("schools"),
			body.schools,
			"doGet.initialData.schools",
		);
		if (schoolDiff) throw new Error(schoolDiff);
		const rateDiff = diffDescription(
			loadSnapshot("discountRate"),
			body.discountRate,
			"doGet.initialData.discountRate",
		);
		if (rateDiff) throw new Error(rateDiff);
	});

	// --- キャッシュ動作テスト ---
	runTest("【キャッシュ】2回目の呼び出しが1回目より速い（キャッシュヒット）", () => {
		// 揺らぎを抑えるため複数回の中央値で比較する
		const SAMPLES = 5;
		const missTimes = [];
		const hitTimes = [];

		for (let i = 0; i < SAMPLES; i++) {
			clearAllCaches();
			const t1 = Date.now();
			getProductAndInventoryData();
			missTimes.push(Date.now() - t1);

			const t2 = Date.now();
			getProductAndInventoryData();
			hitTimes.push(Date.now() - t2);
		}

		const median = (arr) => {
			const sorted = arr.slice().sort((a, b) => a - b);
			return sorted[Math.floor(sorted.length / 2)];
		};
		const missMedian = median(missTimes);
		const hitMedian = median(hitTimes);

		Logger.log(
			"    キャッシュミス中央値: " +
				missMedian +
				"ms (samples: " +
				missTimes.join(",") +
				")",
		);
		Logger.log(
			"    ヒット中央値: " + hitMedian + "ms (samples: " + hitTimes.join(",") + ")",
		);

		// 判定: 「ヒットがミスより速い」ことだけを要件にする
		// （データ規模が小さい環境では絶対差が小さいので倍率指定は避ける）
		assert(
			hitMedian <= missMedian,
			"キャッシュヒットがミスより遅い（ヒット中央値 " +
				hitMedian +
				"ms vs ミス中央値 " +
				missMedian +
				"ms）。キャッシュが効いていない可能性があります",
		);

		// 参考情報として倍率も出す
		if (missMedian > 0) {
			const ratio = (hitMedian / missMedian).toFixed(2);
			Logger.log("    ヒット/ミス比率: " + ratio + " (1.0未満ほど高速)");
		}
	});

	runTest("【キャッシュ】キャッシュ削除後はシートを再度読みに行く", () => {
		// キャッシュを温める
		getProductAndInventoryData();

		// 削除
		const cache = CacheService.getScriptCache();
		cache.removeAll(TEST_CACHE_KEYS);

		// 再取得：戻り値はベースラインと同じであるべき
		const result = normalizeForComparison(getProductAndInventoryData());
		const diff = diffDescription(loadSnapshot("products"), result, "products(after cache clear)");
		if (diff) throw new Error(diff);
	});

	runTest("【キャッシュ】キャッシュヒット時もデータ内容は完全に同じ", () => {
		clearAllCaches();
		const first = normalizeForComparison(getProductAndInventoryData()); // ミス
		const second = normalizeForComparison(getProductAndInventoryData()); // ヒット
		const diff = diffDescription(first, second, "products(miss vs hit)");
		if (diff) throw new Error(diff);
	});

	// --- パフォーマンス計測（参考値） ---
	runTest("【性能】キャッシュヒット時の getInitialData が1秒以内", () => {
		if (typeof getInitialData !== "function") {
			skip("getInitialData が未実装");
		}
		// 1回目で温め、2回目を計測
		getInitialData();
		const t = Date.now();
		getInitialData();
		const elapsed = Date.now() - t;
		Logger.log("    キャッシュヒット時: " + elapsed + "ms");
		assert(elapsed < 1000, "1秒を超えています: " + elapsed + "ms");
	});

	// --- 結果サマリ ---
	Logger.log("");
	Logger.log("============================================");
	Logger.log(
		"テスト結果: ✅ " +
			testResults.passed +
			" PASS / ❌ " +
			testResults.failed +
			" FAIL / ⏭️ " +
			testResults.skipped +
			" SKIP",
	);
	Logger.log("============================================");
	if (testResults.failed > 0) {
		Logger.log("");
		Logger.log("失敗詳細:");
		testResults.errors.forEach((e) => {
			Logger.log("  ❌ " + e.name);
			Logger.log("     " + e.error);
		});
	}

	return testResults;
}

// ============================================================
// 補助ツール
// ============================================================

function clearAllCaches() {
	CacheService.getScriptCache().removeAll(TEST_CACHE_KEYS);
}

/**
 * 現状のパフォーマンスを10回平均で計測。
 * 実装変更前に走らせて改善幅の目安にする。
 */
function measureCurrentPerformance() {
	Logger.log("============================================");
	Logger.log("パフォーマンス計測（10回平均）");
	Logger.log("============================================");

	const times = { products: [], schools: [], discountRate: [], total: [] };
	for (let i = 0; i < 10; i++) {
		const t0 = Date.now();

		const t1 = Date.now();
		getProductAndInventoryData();
		times.products.push(Date.now() - t1);

		const t2 = Date.now();
		getSchoolList();
		times.schools.push(Date.now() - t2);

		const t3 = Date.now();
		getMemberDiscountRate();
		times.discountRate.push(Date.now() - t3);

		times.total.push(Date.now() - t0);
		Utilities.sleep(100); // 連続実行で偏らないよう小休止
	}

	const avg = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
	const max = (arr) => Math.max.apply(null, arr);
	const min = (arr) => Math.min.apply(null, arr);

	Object.keys(times).forEach((key) => {
		Logger.log(
			"  " +
				key +
				": 平均 " +
				avg(times[key]) +
				"ms (min " +
				min(times[key]) +
				" / max " +
				max(times[key]) +
				")",
		);
	});
}

// ============================================================
// 単体テスト：buildHistoryRows（最終支払額・ステータス先頭行記入方式）
// ベースライン不要。GASエディタで testBuildHistoryRows() を実行する。
// ============================================================
function testBuildHistoryRows() {
	const ts = new Date("2026-06-10T10:00:00+09:00");
	const payload = {
		customerInfo: { email: "a@example.com", school: "テスト校", memberName: "テスト太郎" },
		lineUserId: "U123",
		cart: [
			{ sku: "P002-22.0", quantity: 1, price: 5400, normalPrice: 5940, productName: "x", variation: "y" },
			{ sku: "P010-24.5", quantity: 2, price: 3300, normalPrice: 3300, productName: "x", variation: "y" },
		],
	};
	// 小計 = 5400 + 6600 = 12000, 会員割引 10% = 1200, 最終 = 10800
	const rows = buildHistoryRows("ORD-TEST01", ts, payload, 1200, 10800);

	// 行構成: 商品1, タイムセール割引(商品1), 商品2, 会員特典割引 = 4行
	assert(rows.length === 4, "行数が4であること（実際: " + rows.length + "）");
	assert(rows.every((r) => r.length === 11), "全行が11列であること");

	// 先頭行のみ最終支払額・ステータス
	assert(rows[0][8] === 10800, "先頭行の最終支払額が10800であること（実際: " + rows[0][8] + "）");
	assert(rows[0][9] === "未入金", "先頭行のステータスが「未入金」であること");
	for (let i = 1; i < rows.length; i++) {
		assert(rows[i][8] === "", i + "行目の最終支払額が空欄であること");
		assert(rows[i][9] === "", i + "行目のステータスが空欄であること");
	}

	// 支払金額小計の合計 = 最終支払額（タイムセール540引き＋会員割引1200引き）
	const subtotalSum = rows.reduce((s, r) => s + Number(r[7]), 0);
	assert(subtotalSum === 10800, "支払金額小計のSUMが最終支払額と一致すること（実際: " + subtotalSum + "）");

	// 割引行の内容
	assert(String(rows[1][5]).indexOf("タイムセール割引") === 0, "2行目がタイムセール割引行であること");
	assert(rows[1][7] === -540, "タイムセール割引が-540であること（実際: " + rows[1][7] + "）");
	assert(rows[3][5] === "会員特典割引", "4行目が会員特典割引行であること");
	assert(rows[3][7] === -1200, "会員特典割引が-1200であること");

	// 割引なし・1商品・LINE未連携
	const simple = buildHistoryRows(
		"ORD-TEST02",
		ts,
		{
			customerInfo: { email: "b@example.com", school: "s", memberName: "n" },
			cart: [{ sku: "P001", quantity: 1, price: 3300 }],
		},
		0,
		3300,
	);
	assert(simple.length === 1, "割引なし注文は1行であること");
	assert(simple[0][8] === 3300 && simple[0][9] === "未入金", "1行注文も先頭行に最終支払額・ステータスが入ること");
	assert(simple[0][10] === "", "LINE未連携時はLINE UserIDが空欄であること");

	Logger.log("✅ testBuildHistoryRows: 全アサーション PASS");
}

/**
 * デバッグ用：スナップショットの概要を表示
 */
function inspectSnapshot() {
	["products", "schools", "discountRate"].forEach((key) => {
		if (hasSnapshot(key)) {
			const data = loadSnapshot(key);
			const summary = Array.isArray(data)
				? "配列(長さ " + data.length + ")"
				: typeof data === "object"
					? "オブジェクト " + JSON.stringify(data).substring(0, 100)
					: String(data);
			Logger.log("  " + key + ": " + summary);
		} else {
			Logger.log("  " + key + ": （未取得）");
		}
	});
}
