/* =====================================================
   ARC FUKAMEKI — Shopify UNLISTED商品カタログをテストページへ合成する（テストページ専用）。
   products_catalog.generated.js（自動生成・手編集禁止）を正本として、
   window.PRODUCTS_DATA / window.PRODUCTS_ORDER へ実行時にマージする。
   products_data.js 自体は書き換えない（メモリ上のオブジェクトへの追加・上書きのみ）。
   ===================================================== */
(function () {
  'use strict';

  if (!window.SHOPIFY_CATALOG || !window.PRODUCTS_DATA) return;

  // Shopify側でこの店の商品はほぼ全件が同一の汎用vendor値のため、
  // vendor=作家名という前提が成立しない。この値のときだけタイトル先頭の作家名らしき部分を
  // 「作家別タブ用の分類値（artistLabel）」として補助的に使う。
  // 重要: artistLabel は分類・補助表示専用であり、商品タイトル（shopifyTitle/name）を
  // 上書きするためには一切使わない。抽出に確信がなくてもタイトル自体は削らない。
  var GENERIC_VENDORS = ['マイストア', 'ARC FUKAMEKI minoh'];

  function artistLabelFromVendorOrTitle(vendor, title) {
    if (vendor && GENERIC_VENDORS.indexOf(vendor) === -1) return vendor;
    // 汎用vendorの場合のみ、タイトル先頭の作家名らしき部分を暫定値として抽出する。
    var m = title.match(/^([^\s　]+)[\s　]+(.+)$/);
    return m ? m[1] : title;
  }

  function minPrice(variants) {
    var prices = variants.map(function (v) { return parseFloat(v.price); }).filter(function (n) { return !isNaN(n); });
    if (!prices.length) return 0;
    return Math.min.apply(null, prices);
  }

  function stripTags(html) {
    return String(html || '').replace(/<[^>]*>/g, '').trim();
  }

  var newOrderEntries = [];

  window.SHOPIFY_CATALOG.products.forEach(function (entry) {
    var key = entry.existingAlias || entry.catalogId;
    var existing = window.PRODUCTS_DATA[key];
    var vendor = entry.vendor;
    var shopifyTitle = entry.shopifyTitle || entry.name;

    var artistLabel = artistLabelFromVendorOrTitle(vendor, shopifyTitle);
    var category = existing && existing.category ? existing.category : entry.productType;

    var allUnavailable = entry.variants.every(function (v) { return v.availableForSale === false; });

    var merged = existing ? Object.assign({}, existing) : {};
    // 商品タイトルはShopifyを正本とし、既存HPのnameでは一切上書きしない。
    merged.shopifyTitle = shopifyTitle;
    merged.name = shopifyTitle;
    // artistLabel は作家別分類・補助表示専用。商品タイトルには影響しない。
    merged.artistLabel = artistLabel;
    merged.artist = artistLabel;
    merged.category = category;
    merged.price = '¥' + Math.round(minPrice(entry.variants)).toLocaleString('ja-JP');
    merged.description = stripTags(entry.descriptionHtml);
    merged.descriptionHtml = entry.descriptionHtml;
    merged.img = entry.images[0] || (existing ? existing.img : '');
    merged.images = entry.images.slice(1);
    merged.baseUrl = existing ? existing.baseUrl : '';
    merged.shopify = entry.representativeVariantGid;
    // Headless未公開の商品はブラウザ側でも購入操作を一切許可しない（生成物改変・異常時の防御）。
    merged.headlessPublished = entry.headlessPublished === true;
    // 全バリエーションが購入不可の場合のみ soldout 扱いとする。
    // 一覧から消すのではなく「販売不能」表示を継続するため、getProductStatus()による
    // グリッド非表示（soldout除外）の対象にはせず、カード側のavailableForSale再取得で
    // 販売不能ラベルを付与する（batchCheckAvailability()が data-shopify-gid を検知して処理）。
    merged.soldout = false;
    merged.shopifyAllVariantsUnavailable = allUnavailable;

    window.PRODUCTS_DATA[key] = merged;

    if (!existing) {
      newOrderEntries.push('product_' + key + '.html');
    }
  });

  if (window.PRODUCTS_ORDER) {
    var existingSet = {};
    window.PRODUCTS_ORDER.forEach(function (f) { existingSet[f] = true; });
    var toAdd = newOrderEntries.filter(function (f) { return !existingSet[f]; });
    window.PRODUCTS_ORDER = toAdd.concat(window.PRODUCTS_ORDER);
  }
})();
