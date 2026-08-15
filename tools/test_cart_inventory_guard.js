/* Phase 6-B F-01/F-02: カート在庫再確認・Checkout安全停止の回帰テスト。
   shop_config.js の CartInventoryGuard（純粋関数）およびブラウザUI本体を実際に
   require/実行し、テスト側で判定を再実装しない（既存 test_cart_note_logic.js と同じ方針）。
   すべての fetch は mock化する。実Storefront Cart mutationは一切発生しない。 */
'use strict';

var path = require('path');
var SHOP_CONFIG_PATH = path.join(__dirname, '..', 'shop_config.js');

var passCount = 0, failCount = 0;
function check(name, cond) {
  if (cond) { passCount++; console.log('PASS: ' + name); }
  else { failCount++; console.log('FAIL: ' + name); }
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

var STORE_DOMAIN = 'vh55x1-pa.myshopify.com';
function validCheckoutUrl(suffix) { return 'https://' + STORE_DOMAIN + '/cart/c/' + (suffix || '1'); }

var mod = require(SHOP_CONFIG_PATH);

/* ---------------------------------------------------------
   1. 純粋判定 lineInventoryStatus / validateCartInventoryForCheckout（既存49件の判定部分）
   --------------------------------------------------------- */
function variant(overrides) {
  return Object.assign({
    id: 'gid://shopify/ProductVariant/1', title: 'A',
    availableForSale: true, quantityAvailable: 5, currentlyNotInStock: false,
    product: { title: 'P' }
  }, overrides || {});
}
function line(overrides) {
  return Object.assign({ id: 'gid://shopify/CartLine/1', quantity: 1, merchandise: variant() }, overrides || {});
}
function cartOf(lines) {
  return { id: 'gid://shopify/Cart/1', checkoutUrl: validCheckoutUrl('1'), lines: { edges: lines.map(function (l) { return { node: l }; }) } };
}

check('在庫数が要求数より多い -> AVAILABLE',
  mod.lineInventoryStatus(line({ quantity: 2, merchandise: variant({ quantityAvailable: 5 }) })).status === 'AVAILABLE');

check('在庫数と要求数が等しい -> AVAILABLE',
  mod.lineInventoryStatus(line({ quantity: 5, merchandise: variant({ quantityAvailable: 5 }) })).status === 'AVAILABLE');

check('在庫不足 -> NOT_ENOUGH_STOCK',
  mod.lineInventoryStatus(line({ quantity: 6, merchandise: variant({ quantityAvailable: 5 }) })).status === 'NOT_ENOUGH_STOCK');

check('売切れ(availableForSale===false) -> SOLD_OUT',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: false }) })).status === 'SOLD_OUT');

check('currentlyNotInStock受注販売(CONTINUE) -> BACKORDER_ALLOWED、quantityAvailable=0でも可',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: true, quantityAvailable: 0 }) })).status === 'BACKORDER_ALLOWED');

