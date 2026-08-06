/* =====================================================
   ARC FUKAMEKI — Shopify UNLISTED商品カタログをテストページへ合成する（テストページ専用）。
   products_catalog.generated.js（自動生成・手編集禁止）を正本として、
   window.PRODUCTS_DATA へ実行時にマージする（products_data.js 自体は書き換えない）。
   商品一覧（products_test.html）の対象は、生成カタログの132商品「だけ」に限定する。
   PRODUCTS_DATA からは何も削除しない（カタログ外の既存商品は直接URLアクセス・
   BASEフォールバックとも維持される）。

   ブラウザ・Node.js（回帰テスト）の両方から同一ロジックを呼べるよう、
   純粋関数として切り出している（副作用は末尾の適用処理のみ）。
   ===================================================== */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  }
  if (root) {
    // product_test.html 側から isValidBaseUrl 等の純粋関数を再利用できるよう公開する。
    root.ShopifyCatalogBridge = mod;
  }
  if (root && root.SHOPIFY_CATALOG && root.PRODUCTS_DATA) {
    mod.applyToWindow(root);
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  // Shopify側でこの店の商品はほぼ全件が同一の汎用vendor値のため、
  // vendor=作家名という前提が成立しない。この値のときだけタイトル先頭の作家名らしき部分を
  // 「作家別タブ用の分類値（artistLabel）」として補助的に使う。
  // 重要: artistLabel は分類・補助表示専用であり、商品タイトル（shopifyTitle/name）を
  // 上書きするためには一切使わない。抽出に確信がなくてもタイトル自体は削らない。
  var GENERIC_VENDORS = ['マイストア', 'ARC FUKAMEKI minoh'];

  function artistLabelFromVendorOrTitle(vendor, title) {
    if (vendor && GENERIC_VENDORS.indexOf(vendor) === -1) return vendor;
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

  // headlessPublished は fail-closed: 厳密に boolean true の場合のみ true。
  // false/undefined/null/0/1/文字列/フィールドなし等はすべて false（購入不可）として扱う。
  function normalizeHeadlessPublished(value) {
    return value === true;
  }

  // BASEリンクとして使用してよいURLかを安全側に限定する。
  // https固定・ホスト名固定・パス形式固定。javascript: 等の危険URL・別ドメイン・
  // 空文字・不正URLはすべて拒否する（購入導線を出さない側に倒す）。
  var BASE_HOST = 'fukameki.thebase.in';
  var BASE_PATH_RE = /^\/items\/[A-Za-z0-9_-]+$/;

  function isValidBaseUrl(url) {
    if (!url || typeof url !== 'string') return false;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== BASE_HOST) return false;
    if (!BASE_PATH_RE.test(parsed.pathname)) return false;
    return true;
  }

  function catalogEntryToMergedProduct(entry, existing) {
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
    // Headless未公開（true以外すべて）の商品は、ブラウザ側でも購入操作を一切許可しない
    // （生成物改変・異常値混入時の防御。fail-closed）。
    merged.headlessPublished = normalizeHeadlessPublished(entry.headlessPublished);
    // このフラグが true の商品のみ「Shopify生成カタログ管理商品」として扱う。
    // カタログ外の既存商品にはこの関数自体が実行されないため、このフラグは付与されない。
    merged.shopifyCatalogManaged = true;
    // 全バリエーションが購入不可の場合のみ soldout 扱いとする。
    // 一覧から消すのではなく「販売不能」表示を継続するため、getProductStatus()による
    // グリッド非表示（soldout除外）の対象にはせず、カード側のavailableForSale再取得で
    // 販売不能ラベルを付与する（batchCheckAvailability()が data-shopify-gid を検知して処理）。
    merged.soldout = false;
    merged.shopifyAllVariantsUnavailable = allUnavailable;
    return merged;
  }

  /**
   * catalogProducts（SHOPIFY_CATALOG.products）を productsData（PRODUCTS_DATA、既存参照。
   * この関数自体は引数を変更せず、更新後の新オブジェクトを返す）へ合成する。
   * 戻り値:
   *   - mergedProductsData: 全既存キー + カタログ全キーを含むオブジェクト（削除は一切行わない）
   *   - testPageOrder: カタログ132件「だけ」からなる商品一覧用の順序配列（product_<key>.html形式）
   */
  function buildCatalogMerge(catalogProducts, productsData) {
    var mergedProductsData = Object.assign({}, productsData || {});
    var testPageOrder = [];
    var seenKeys = {};

    catalogProducts.forEach(function (entry) {
      var key = entry.existingAlias || entry.catalogId;
      if (seenKeys[key]) {
        throw new Error('shopify_catalog_bridge: catalogId/alias が重複しています: ' + key);
      }
      seenKeys[key] = true;
      var existing = productsData ? productsData[key] : undefined;
      mergedProductsData[key] = catalogEntryToMergedProduct(entry, existing);
      testPageOrder.push('product_' + key + '.html');
    });

    return { mergedProductsData: mergedProductsData, testPageOrder: testPageOrder };
  }

  function applyToWindow(win) {
    if (!win.SHOPIFY_CATALOG || !win.PRODUCTS_DATA) return;
    var result = buildCatalogMerge(win.SHOPIFY_CATALOG.products, win.PRODUCTS_DATA);
    win.PRODUCTS_DATA = result.mergedProductsData;
    // 商品一覧（products_test.html）の対象は、生成カタログ132件「だけ」に限定する。
    // カタログ外の既存商品は PRODUCTS_DATA には残るため、直接URLアクセス・BASEフォールバックは
    // 引き続き機能する（一覧からは除外されるだけ）。
    win.PRODUCTS_ORDER = result.testPageOrder;
  }

  /**
   * 商品詳細ページの購入導線を一箇所で判定する（実装本体・ブラウザ/Node共用）。
   *   A. shopifyCatalogManaged===true の商品:
   *        headlessPublished===true のときだけ 'shopify'。それ以外は 'unavailable'
   *        （BASEへは絶対にフォールバックしない）。
   *   B. カタログ外の旧商品（shopifyCatalogManaged!==true）:
   *        有効なBASE URLがあれば 'base'。なければ 'unavailable'
   *        （古いShopify GIDが残っていてもHeadless状態が不明なため一切使用しない）。
   */
  function resolvePurchaseLane(p) {
    if (p && p.shopifyCatalogManaged === true) {
      if (p.headlessPublished === true) return { lane: 'shopify' };
      return { lane: 'unavailable' };
    }
    if (p && isValidBaseUrl(p.baseUrl)) return { lane: 'base', baseUrl: p.baseUrl };
    return { lane: 'unavailable' };
  }

  return {
    artistLabelFromVendorOrTitle: artistLabelFromVendorOrTitle,
    minPrice: minPrice,
    stripTags: stripTags,
    normalizeHeadlessPublished: normalizeHeadlessPublished,
    isValidBaseUrl: isValidBaseUrl,
    resolvePurchaseLane: resolvePurchaseLane,
    catalogEntryToMergedProduct: catalogEntryToMergedProduct,
    buildCatalogMerge: buildCatalogMerge,
    applyToWindow: applyToWindow
  };
});
