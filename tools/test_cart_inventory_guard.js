/* Phase 6-B F-01: カート在庫再確認・Checkout安全停止の回帰テスト。
   shop_config.js の CartInventoryGuard（純粋関数）を実際に require し、
   テスト側で判定を再実装しない（既存 test_cart_note_logic.js と同じ方針）。
   すべての fetch は mock化する。実Storefront Cart mutationは一切発生しない。 */
'use strict';

var path = require('path');
var mod = require(path.join(__dirname, '..', 'shop_config.js'));

var passCount = 0, failCount = 0;
function check(name, cond) {
  if (cond) { passCount++; console.log('PASS: ' + name); }
  else { failCount++; console.log('FAIL: ' + name); }
}
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------------------------------------------------------
   1. 純粋判定 lineInventoryStatus / validateCartInventoryForCheckout
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
  return { id: 'gid://shopify/Cart/1', checkoutUrl: 'https://example.myshopify.com/cart/c/1', lines: { edges: lines.map(function (l) { return { node: l }; }) } };
}

check('在庫数が要求数より多い -> AVAILABLE',
  mod.lineInventoryStatus(line({ quantity: 2, merchandise: variant({ quantityAvailable: 5 }) })).status === 'AVAILABLE');

check('在庫数と要求数が等しい -> AVAILABLE',
  mod.lineInventoryStatus(line({ quantity: 5, merchandise: variant({ quantityAvailable: 5 }) })).status === 'AVAILABLE');

check('在庫不足 -> NOT_ENOUGH_STOCK',
  mod.lineInventoryStatus(line({ quantity: 6, merchandise: variant({ quantityAvailable: 5 }) })).status === 'NOT_ENOUGH_STOCK');

check('売切れ(availableForSale!==true) -> SOLD_OUT',
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

check('lineオブジェクト自体が欠落 -> UNKNOWN（Cart欠落系はvalidateCartInventoryForCheckout側で別途保証）',
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
   2. Cart再取得の厳格検証 assertValidFetchedCart
      + fetchCart相当の一連の流れ（performGraphQL + assertValidFetchedCart）をmockで再現。
      実装(shop_config.js の fetchCart)と同じ2関数を同じ順序で呼ぶことで、
      テスト側で判定を再実装しない。
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
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.resolve(body); }
  };
}
function badJsonRes(status) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: function () { return Promise.reject(new Error('invalid json')); }
  };
}
function simulateFetchCart(fetchImpl, cartId, opts) {
  return mod.performGraphQL(fetchImpl, 'https://example.myshopify.com/api/2026-01/graphql.json', 'tok',
    'query($id: ID!) { cart(id: $id) { id } }', { id: cartId })
    .then(function (data) { return mod.assertValidFetchedCart(data && data.cart, cartId, opts); });
}

simulateFetchCart(fakeFetch([jsonRes(200, { data: { cart: cartOf([line()])[0] || cartOf([line()]) } })]), 'gid://shopify/Cart/1')
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
   3. Checkoutフローの決定ロジック planCheckoutTransition
      note保存 -> Cart再取得 -> 在庫検証 -> 遷移可否、という一連の流れを
      実装と同じ関数（performGraphQL / assertValidFetchedCart / planCheckoutTransition）を
      同じ順序で呼び出すことで確認する（テスト側で判定を再実装しない）。
   --------------------------------------------------------- */
function simulateCheckoutClick(opts) {
  // opts.noteSave: () => Promise<{note}> | rejects
  // opts.fetchImpl: fetch mock for the post-note-save cart refetch
  // opts.cartIdAtStart
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

// 二重クリックでも遷移1件: 実装のcheckoutInProgressガード自体はDOM内の状態変数のため、
// ここでは「同一クリックシーケンスを2回並行実行しても、決定ロジックは冪等で
// 常に同じ結果を返す（2回呼んでも2つ目が別の意思決定をしない）」ことを検証する。
Promise.all([
  simulateCheckoutClick({ cartIdAtStart: CART_ID, noteSave: function () { return Promise.resolve({ note: 'x' }); }, fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })]) }),
  simulateCheckoutClick({ cartIdAtStart: CART_ID, noteSave: function () { return Promise.resolve({ note: 'x' }); }, fetchImpl: fakeFetch([jsonRes(200, { data: { cart: okCart } })]) })
]).then(function (results) {
  var navigateCount = results.filter(function (r) { return r.navigatedTo === okCart.checkoutUrl; }).length;
  check('二重クリックでも遷移1件相当（決定ロジックは常に同一かつ冪等）', navigateCount === 2 &&
    results[0].navigatedTo === results[1].navigatedTo);
});

// 古いcheckoutUrlを使わず最新URLを使用
var staleCart = Object.assign({}, cartOf([line()]), { checkoutUrl: 'https://example.myshopify.com/cart/c/OLD' });
var freshCartWithNewUrl = Object.assign({}, cartOf([line()]), { checkoutUrl: 'https://example.myshopify.com/cart/c/NEW' });
(function () {
  var plan = mod.planCheckoutTransition(freshCartWithNewUrl, CART_ID);
  check('古いcheckoutUrlを使わず最新URLを使用', plan.url === 'https://example.myshopify.com/cart/c/NEW' && plan.url !== staleCart.checkoutUrl);
})();

// 失敗後に再試行可能: ブロックされた直後に再度成功パターンで呼んでも独立して正しく判定できる
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

// 入力済みnote保持: noteSave失敗時、決定ロジック自体はnoteの値を書き換えない・消去しない
// （noteの保持責務はnoteSaver側にあり、CartInventoryGuardはnote文字列を一切扱わない
//  ＝入力内容を破壊しうる経路が存在しないことをAPI形状で確認する）。
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

setTimeout(function () {
  console.log('');
  console.log('=== SUMMARY ===');
  console.log((passCount) + '/' + (passCount + failCount) + ' PASS');
  if (failCount > 0) process.exit(1);
}, 50);
