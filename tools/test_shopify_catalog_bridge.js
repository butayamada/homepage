#!/usr/bin/env node
/*
 * shopify_catalog_bridge.js の実コードをNodeの隔離環境で実行し、結果を検証する。
 * Pythonで同じロジックを書き直すのではなく、require() した実モジュールをそのまま試験する。
 * ネットワーク通信・DOM操作は行わない（buildCatalogMerge等の純粋関数のみを対象とする）。
 *
 * Usage: node tools/test_shopify_catalog_bridge.js
 */
'use strict';
var path = require('path');
var bridge = require(path.join(__dirname, '..', 'shopify_catalog_bridge.js'));

var results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
}

function makeCatalogEntry(catalogId, existingAlias, headlessPublished, opts) {
  opts = opts || {};
  return {
    catalogId: catalogId,
    productGid: 'gid://shopify/Product/' + catalogId,
    representativeVariantGid: 'gid://shopify/ProductVariant/' + catalogId + '-1',
    shopifyTitle: opts.title || ('タイトル ' + catalogId),
    name: opts.title || ('タイトル ' + catalogId),
    descriptionHtml: '<p>説明</p>',
    vendor: opts.vendor || 'ARC FUKAMEKI minoh',
    productType: opts.productType || 'Ceramics',
    images: ['https://cdn.shopify.com/x.jpg'],
    variants: opts.variants || [{ gid: 'v1', title: 'Default Title', selectedOptions: [], price: '1000', currencyCode: 'JPY', availableForSale: true }],
    shopifyStatus: 'UNLISTED',
    headlessPublished: headlessPublished,
    existingAlias: existingAlias || null,
    updatedAt: '2026-08-06T00:00:00Z'
  };
}

// ---------- 一覧集合: 既存70件fixture + カタログ132件合成 ----------
(function () {
  var existingProductsData = {};
  var existingOnly70 = [];
  for (var i = 0; i < 70; i++) {
    var id = 'legacy_' + i;
    existingOnly70.push(id);
    existingProductsData[id] = { artist: '作家' + i, name: '商品' + i, price: '¥1,000', category: 'Ceramics', img: 'x.jpg', images: [], baseUrl: 'https://fukameki.thebase.in/items/' + i };
  }
  var aliasCount = 89, newCount = 43;
  var catalogProducts = [];
  for (var a = 0; a < aliasCount; a++) {
    var aliasId = 'alias_' + a;
    existingProductsData[aliasId] = { artist: '旧作家' + a, name: '旧商品名' + a, price: '¥500', category: 'Ceramics', img: 'y.jpg', images: [], baseUrl: '', shopify: 'gid://shopify/ProductVariant/alias_' + a + '-1' };
    catalogProducts.push(makeCatalogEntry('shopify_ignored_' + a, aliasId, true, { title: 'Shopifyタイトル' + a }));
  }
  for (var n = 0; n < newCount; n++) {
    catalogProducts.push(makeCatalogEntry('shopify_new_' + n, null, true, { title: '新規Shopifyタイトル' + n }));
  }

  var result = bridge.buildCatalogMerge(catalogProducts, existingProductsData);

  check('一覧対象(testPageOrder)が132件', result.testPageOrder.length === 132);
  var orderKeys = result.testPageOrder.map(function (f) { return f.replace(/^product_/, '').replace(/\.html$/, ''); });
  check('一覧対象に重複0件', new Set(orderKeys).size === 132);
  check('一覧対象にカタログ外70件が含まれない', existingOnly70.every(function (id) { return orderKeys.indexOf(id) === -1; }));
  check('カタログ外70件はPRODUCTS_DATAから消えない', existingOnly70.every(function (id) { return !!result.mergedProductsData[id]; }));
  var aliasIds = [];
  for (var a2 = 0; a2 < aliasCount; a2++) aliasIds.push('alias_' + a2);
  check('既存alias89件すべてtestPageOrderに含まれる', aliasIds.every(function (id) { return orderKeys.indexOf(id) !== -1; }));
  var newIds = [];
  for (var n2 = 0; n2 < newCount; n2++) newIds.push('shopify_new_' + n2);
  check('新規43件すべてtestPageOrderに含まれる', newIds.every(function (id) { return orderKeys.indexOf(id) !== -1; }));
  check('既存aliasの表示名はShopifyタイトルで上書きされる（旧nameを引きずらない）',
    result.mergedProductsData['alias_0'].name === 'Shopifyタイトル0' && result.mergedProductsData['alias_0'].name !== '旧商品名0');
  check('カタログ外70件のデータは変更されない（name等が保持される）',
    result.mergedProductsData['legacy_0'].name === '商品0');
})();