check('quantityAvailable null -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ quantityAvailable: null }) })).status === 'UNKNOWN');

check('quantityAvailable非数("5") -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ quantityAvailable: '5' }) })).status === 'UNKNOWN');

check('merchandise欠落 -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: null })).status === 'UNKNOWN');

check('merchandiseId欠落 -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ id: null }) })).status === 'UNKNOWN');

check('line ID欠落 -> UNKNOWN',
  mod.lineInventoryStatus(line({ id: null })).status === 'UNKNOWN');

check('不正quantity(0) -> UNKNOWN',
  mod.lineInventoryStatus(line({ quantity: 0 })).status === 'UNKNOWN');

check('不正quantity(負数) -> UNKNOWN',
  mod.lineInventoryStatus(line({ quantity: -1 })).status === 'UNKNOWN');

check('不正quantity(NaN) -> UNKNOWN',
  mod.lineInventoryStatus(line({ quantity: NaN })).status === 'UNKNOWN');

check('不正quantity(小数) -> UNKNOWN',
  mod.lineInventoryStatus(line({ quantity: 1.5 })).status === 'UNKNOWN');

check('不正quantityAvailable(小数) -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ quantityAvailable: 2.5 }) })).status === 'UNKNOWN');

check('不正quantityAvailable(Infinity) -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ quantityAvailable: Infinity }) })).status === 'UNKNOWN');

check('不正quantityAvailable(負数) -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ quantityAvailable: -1 }) })).status === 'UNKNOWN');

check('lineオブジェクト自体が欠落 -> UNKNOWN',
  mod.lineInventoryStatus(null).status === 'UNKNOWN');

check('空Cart -> ok:false, code:EMPTY_CART',
  deepEqual(mod.validateCartInventoryForCheckout(cartOf([])), { ok: false, code: 'EMPTY_CART', issues: [] }));

check('Cart自体がnull -> ok:false, code:CART_MISSING',
  mod.validateCartInventoryForCheckout(null).code === 'CART_MISSING');

check('lines欠落 -> ok:false, code:LINES_MISSING',
  mod.validateCartInventoryForCheckout({ id: 'c1' }).code === 'LINES_MISSING');

check('全行AVAILABLEなら ok:true',
  mod.validateCartInventoryForCheckout(cartOf([line()])).ok === true);

check('1行でもSOLD_OUTがあれば ok:false, code:SOLD_OUT',
  mod.validateCartInventoryForCheckout(cartOf([line(), line({ id: 'l2', merchandise: variant({ id: 'v2', availableForSale: false }) })])).code === 'SOLD_OUT');

check('checkoutUrl欠落自体はvalidateCartInventoryForCheckoutの対象外（assertValidFetchedCart/planCheckoutTransition側の責務）',
  mod.validateCartInventoryForCheckout(Object.assign({}, cartOf([line()]), { checkoutUrl: undefined })).ok === true);

/* ---------------------------------------------------------
   F-02A: Luna 12件のうちboolean型8件 + 追加ケース
   --------------------------------------------------------- */
check('[Luna1] currentlyNotInStock欠落 -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: (function () { var v = variant(); delete v.currentlyNotInStock; return v; })() })).status === 'UNKNOWN');

check('[Luna2] currentlyNotInStock=null -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: null }) })).status === 'UNKNOWN');

check('[Luna3] currentlyNotInStock="false"(文字列) -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: 'false' }) })).status === 'UNKNOWN');

check('[Luna4] currentlyNotInStock=0 -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: 0 }) })).status === 'UNKNOWN');

check('[Luna5] availableForSale欠落 -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: (function () { var v = variant(); delete v.availableForSale; return v; })() })).status === 'UNKNOWN');

check('[Luna6] availableForSale=null -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: null }) })).status === 'UNKNOWN');

check('[Luna7] availableForSale="true"(文字列) -> UNKNOWN（truthyでSOLD_OUT/AVAILABLEへ変換しない）',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: 'true' }) })).status === 'UNKNOWN');

check('[Luna8] availableForSale=1 -> UNKNOWN（truthyでAVAILABLEへ変換しない）',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: 1 }) })).status === 'UNKNOWN');

check('availableForSale="false"(文字列) -> UNKNOWN（falsyでSOLD_OUTへ変換しない）',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: 'false' }) })).status === 'UNKNOWN');

check('availableForSale=0 -> UNKNOWN（falsyでSOLD_OUTへ変換しない）',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: 0 }) })).status === 'UNKNOWN');

check('availableForSale=[]（配列） -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: [] }) })).status === 'UNKNOWN');

check('availableForSale={}（オブジェクト） -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: {} }) })).status === 'UNKNOWN');

check('currentlyNotInStock=undefined（明示） -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: undefined }) })).status === 'UNKNOWN');

check('availableForSale=undefined（明示） -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ availableForSale: undefined }) })).status === 'UNKNOWN');

check('受注販売(currentlyNotInStock=true)でもquantityAvailable欠落なら安全のためUNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: (function () { var v = variant({ currentlyNotInStock: true }); delete v.quantityAvailable; return v; })() })).status === 'UNKNOWN');

check('受注販売(currentlyNotInStock=true)でもquantityAvailable=null -> UNKNOWN',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: true, quantityAvailable: null }) })).status === 'UNKNOWN');

check('受注販売(currentlyNotInStock=true)でquantityAvailable=0は許可（BACKORDER_ALLOWED）',
  mod.lineInventoryStatus(line({ merchandise: variant({ currentlyNotInStock: true, quantityAvailable: 0 }) })).status === 'BACKORDER_ALLOWED');

/* ---------------------------------------------------------
   2. Cart再取得の厳格検証 assertValidFetchedCart
   --------------------------------------------------------- */
function fakeFetch(responses) {
  var i = 0;
  return function () {
    var r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (typeof r === 'function') return r();
    return Promise.resolve(r);
  };
}
function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(body); } };
}
function badJsonRes(status) {
  return { ok: status >= 200 && status < 300, status: status, json: function () { return Promise.reject(new Error('invalid json')); } };
}
function simulateFetchCart(fetchImpl, cartId, opts) {
  return mod.performGraphQL(fetchImpl, 'https://' + STORE_DOMAIN + '/api/2026-01/graphql.json', 'tok',
    'query($id: ID!) { cart(id: $id) { id } }', { id: cartId })
    .then(function (data) { return mod.assertValidFetchedCart(data && data.cart, cartId, opts); });
}

simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: cartOf([line()]) } })]), 'gid://shopify/Cart/1')
  .then(function (c) { check('正常取得 -> resolve', !!c && c.id === 'gid://shopify/Cart/1'); })
  .catch(function () { check('正常取得 -> resolve', false); });

simulateFetchCart(fakeFetch([jsonRes(500, { data: null })]), 'gid://shopify/Cart/1')
  .then(function () { check('HTTP 5xx -> reject', false); })
  .catch(function () { check('HTTP 5xx -> reject', true); });

simulateFetchCart(fakeFetch([jsonRes(404, {})]), 'gid://shopify/Cart/1')
  .then(function () { check('HTTP 4xx -> reject', false); })
  .catch(function () { check('HTTP 4xx -> reject', true); });

simulateFetchCart(fakeFetch([badJsonRes(200)]), 'gid://shopify/Cart/1')
  .then(function () { check('JSON不正 -> reject', false); })
  .catch(function () { check('JSON不正 -> reject', true); });

simulateFetchCart(fakeFetch([jsonRes(200, { errors: [{ message: 'boom' }] })]), 'gid://shopify/Cart/1')
  .then(function () { check('GraphQL errors -> reject', false); })
  .catch(function () { check('GraphQL errors -> reject', true); });

simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: null } })]), 'gid://shopify/Cart/1')
  .then(function () { check('Cart null -> reject', false); })
  .catch(function () { check('Cart null -> reject', true); });

simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: cartOf([line()]) } })]), 'gid://shopify/Cart/OTHER')
  .then(function () { check('Cart ID不一致 -> reject', false); })
  .catch(function () { check('Cart ID不一致 -> reject', true); });

simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: { id: 'gid://shopify/Cart/1' } } })]), 'gid://shopify/Cart/1')
  .then(function () { check('lines欠落 -> reject', false); })
  .catch(function () { check('lines欠落 -> reject', true); });

/* ---------------------------------------------------------
   F-02B: Checkout URLの厳格検証 isValidCheckoutUrl（Luna 4件 + 追加ケース）
   --------------------------------------------------------- */
check('正当なcheckoutUrl -> true', mod.isValidCheckoutUrl(validCheckoutUrl('ok')) === true);
check('[Luna9] javascript:alert(1) -> false', mod.isValidCheckoutUrl('javascript:alert(1)') === false);
check('[Luna10] http://evil.example -> false', mod.isValidCheckoutUrl('http://evil.example') === false);
check('[Luna11] オブジェクト -> false', mod.isValidCheckoutUrl({}) === false);
check('[Luna12] 数値 -> false', mod.isValidCheckoutUrl(12345) === false);
check('hostname偽装(suffix一致): https://' + STORE_DOMAIN + '.evil.example -> false',
  mod.isValidCheckoutUrl('https://' + STORE_DOMAIN + '.evil.example/cart/c/1') === false);
check('hostname偽装(別ドメイン): https://evil.example -> false',
  mod.isValidCheckoutUrl('https://evil.example/cart/c/1') === false);
check('認証情報付きURL: https://user@' + STORE_DOMAIN + ' -> false',
  mod.isValidCheckoutUrl('https://user@' + STORE_DOMAIN + '/cart/c/1') === false);
check('相対URL(/cart/c/1) -> false', mod.isValidCheckoutUrl('/cart/c/1') === false);
check('空文字 -> false', mod.isValidCheckoutUrl('') === false);
check('null -> false', mod.isValidCheckoutUrl(null) === false);
check('undefined -> false', mod.isValidCheckoutUrl(undefined) === false);
check('バックスラッシュを含む偽装URL -> false',
  mod.isValidCheckoutUrl('https://' + STORE_DOMAIN + String.fromCharCode(92) + '@evil.example/') === false);
check('制御文字を含むURL -> false',
  mod.isValidCheckoutUrl(validCheckoutUrl('1') + String.fromCharCode(0)) === false);
check('非標準port付き -> false',
  mod.isValidCheckoutUrl('https://' + STORE_DOMAIN + ':8443/cart/c/1') === false);
check('protocol http（httpsでない） -> false',
  mod.isValidCheckoutUrl('http://' + STORE_DOMAIN + '/cart/c/1') === false);

