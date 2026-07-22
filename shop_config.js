/* =====================================================
   ARC FUKAMEKI — Shopify Storefront GraphQL Cart API 連携（テストページ専用）
   Storefrontの公開アクセストークンのみを扱う（Admin APIトークンは絶対に置かない）。
   ponytail: JS Buy SDK は2026年開設ストアの旧Checkout API前提で動かないため廃止。
   Cart API を fetch で直接叩く（外部SDK依存なし）。
   カートは Shopify の cart オブジェクトをそのまま真実源とし、
   localStorage には cart id のみを保持する。
   ===================================================== */
window.SHOP_CONFIG = {
  domain: 'vh55x1-pa.myshopify.com',
  storefrontAccessToken: '21acdc860f5b978a395b0e1e387aef0e',
  apiVersion: '2026-01'
};

(function () {
  'use strict';

  var style = document.createElement('style');
  style.textContent =
    '.cart-row{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:.8rem;padding:1.1rem 0;border-bottom:1px solid var(--line);}' +
    '.cart-row:first-child{border-top:1px solid var(--line);}' +
    '.c-name{font-size:.82rem;letter-spacing:.05em;font-weight:300;line-height:1.6;}' +
    '.c-qty{display:flex;align-items:center;gap:.5rem;}' +
    '.c-qty-btn{font-family:var(--en);font-size:.95rem;color:var(--ash);border:1px solid var(--line);width:22px;height:22px;line-height:1;padding:0;}' +
    '.c-qty-btn:hover{color:var(--bone);border-color:var(--ash);}' +
    '.c-qty-num{font-family:var(--en);font-size:.85rem;min-width:1.2em;text-align:center;}' +
    '.c-price{font-family:var(--en);font-weight:300;font-size:.85rem;letter-spacing:.06em;white-space:nowrap;}' +
    '.c-remove{font-family:var(--en);font-size:1rem;color:var(--ash);padding:0 .2rem;}' +
    '.c-remove:hover{color:var(--bone);}' +
    '.cart-message{font-size:.72rem;line-height:1.7;letter-spacing:.03em;padding:.8rem 1rem;margin:0 0 .8rem;border:1px solid rgba(181,71,58,.4);background:rgba(181,71,58,.06);color:#8a3a30;}';
  document.head.appendChild(style);

  var CART_KEY = 'arc_cart_id';
  var cartOpenBtn = document.getElementById('cartOpen');
  var cartCloseBtn = document.getElementById('cartClose');
  var cartDrawer = document.getElementById('cartDrawer');
  var cartScrim = document.getElementById('cartScrim');
  var cartItemsEl = document.getElementById('cartItems');
  var cartCountEl = document.getElementById('cartCount');
  var cartSubtotalEl = document.getElementById('cartSubtotal');
  var cartCheckoutBtn = document.getElementById('cartCheckout');
  var cartMessageEl = document.getElementById('cartMessage');
  var cartNoteEl = document.getElementById('cartNote');

  if (!cartDrawer || !cartOpenBtn) return; // このページにカートUIが無ければ何もしない

  if (cartNoteEl) {
    cartNoteEl.innerHTML = 'Shopifyによる安全な決済。在庫の最終確定はチェックアウト時にShopify側で行われます。<br>' +
      'Secure checkout by Shopify. Final stock availability is confirmed by Shopify at checkout.';
  }

  /* ---------- 多言語対応（指示書22追記） ----------
     lang.js の LANG_TRANSLATIONS[lang] を参照。arc_lang の現在値に基づき都度翻訳する。 */
  var SHOP_MESSAGE_FALLBACKS = {
    shop_sold_out_other: 'Sold out due to other orders.',
    shop_stock_adjusted: 'Quantity adjusted due to stock changes.'
  };
  function currentLang() {
    try { return localStorage.getItem('arc_lang') || 'ja'; } catch (e) { return 'ja'; }
  }
  function t(key, fallback) {
    var dict = window.LANG_TRANSLATIONS && window.LANG_TRANSLATIONS[currentLang()];
    return (dict && dict[key]) || fallback || key;
  }

  var lastMessageKey = null;
  function showCartMessage(key) {
    if (!cartMessageEl) return;
    lastMessageKey = key;
    if (!key) { cartMessageEl.style.display = 'none'; cartMessageEl.textContent = ''; return; }
    cartMessageEl.textContent = t(key, SHOP_MESSAGE_FALLBACKS[key]);
    cartMessageEl.style.display = '';
  }

  function warningsToKey(warnings) {
    if (!warnings || !warnings.length) return null;
    var hasOutOfStock = warnings.some(function (w) { return w.code === 'MERCHANDISE_OUT_OF_STOCK'; });
    var hasNotEnough = warnings.some(function (w) { return w.code === 'MERCHANDISE_NOT_ENOUGH_STOCK'; });
    if (hasOutOfStock) return 'shop_sold_out_other';
    if (hasNotEnough) return 'shop_stock_adjusted';
    return null;
  }

  // setLang() 実行時に、既に表示中のカートメッセージ／商品ページ側の在庫UIを再翻訳する。
  // lang.js 本体は変更せず、window.setLang をラップして再描画フックを追加する。
  if (typeof window.setLang === 'function' && !window.setLang.__shopWrapped) {
    var _origSetLang = window.setLang;
    window.setLang = function (lang) {
      _origSetLang(lang);
      if (lastMessageKey) showCartMessage(lastMessageKey);
      if (typeof window.onShopLangChange === 'function') window.onShopLangChange();
    };
    window.setLang.__shopWrapped = true;
  }

  /* ---------- 開閉（全ページ共通） ---------- */
  function setCart(open) {
    cartDrawer.classList.toggle('open', open);
    if (cartScrim) cartScrim.classList.toggle('open', open);
    cartOpenBtn.setAttribute('aria-expanded', String(open));
    if (open) { if (cartCloseBtn) cartCloseBtn.focus(); } else { cartOpenBtn.focus(); }
  }
  cartOpenBtn.addEventListener('click', function () { setCart(true); });
  if (cartCloseBtn) cartCloseBtn.addEventListener('click', function () { setCart(false); });
  if (cartScrim) cartScrim.addEventListener('click', function () { setCart(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && cartDrawer.classList.contains('open')) setCart(false);
  });

  /* ---------- 商品ページ等の「準備中」フォールバック表示 ---------- */
  function disableCommerce() {
    cartOpenBtn.disabled = true;
    if (cartCheckoutBtn) cartCheckoutBtn.disabled = true;
    if (cartItemsEl) cartItemsEl.innerHTML = '<p class="cart-empty">オンライン購入は現在準備中です — お問合せください。<br>Online purchase is temporarily unavailable — please contact us.</p>';
    document.querySelectorAll('[data-shop-add]').forEach(function (btn) {
      btn.disabled = true;
      btn.textContent = 'オンライン購入は準備中です';
    });
  }

  /* ---------- Storefront GraphQL ---------- */
  var ENDPOINT = 'https://' + window.SHOP_CONFIG.domain + '/api/' + window.SHOP_CONFIG.apiVersion + '/graphql.json';
  var CART_FIELDS =
    'id checkoutUrl totalQuantity cost{subtotalAmount{amount}} ' +
    'lines(first:50){edges{node{ id quantity cost{totalAmount{amount}} ' +
    'merchandise{... on ProductVariant{ id title product{title} } } }}}';
  var RESULT_ERRORS = 'userErrors{code field message} warnings{code message target}';

  function gql(query, variables) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': window.SHOP_CONFIG.storefrontAccessToken
      },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (res) { return res.json(); }).then(function (json) {
      if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
      return json.data;
    });
  }

  // userErrors は致命的失敗（throw）、warnings は非致命的（在庫調整等）— 呼び出し元に両方伝える
  function extractResult(payload, field) {
    var node = payload && payload[field];
    var userErrors = (node && node.userErrors) || [];
    if (userErrors.length) {
      var err = new Error(userErrors[0].message);
      err.userErrors = userErrors;
      throw err;
    }
    return { cart: node.cart, warnings: (node && node.warnings) || [] };
  }

  function createCart() {
    var query = 'mutation { cartCreate { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query).then(function (data) {
      var r = extractResult(data, 'cartCreate');
      saveCartId(r.cart.id);
      return r;
    });
  }
  function fetchCart(id) {
    var query = 'query($id: ID!) { cart(id: $id) { ' + CART_FIELDS + ' } }';
    return gql(query, { id: id }).then(function (data) { return data.cart; });
  }
  function addLine(cartId, merchandiseId, qty) {
    var query = 'mutation($id: ID!, $lines: [CartLineInput!]!) {' +
      ' cartLinesAdd(cartId: $id, lines: $lines) { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query, { id: cartId, lines: [{ merchandiseId: merchandiseId, quantity: qty }] })
      .then(function (data) { return extractResult(data, 'cartLinesAdd'); });
  }
  function updateLine(cartId, lineId, qty) {
    var query = 'mutation($id: ID!, $lines: [CartLineUpdateInput!]!) {' +
      ' cartLinesUpdate(cartId: $id, lines: $lines) { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query, { id: cartId, lines: [{ id: lineId, quantity: qty }] })
      .then(function (data) { return extractResult(data, 'cartLinesUpdate'); });
  }
  function removeLine(cartId, lineId) {
    var query = 'mutation($id: ID!, $lineIds: [ID!]!) {' +
      ' cartLinesRemove(cartId: $id, lineIds: $lineIds) { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query, { id: cartId, lineIds: [lineId] })
      .then(function (data) { return extractResult(data, 'cartLinesRemove'); });
  }

  var cart = null;

  function yen(amount) {
    return '¥' + Math.round(Number(amount)).toLocaleString('ja-JP');
  }
  function saveCartId(id) {
    try { localStorage.setItem(CART_KEY, id); } catch (e) {}
  }
  function loadCartId() {
    try { return localStorage.getItem(CART_KEY); } catch (e) { return null; }
  }

  function getOrCreateCart() {
    if (cart) return Promise.resolve(cart);
    var existing = loadCartId();
    if (!existing) return createCart().then(function (r) { cart = r.cart; return cart; });
    return fetchCart(existing).then(function (c) {
      if (c) { cart = c; return c; }
      return createCart().then(function (r) { cart = r.cart; return cart; });
    }).catch(function () {
      return createCart().then(function (r) { cart = r.cart; return cart; });
    });
  }

  function renderCart() {
    if (!cart) return;
    var edges = (cart.lines && cart.lines.edges) || [];
    cartCountEl.textContent = cart.totalQuantity || 0;
    cartSubtotalEl.textContent = yen(cart.cost && cart.cost.subtotalAmount && cart.cost.subtotalAmount.amount || 0);
    cartItemsEl.innerHTML = '';
    if (!edges.length) {
      cartItemsEl.innerHTML = '<p class="cart-empty">かごは空です — Your cart is empty.</p>';
      return;
    }
    edges.forEach(function (edge) {
      var line = edge.node;
      var merch = line.merchandise || {};
      var row = document.createElement('div');
      row.className = 'cart-row';
      var name = document.createElement('p');
      name.className = 'c-name';
      var variantTitle = merch.title && merch.title !== 'Default Title' ? ' — ' + merch.title : '';
      name.textContent = (merch.product && merch.product.title || '') + variantTitle;
      var qty = document.createElement('div');
      qty.className = 'c-qty';
      var minus = document.createElement('button');
      minus.type = 'button'; minus.className = 'c-qty-btn'; minus.textContent = '−';
      minus.setAttribute('aria-label', '数量を減らす');
      var qtyNum = document.createElement('span');
      qtyNum.className = 'c-qty-num';
      qtyNum.textContent = line.quantity;
      var plus = document.createElement('button');
      plus.type = 'button'; plus.className = 'c-qty-btn'; plus.textContent = '+';
      plus.setAttribute('aria-label', '数量を増やす');
      qty.appendChild(minus); qty.appendChild(qtyNum); qty.appendChild(plus);
      var price = document.createElement('p');
      price.className = 'c-price';
      price.textContent = yen(line.cost && line.cost.totalAmount && line.cost.totalAmount.amount || 0);
      var rm = document.createElement('button');
      rm.className = 'c-remove'; rm.type = 'button'; rm.textContent = '×';
      rm.setAttribute('aria-label', (merch.product && merch.product.title || '') + ' をかごから外す');

      minus.addEventListener('click', function () {
        if (line.quantity <= 1) { doRemove(line.id); return; }
        doUpdate(line.id, line.quantity - 1);
      });
      plus.addEventListener('click', function () { doUpdate(line.id, line.quantity + 1); });
      rm.addEventListener('click', function () { doRemove(line.id); });

      row.appendChild(name); row.appendChild(qty); row.appendChild(price); row.appendChild(rm);
      cartItemsEl.appendChild(row);
    });
  }

  function doUpdate(lineId, quantity) {
    return getOrCreateCart().then(function (c) {
      return updateLine(c.id, lineId, quantity);
    }).then(function (r) {
      cart = r.cart;
      renderCart();
      showCartMessage(warningsToKey(r.warnings));
    }).catch(disableCommerce);
  }
  function doRemove(lineId) {
    return getOrCreateCart().then(function (c) {
      return removeLine(c.id, lineId);
    }).then(function (r) {
      cart = r.cart;
      renderCart();
      showCartMessage(warningsToKey(r.warnings));
    }).catch(disableCommerce);
  }

  window.ShopCart = {
    // 成功時は {cart, warnings} を返す。呼び出し元は「追加できた」ことと「数量が調整された可能性」を区別できる
    add: function (merchandiseId, qty) {
      return getOrCreateCart().then(function (c) {
        return addLine(c.id, merchandiseId, qty || 1);
      }).then(function (r) {
        cart = r.cart;
        renderCart();
        setCart(true);
        showCartMessage(warningsToKey(r.warnings));
        return r;
      });
    },
    open: function () { setCart(true); },
    showMessage: showCartMessage,
    t: t,
    currentLang: currentLang
  };

  if (cartCheckoutBtn) {
    cartCheckoutBtn.addEventListener('click', function () {
      if (cart && cart.checkoutUrl) window.location.href = cart.checkoutUrl;
    });
  }

  getOrCreateCart().then(renderCart).catch(function () {
    disableCommerce();
  });
})();
