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

console.log('\n=== SUMMARY ===');
var failed = results.filter(function (r) { return !r[1]; });
console.log((results.length - failed.length) + '/' + results.length + ' PASS');
if (failed.length) {
  console.log('FAILED:');
  failed.forEach(function (r) { console.log('  - ' + r[0]); });
  process.exit(1);
}
process.exit(0);