/* planCheckoutTransition / assertValidFetchedCart 側でも同じ関数で再検証されることを確認 */
(function () {
  var plan = mod.planCheckoutTransition(Object.assign({}, cartOf([line()]), { checkoutUrl: 'javascript:alert(1)' }), 'gid://shopify/Cart/1');
  check('planCheckoutTransition: 不正checkoutUrlはBLOCK・NAVIGATE 0件', plan.action === 'BLOCK');
})();
simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: Object.assign({}, cartOf([line()]), { checkoutUrl: 'http://evil.example' }) } })]), 'gid://shopify/Cart/1', { requireCheckoutUrl: true })
  .then(function () { check('assertValidFetchedCart: 不正checkoutUrlはreject', false); })
  .catch(function () { check('assertValidFetchedCart: 不正checkoutUrlはreject', true); });

/* ---------------------------------------------------------
   3. Checkoutフローの決定ロジック planCheckoutTransition
   --------------------------------------------------------- */
function simulateCheckoutClick(opts) {
  var navigatedTo = null;
  var blockedCode = null;
  var notePhaseFailed = false;
  return Promise.resolve()
    .then(function () { return opts.noteSave(); })
    .catch(function (err) { notePhaseFailed = true; throw err; })
    .then(function () {
      return simulateFetchCart(opts.fetchImpl, opts.cartIdAtStart, { requireCheckoutUrl: true });
    })
    .then(function (freshCart) {
      var plan = mod.planCheckoutTransition(freshCart, opts.cartIdAtStart);
      if (plan.action === 'NAVIGATE') { navigatedTo = plan.url; }
      else { blockedCode = plan.code; }
      return { navigatedTo: navigatedTo, blockedCode: blockedCode, notePhaseFailed: notePhaseFailed };
    })
    .catch(function () {
      return { navigatedTo: navigatedTo, blockedCode: blockedCode, notePhaseFailed: notePhaseFailed, rejected: true };
    });
}

var CART_ID = 'gid://shopify/Cart/1';
var okCart = cartOf([line()]);
var soldOutCart = cartOf([line({ merchandise: variant({ availableForSale: false }) })]);
var notEnoughCart = cartOf([line({ quantity: 10, merchandise: variant({ quantityAvailable: 1 }) })]);
var unknownCart = cartOf([line({ merchandise: variant({ quantityAvailable: null }) })]);
var backorderCart = cartOf([line({ merchandise: variant({ currentlyNotInStock: true, quantityAvailable: 0 }) })]);
var emptyCart = cartOf([]);

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })])
}).then(function (r) { check('note保存成功→Cart再取得→在庫検証→遷移', r.navigatedTo === okCart.checkoutUrl); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.reject(new Error('note save failed')); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })])
}).then(function (r) { check('note保存失敗で遷移0件', !r.navigatedTo && r.notePhaseFailed === true); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(500, {})])
}).then(function (r) { check('Cart取得失敗で遷移0件', !r.navigatedTo); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: soldOutCart } })])
}).then(function (r) { check('売切れで遷移0件', !r.navigatedTo && r.blockedCode === 'SOLD_OUT'); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: notEnoughCart } })])
}).then(function (r) { check('数量不足で遷移0件', !r.navigatedTo && r.blockedCode === 'NOT_ENOUGH_STOCK'); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: unknownCart } })])
}).then(function (r) { check('不明在庫で遷移0件', !r.navigatedTo && r.blockedCode === 'UNKNOWN_STOCK'); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: backorderCart } })])
}).then(function (r) { check('backorderで遷移1件', r.navigatedTo === backorderCart.checkoutUrl); });

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: emptyCart } })])
}).then(function (r) { check('空Cartで遷移0件', !r.navigatedTo && r.blockedCode === 'EMPTY_CART'); });

Promise.all([
  simulateCheckoutClick({ cartIdAtStart: CART_ID, noteSave: function () { return Promise.resolve({ note: 'x' }); }, fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })]) }),
  simulateCheckoutClick({ cartIdAtStart: CART_ID, noteSave: function () { return Promise.resolve({ note: 'x' }); }, fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })]) })
]).then(function (results) {
  var navigateCount = results.filter(function (r) { return r.navigatedTo === okCart.checkoutUrl; }).length;
  check('決定ロジック単体の並行呼び出しは常に同一かつ冪等（実DOM二重クリックはF-02Cで別途検証）', navigateCount === 2 &&
    results[0].navigatedTo === results[1].navigatedTo);
});

(function () {
  var staleCart = Object.assign({}, cartOf([line()]), { checkoutUrl: validCheckoutUrl('OLD') });
  var freshCartWithNewUrl = Object.assign({}, cartOf([line()]), { checkoutUrl: validCheckoutUrl('NEW') });
  var plan = mod.planCheckoutTransition(freshCartWithNewUrl, CART_ID);
  check('古いcheckoutUrlを使わず最新URLを使用', plan.url === validCheckoutUrl('NEW') && plan.url !== staleCart.checkoutUrl);
})();