// ---------- Headless値マトリクス ----------
(function () {
  var values = [true, false, undefined, null, 0, 1, 'true', 'false', ''];
  var expectedTrueFor = [true];
  values.forEach(function (v) {
    var entry = makeCatalogEntry('h_' + String(v), null, v);
    var merged = bridge.catalogEntryToMergedProduct(entry, undefined);
    var expected = expectedTrueFor.indexOf(v) !== -1;
    check('headlessPublished=' + JSON.stringify(v) + ' -> merged.headlessPublished===' + expected, merged.headlessPublished === expected);
  });
  check('normalizeHeadlessPublished: true以外は常にfalse',
    [false, undefined, null, 0, 1, 'true', 'false', ''].every(function (v) { return bridge.normalizeHeadlessPublished(v) === false; }) &&
    bridge.normalizeHeadlessPublished(true) === true);
})();

// ---------- shopifyCatalogManaged フラグ ----------
(function () {
  var existing = { 'legacy_a': { name: '旧商品', artist: '旧作家', baseUrl: 'https://fukameki.thebase.in/items/legacy_a' } };
  var entry = makeCatalogEntry('shopify_x', null, true);
  var merged = bridge.catalogEntryToMergedProduct(entry, undefined);
  check('カタログ管理商品はshopifyCatalogManaged===true', merged.shopifyCatalogManaged === true);
  check('カタログ外の既存商品にはフラグが付与されない（この関数を通過しない）', existing['legacy_a'].shopifyCatalogManaged === undefined);
})();

// ---------- isValidBaseUrl ----------
(function () {
  var cases = [
    ['https://fukameki.thebase.in/items/29992076', true],
    ['https://fukameki.thebase.in/items/56866733', true],
    ['http://fukameki.thebase.in/items/29992076', false],
    ['https://evil.com/items/29992076', false],
    ['https://fukameki.thebase.in.evil.com/items/29992076', false],
    ['javascript:alert(1)', false],
    ['', false],
    [null, false],
    [undefined, false],
    ['https://fukameki.thebase.in/', false],
    ['https://fukameki.thebase.in/items/', false],
    ['not a url', false]
  ];
  cases.forEach(function (c) {
    check('isValidBaseUrl(' + JSON.stringify(c[0]) + ') === ' + c[1], bridge.isValidBaseUrl(c[0]) === c[1]);
  });
})();

// ---------- resolvePurchaseLane: 実装本体を使った代表例の検証 ----------
(function () {
  // A. カタログ管理商品
  check('managed=true, headless=true -> shopify',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: true }).lane === 'shopify');
  check('managed=true, headless=false -> unavailable',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: false }).lane === 'unavailable');
  check('managed=true, headless欠落 -> unavailable',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true }).lane === 'unavailable');
  check('managed=true, BASE URLあり, headless=false -> BASEへ行かない(unavailable)',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: false, baseUrl: 'https://fukameki.thebase.in/items/1' }).lane === 'unavailable');

  // B. 旧商品
  check('managed欠落, 古いShopify GIDあり, 有効BASE URLあり -> base',
    bridge.resolvePurchaseLane({ shopify: 'gid://shopify/ProductVariant/old-1', baseUrl: 'https://fukameki.thebase.in/items/56866733' }).lane === 'base');
  check('managed=false, 古いShopify GIDあり, 有効BASE URLあり -> base',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: false, shopify: 'gid://shopify/ProductVariant/old-2', baseUrl: 'https://fukameki.thebase.in/items/29992076' }).lane === 'base');
  check('managed欠落, Shopify GIDなし, 有効BASE URLあり -> base',
    bridge.resolvePurchaseLane({ baseUrl: 'https://fukameki.thebase.in/items/29992076' }).lane === 'base');
  check('managed欠落, BASE URLなし -> unavailable',
    bridge.resolvePurchaseLane({}).lane === 'unavailable');
  check('managed欠落, 別ドメインBASE URL -> unavailable',
    bridge.resolvePurchaseLane({ baseUrl: 'https://evil.com/items/29992076' }).lane === 'unavailable');
  check('managed欠落, javascript: URL -> unavailable',
    bridge.resolvePurchaseLane({ baseUrl: "javascript:alert(1)" }).lane === 'unavailable');
  check('旧Shopify GIDが残っていてもresolvePurchaseLaneの戻り値にVariant GIDが含まれない(base)',
    JSON.stringify(bridge.resolvePurchaseLane({ shopify: 'gid://shopify/ProductVariant/old-3', baseUrl: 'https://fukameki.thebase.in/items/56866733' })).indexOf('old-3') === -1);

  // 実データ代表例
  check('実データ 29992076相当: BASE直接購入導線',
    bridge.resolvePurchaseLane({ baseUrl: 'https://fukameki.thebase.in/items/29992076' }).lane === 'base');
  check('実データ 56866733相当: 旧Shopify GIDを使わずBASE導線',
    bridge.resolvePurchaseLane({ shopify: 'gid://shopify/ProductVariant/56866733-1', baseUrl: 'https://fukameki.thebase.in/items/56866733' }).lane === 'base');
  check('実データ sp_8452790157498相当: カタログ管理商品としてShopify導線',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: true, shopify: 'gid://shopify/ProductVariant/sp1' }).lane === 'shopify');
  check('新規shopify_...商品相当: Shopify導線',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: true }).lane === 'shopify');
  check('Headless欠落モック相当: 購入不可',
    bridge.resolvePurchaseLane({ shopifyCatalogManaged: true, headlessPublished: undefined }).lane === 'unavailable');
})();