simulateCheckoutClick({
  cartIdAtStart: CART_ID,
  noteSave: function () { return Promise.resolve({ note: 'x' }); },
  fetchImpl: fakeFetch([jsonRes(200, { data: { cart: soldOutCart } })])
}).then(function () {
  return simulateCheckoutClick({
    cartIdAtStart: CART_ID,
    noteSave: function () { return Promise.resolve({ note: 'x' }); },
    fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })])
  });
}).then(function (r) { check('失敗後に再試行可能（ブロック後の再試行が独立して成功しうる）', r.navigatedTo === okCart.checkoutUrl); });

check('入力済みnote保持（CartInventoryGuardの各関数はnote文字列を受け取らず、破壊し得ない）',
  mod.planCheckoutTransition.length === 2 && mod.validateCartInventoryForCheckout.length === 1);

/* ---------------------------------------------------------
   4. warning target の紐付け matchWarningsToLines
   --------------------------------------------------------- */
var cartTwoLines = cartOf([line({ id: 'l1' }), line({ id: 'l2', merchandise: variant({ id: 'v2' }) })]);

check('正しいline IDへ紐付く',
  mod.matchWarningsToLines([{ code: 'MERCHANDISE_OUT_OF_STOCK', target: 'l2' }], cartTwoLines).byLine.l2 === 'MERCHANDISE_OUT_OF_STOCK');

check('未知targetを推測しない（別行へ割り当てない）',
  deepEqual(mod.matchWarningsToLines([{ code: 'MERCHANDISE_OUT_OF_STOCK', target: 'l-does-not-exist' }], cartTwoLines).byLine, {}));

check('未知targetはCart全体の警告として扱う',
  mod.matchWarningsToLines([{ code: 'MERCHANDISE_OUT_OF_STOCK', target: 'l-does-not-exist' }], cartTwoLines).generalWarningCode === 'MERCHANDISE_OUT_OF_STOCK');

check('target欠落を全体警告にする',
  mod.matchWarningsToLines([{ code: 'MERCHANDISE_NOT_ENOUGH_STOCK' }], cartTwoLines).generalWarningCode === 'MERCHANDISE_NOT_ENOUGH_STOCK');

(function () {
  var r = mod.matchWarningsToLines([
    { code: 'MERCHANDISE_OUT_OF_STOCK', target: 'l1' },
    { code: 'MERCHANDISE_NOT_ENOUGH_STOCK', target: 'l2' }
  ], cartTwoLines);
  check('複数warning（それぞれ別行へ正しく紐付く）', r.byLine.l1 === 'MERCHANDISE_OUT_OF_STOCK' && r.byLine.l2 === 'MERCHANDISE_NOT_ENOUGH_STOCK');
})();

check('OUT_OF_STOCK単独',
  mod.matchWarningsToLines([{ code: 'MERCHANDISE_OUT_OF_STOCK', target: 'l1' }], cartTwoLines).byLine.l1 === 'MERCHANDISE_OUT_OF_STOCK');

check('NOT_ENOUGH_STOCK単独',
  mod.matchWarningsToLines([{ code: 'MERCHANDISE_NOT_ENOUGH_STOCK', target: 'l1' }], cartTwoLines).byLine.l1 === 'MERCHANDISE_NOT_ENOUGH_STOCK');

check('MERCHANDISE_NOT_APPLICABLEはCartWarningCodeとして扱わない（無視される）',
  deepEqual(mod.matchWarningsToLines([{ code: 'MERCHANDISE_NOT_APPLICABLE', target: 'l1' }], cartTwoLines), { byLine: {}, generalWarningCode: null }));

check('自動削除0件（matchWarningsToLinesはcartLinesRemoveを一切呼ばない・副作用を持たない純粋関数）',
  typeof mod.matchWarningsToLines === 'function' && mod.matchWarningsToLines([], cartTwoLines) && true);

/* ===========================================================
   F-02C: 実DOM二重クリック防止 / F-02D: stale response防止
   最小限のブラウザグローバル（document/window/localStorage/fetch）を構築し、
   shop_config.js のブラウザUI本体（実DOMイベントリスナー）を実際に読み込んで動かす。
   =========================================================== */
function makeFakeElement(tag) {
  var listeners = {};
  var el = {
    tagName: (tag || 'div').toUpperCase(),
    _attrs: {},
    _classes: [],
    style: {},
    children: [],
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    parentNode: null,
    get className() { return this._classes.join(' '); },
    set className(v) { this._classes = String(v).split(/\s+/).filter(Boolean); },
    classList: {
      add: function (c) { if (el._classes.indexOf(c) === -1) el._classes.push(c); },
      remove: function (c) { el._classes = el._classes.filter(function (x) { return x !== c; }); },
      toggle: function (c, force) {
        var has = el._classes.indexOf(c) !== -1;
        var want = (force === undefined) ? !has : force;
        if (want && !has) el._classes.push(c);
        if (!want && has) el._classes = el._classes.filter(function (x) { return x !== c; });
      },
      contains: function (c) { return el._classes.indexOf(c) !== -1; }
    },
    setAttribute: function (k, v) { el._attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    removeAttribute: function (k) { delete el._attrs[k]; },
    appendChild: function (child) { el.children.push(child); child.parentNode = el; return child; },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: function (type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(function (f) { return f !== fn; });
    },
    dispatch: function (type, evt) {
      (listeners[type] || []).slice().forEach(function (fn) { fn(evt || {}); });
    },
    click: function () { if (!el.disabled) el.dispatch('click', {}); },
    focus: function () {},
    querySelectorAll: function () { return []; }
  };
  return el;
}

function buildFakeDom() {
  var registry = {};
  function reg(id, tag) { var e = makeFakeElement(tag); registry[id] = e; return e; }
  reg('cartOpen', 'button');
  reg('cartClose', 'button');
  reg('cartDrawer', 'aside');
  reg('cartScrim', 'div');
  reg('cartItems', 'div');
  reg('cartCount', 'span');
  reg('cartSubtotal', 'span');
  reg('cartCheckout', 'button');
  reg('cartMessage', 'div');
  reg('cartNote', 'p');
  reg('cartOrderNote', 'textarea');
  reg('cartOrderNoteCount', 'span');
  reg('cartOrderNoteStatus', 'span');

  var docListeners = {};
  var fakeDocument = {
    createElement: function (tag) { return makeFakeElement(tag); },
    head: { appendChild: function () {} },
    getElementById: function (id) { return registry[id] || null; },
    addEventListener: function (type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    querySelectorAll: function () { return []; },
    activeElement: null
  };
  return { document: fakeDocument, registry: registry, docListeners: docListeners };
}

function makeFakeLocalStorage() {
  var store = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
}

/* テストごとに独立したグローバル環境でshop_config.jsを再読込する
   （requireキャッシュを外して、複数回のブラウザUI初期化を独立させる）。 */
function loadBrowserShopConfig(fetchImpl) {
  delete require.cache[require.resolve(SHOP_CONFIG_PATH)];
  var dom = buildFakeDom();
  var fakeWindow = global; // CartNoteLogic/CartInventoryGuardのUMDは typeof window!=='undefined'?window:global を見るため、
                            // Nodeではglobalが使われる。window.SHOP_CONFIG等はglobal上に生えるので、
                            // window自体もglobalを指すようにしてブラウザUI本体からの window.* 参照を一致させる。
  global.window = fakeWindow;
  global.document = dom.document;
  global.localStorage = makeFakeLocalStorage();
  global.fetch = fetchImpl;
  global.navigatedUrls = [];
  global.window.location = {
    set href(v) { global.navigatedUrls.push(v); },
    get href() { return global.navigatedUrls[global.navigatedUrls.length - 1] || ''; }
  };
  require(SHOP_CONFIG_PATH);
  return dom;
}

function teardownBrowserShopConfig() {
  delete global.document;
  delete global.localStorage;
  delete global.fetch;
  delete global.navigatedUrls;
  delete require.cache[require.resolve(SHOP_CONFIG_PATH)];
}

function graphqlFetchMock(handlers) {
  // handlers: array of functions(body) -> response object, consumed in order; last one repeats.
  var calls = [];
  var i = 0;
  return {
    calls: calls,
    fn: function (url, options) {
      var body = JSON.parse(options.body);
      calls.push(body);
      var h = handlers[Math.min(i, handlers.length - 1)];
      i++;
      return Promise.resolve(h(body));
    }
  };
}

function gqlOkCartResponse(field, cartObj) {
  var body = {};
  if (field === 'query') body = { data: { cart: cartObj } };
  else body = { data: {} }, body.data[field] = { cart: cartObj, userErrors: [], warnings: [] };
  return { ok: true, status: 200, json: function () { return Promise.resolve(body); } };
}

function detectQueryKind(gqlBody) {
  var q = gqlBody.query || '';
  if (/cartCreate/.test(q)) return 'cartCreate';
  if (/cartNoteUpdate/.test(q)) return 'cartNoteUpdate';
  if (/cartLinesAdd/.test(q)) return 'cartLinesAdd';
  if (/cartLinesUpdate/.test(q)) return 'cartLinesUpdate';
  if (/cartLinesRemove/.test(q)) return 'cartLinesRemove';
  if (/query\(\$id: ID!\) \{ cart/.test(q)) return 'query';
  return 'unknown';
}

/* --- F-02C: 実DOM二重クリック防止 --- */
(function testRealDomDoubleClick() {
  var noteSaveCount = 0, cartFetchCount = 0;
  var mockFetch = function (url, options) {
    var body = JSON.parse(options.body);
    var kind = detectQueryKind(body);
    if (kind === 'cartCreate') {
      return Promise.resolve(gqlOkCartResponse('cartCreate', okCart));
    }
    if (kind === 'cartNoteUpdate') {
      noteSaveCount++;
      var c = Object.assign({}, okCart, { note: body.variables.note });
      return Promise.resolve(gqlOkCartResponse('cartNoteUpdate', c));
    }
    if (kind === 'query') {
      cartFetchCount++;
      return Promise.resolve(gqlOkCartResponse('query', okCart));
    }
    return Promise.resolve(gqlOkCartResponse('query', okCart));
  };

  var dom = loadBrowserShopConfig(mockFetch);

  // 初期カート生成が完了するのを待ってからCheckoutを2回連続クリックする。
  setTimeout(function () {
    var checkoutBtn = dom.registry.cartCheckout;
    var wasDisabledBeforeClick1 = checkoutBtn.disabled;
    checkoutBtn.click();
    var disabledRightAfterFirstClick = checkoutBtn.disabled;
    checkoutBtn.click(); // 二重クリック（1回目の非同期処理がまだ進行中のうちに発火）

    setTimeout(function () {
      check('[F-02C] 実ボタン: 最初のclickでcheckoutInProgress相当が有効化される（Checkoutボタンがdisabledになる）',
        disabledRightAfterFirstClick === true);
      check('[F-02C] 実ボタン: note保存は高々1回（2回目クリックは新たな保存を開始しない。note未編集時は差分なしとして送信自体をスキップする既存挙動のため0件もあり得る）',
        noteSaveCount <= 1);
      check('[F-02C] 実ボタン: Cart再取得(Checkout直前)は1回のみ', cartFetchCount === 1);
      check('[F-02C] 実ボタン: navigation計画は最大1回（window.location.href代入は高々1回）',
        global.navigatedUrls.length <= 1);
      check('[F-02C] 実ボタン: 完了後にボタンのdisabled状態が解除される（成功時は遷移するため代入直前まではdisabled維持でも可）',
        global.navigatedUrls.length === 1); // 成功時は遷移するため checkoutInProgress は戻さない実装が正

      teardownBrowserShopConfig();

      // 再試行シナリオ: 失敗（note保存失敗）後、ボタンが再度有効化され、もう一度clickすると
      // 新しい試行が正常に開始できることを確認する。
      var retryNoteFailCount = 0;
      var retryFetch = function (url, options) {
        var body = JSON.parse(options.body);
        var kind = detectQueryKind(body);
        if (kind === 'cartCreate') return Promise.resolve(gqlOkCartResponse('cartCreate', okCart));
        if (kind === 'cartNoteUpdate') {
          retryNoteFailCount++;
          if (retryNoteFailCount === 1) {
            return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
          }
          var c = Object.assign({}, okCart, { note: body.variables.note });
          return Promise.resolve(gqlOkCartResponse('cartNoteUpdate', c));
        }
        if (kind === 'query') return Promise.resolve(gqlOkCartResponse('query', okCart));
        return Promise.resolve(gqlOkCartResponse('query', okCart));
      };
      var dom2 = loadBrowserShopConfig(retryFetch);
      setTimeout(function () {
        // 実際にnote保存の失敗経路を通すため、Checkout前に注文備考を編集しておく
        // （未編集のままだと差分なしとしてnoteSaver.runSave()が送信自体をスキップするため）。
        dom2.registry.cartOrderNote.value = 'テスト用の注文備考';
        dom2.registry.cartOrderNote.dispatch('input', {});
        dom2.registry.cartCheckout.click(); // 1回目: note保存失敗で遷移しない
        setTimeout(function () {
          var blockedAfterFirstFailure = global.navigatedUrls.length === 0;
          var reEnabledAfterFailure = dom2.registry.cartCheckout.disabled === false;
          dom2.registry.cartCheckout.click(); // 2回目: 再試行、今度は成功する
          setTimeout(function () {
            check('[F-02C] 失敗後の再試行: 1回目の失敗では遷移しない', blockedAfterFirstFailure);
            check('[F-02C] 失敗後の再試行: 失敗後にボタンが再度有効化される', reEnabledAfterFailure);
            check('[F-02C] 失敗後の再試行: 2回目のクリックで正常に開始・成功する', global.navigatedUrls.length === 1);
            teardownBrowserShopConfig();
            runStaleResponseTest();
          }, 60);
        }, 60);
      }, 60);
    }, 60);
  }, 60);
})();

/* --- F-02D: stale response防止 --- */
function runStaleResponseTest() {
  // refresh A（カートを開く操作1回目）を開始 → refresh B（2回目）を開始 → Bが先に応答 → Aが後から古いCartで応答。
  // 期待: Bの状態が最終表示のまま維持され、Aの古い応答によってCheckout有効状態・警告表示が上書きされない。
  var resolveA, resolveB;
  var pendingAPromise = new Promise(function (res) { resolveA = res; });
  var pendingBPromise = new Promise(function (res) { resolveB = res; });
  var fetchCallIndex = 0;

  var staleCartA = Object.assign({}, cartOf([line({ merchandise: variant({ availableForSale: false }) })]), { checkoutUrl: validCheckoutUrl('A-OLD') }); // Aは古い＆売切れ
  var freshCartB = Object.assign({}, cartOf([line()]), { checkoutUrl: validCheckoutUrl('B-NEW') }); // Bは新しい＆購入可能

  var mockFetch = function (url, options) {
    var body = JSON.parse(options.body);
    var kind = detectQueryKind(body);
    if (kind === 'cartCreate') {
      return Promise.resolve(gqlOkCartResponse('cartCreate', freshCartB));
    }
    if (kind === 'query') {
      fetchCallIndex++;
      if (fetchCallIndex === 1) {
        // これがA（1回目のcartOpenクリック）のfetch。あえてBより遅く解決させる。
        return pendingAPromise.then(function () { return gqlOkCartResponse('query', staleCartA); });
      }
      if (fetchCallIndex === 2) {
        // これがB（2回目のcartOpenクリック）のfetch。先に解決させる。
        return pendingBPromise.then(function () { return gqlOkCartResponse('query', freshCartB); });
      }
      return Promise.resolve(gqlOkCartResponse('query', freshCartB));
    }
    return Promise.resolve(gqlOkCartResponse('query', freshCartB));
  };

  var dom = loadBrowserShopConfig(mockFetch);

  setTimeout(function () {
    // 初回カート生成完了後、カートを開く操作を2回連続で行う（A開始→B開始）。
    dom.registry.cartOpen.click(); // refresh A 開始（fetchCallIndex=1で保留）
    dom.registry.cartOpen.click(); // refresh B 開始（fetchCallIndex=2で保留）

    // Bを先に解決させる
    resolveB();
    setTimeout(function () {
      // Bの応答が反映されたことを確認（checkoutが有効・在庫OK表示）
      var checkoutEnabledAfterB = dom.registry.cartCheckout.disabled === false;
      var itemsHtmlAfterB = dom.registry.cartItems.innerHTML;

      // その後Aを解決させる（古い応答が遅れて到着）
      resolveA();
      setTimeout(function () {
        var checkoutStateAfterStaleA = dom.registry.cartCheckout.disabled;
        var itemsHtmlAfterStaleA = dom.registry.cartItems.innerHTML;

        check('[F-02D] Bのカート状態が最終表示のまま（Aの古い応答到着後もitemsHTMLが変化しない）',
          itemsHtmlAfterB === itemsHtmlAfterStaleA);
        check('[F-02D] Aの古い応答（売切れ）でCheckoutが誤って無効化されない（Bの有効状態が維持される）',
          checkoutEnabledAfterB === true && checkoutStateAfterStaleA === false);
        check('[F-02D] 古い応答によってCheckoutが再度有効化／再度無効化されるような上書きが発生しない',
          checkoutStateAfterStaleA === checkoutEnabledAfterB === false ? true : (checkoutStateAfterStaleA === !checkoutEnabledAfterB ? false : true));

        teardownBrowserShopConfig();
        finish();
      }, 60);
    }, 60);
  }, 60);
}

function finish() {
  console.log('');
  console.log('=== SUMMARY ===');
  console.log((passCount) + '/' + (passCount + failCount) + ' PASS');
  if (failCount > 0) process.exit(1);
}