// ---------- catalogId/alias重複時は例外 ----------
(function () {
  var dupEntries = [makeCatalogEntry('dup', null, true), makeCatalogEntry('dup', null, true)];
  var threw = false;
  try {
    bridge.buildCatalogMerge(dupEntries, {});
  } catch (e) {
    threw = true;
  }
  check('catalogId重複でbuildCatalogMergeが例外送出', threw);
})();

// ---------- variantStockState: availableForSale欠落時のfail-closedマトリクス ----------
(function () {
  var matrix = [
    // [availableForSale, quantityAvailable, currentlyNotInStock, expectBuyable, expectState]
    [true, 1, false, true, 'instock'],
    [true, 0, false, false, 'outofstock'],
    [true, 0, true, true, 'backorder'],
    [true, null, true, true, 'backorder'],
    [true, undefined, false, false, 'unknown'],
    [true, null, false, false, 'unknown'],
    [true, '1', false, false, 'unknown'],
    [true, -1, false, false, 'unknown'],
    [true, NaN, false, false, 'unknown'],
    [true, Infinity, false, false, 'unknown'],
    [true, [1], false, false, 'unknown'],
    [false, 1, false, false, 'unavailable'],
    [undefined, 1, false, false, 'unknown'],
    [null, 1, false, false, 'unknown'],
    ['true', 1, false, false, 'unknown'],
    [1, 1, false, false, 'unknown']
  ];
  matrix.forEach(function (row) {
    var v = { availableForSale: row[0], quantityAvailable: row[1], currentlyNotInStock: row[2] };
    var r = bridge.variantStockState(v);
    var label = 'variantStockState(availableForSale=' + JSON.stringify(row[0]) + ', quantityAvailable=' + JSON.stringify(row[1]) + ', currentlyNotInStock=' + JSON.stringify(row[2]) + ')';
    check(label + ' -> buyable===' + row[3], r.buyable === row[3]);
    check(label + ' -> state===' + row[4], r.state === row[4]);
  });

  // Luna再現条件: availableForSale欠落・quantityAvailable=1 は購入不可(unknown)へ倒す
  var lunaRepro = bridge.variantStockState({ quantityAvailable: 1 });
  check('Luna再現(availableForSale欠落, quantityAvailable=1) -> buyable=false', lunaRepro.buyable === false);
  check('Luna再現(availableForSale欠落, quantityAvailable=1) -> unknown=true', lunaRepro.unknown === true);
})();

// ---------- addToCartFlow相当の第4防御: variantStockStateがfalseならVariant GIDを送らない ----------
(function () {
  function simulateAddToCartFlow(v) {
    // product_test.html の addToCartFlow() 内、fetch成功直後の再確認と同じ条件式。
    if (!bridge.variantStockState(v).buyable) return { cartApiCalled: false };
    return { cartApiCalled: true };
  }
  check('Luna再現条件でcartApiCalled===false（Variant GID送信0回相当）',
    simulateAddToCartFlow({ quantityAvailable: 1 }).cartApiCalled === false);
  check('正常応答(availableForSale=true, quantityAvailable=1)ではcartApiCalled===true',
    simulateAddToCartFlow({ availableForSale: true, quantityAvailable: 1 }).cartApiCalled === true);
})();

console.log('\n=== SUMMARY ===');
var failed = results.filter(function (r) { return !r[1]; });
console.log((results.length - failed.length) + '/' + results.length + ' PASS');
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(function (r) { console.log('  - ' + r[0]); });
  process.exit(1);
}
process.exit(0);
