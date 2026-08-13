/* =====================================================
   ARC FUKAMEKI — Shopify Storefront GraphQL Cart API 連携（テストページ専用）
   Storefrontの公開アクセストークンのみを扱う（Admin APIトークンは絶対に置かない）。
   ponytail: JS Buy SDK は2026年開設ストアの旧Checkout API前提で動かないため廃止。
   Cart API を fetch で直接叩く（外部SDK依存なし）。
   カートは Shopify の cart オブジェクトをそのまま真実源とし、
   localStorage には cart id のみを保持する。
   ===================================================== */
// Node（回帰テスト）から require() してもエラーにならないよう window が無い環境ではglobalへ。
// ブラウザでの挙動は従来通り window.SHOP_CONFIG のまま。
(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this)).SHOP_CONFIG = {
  domain: 'vh55x1-pa.myshopify.com',
  storefrontAccessToken: '21acdc860f5b978a395b0e1e387aef0e',
  apiVersion: '2026-01'
};

/* =====================================================
   ご注文備考（カートnote）の保存キュー — DOM非依存の純粋ロジック。
   ブラウザ・Node回帰テストの両方から同一実装を呼べるようUMD形式で公開する
   （shopify_catalog_bridge.js と同じ方針。テスト側で判定を再実装しない）。
   ===================================================== */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.CartNoteLogic = mod;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  function truncateNoteInput(value, maxLen) {
    var s = (value === null || value === undefined) ? '' : String(value);
    var truncated = s.length > maxLen;
    return { value: truncated ? s.slice(0, maxLen) : s, truncated: truncated };
  }

  /**
   * 単一飛行（single-flight）+ 最新優先（latest-wins）の保存キュー。
   * 常に「直近の入力値」だけが最終的にサーバーへ送られることを保証する:
   *   - 保存中に再編集された場合、完了後に最新値で追加保存する（古い応答による上書きを防ぐ）
   *   - 同時に複数回保存要求しても、実際のリクエストは同時に1本だけ飛ぶ
   * opts.save(value) は Promise<{ note: string }> を返す関数（呼び出し側がGraphQL Mutationを実行する）。
   */
  function createNoteSaver(opts) {
    opts = opts || {};
    var save = opts.save;
    var onStatus = opts.onStatus || function () {};
    var current = '';
    var lastSaved = '';
    var inFlight = null;
    var dirty = false;

    function reset(value) {
      current = value || '';
      lastSaved = current;
      dirty = false;
      inFlight = null;
    }

    function setValue(value) {
      current = value;
    }

    function runSave() {
      if (inFlight) { dirty = true; return inFlight; }
      if (current === lastSaved) return Promise.resolve({ note: lastSaved, skipped: true });
      var valueToSave = current;
      dirty = false;
      onStatus('saving');
      inFlight = save(valueToSave).then(function (result) {
        inFlight = null;
        // save()の応答を厳格に検証する。result.noteがstringでvalueToSaveと完全一致する
        // 場合だけ保存成功として扱う。入力値(valueToSave)を保存結果の代用にしない
        // ——応答が壊れている/期待と異なる場合は「保存できたかどうか分からない」ため、
        // fail-closedでlastSavedを更新せず失敗として扱う。
        if (!result || typeof result !== 'object' ||
            typeof result.note !== 'string' || result.note !== valueToSave) {
          throw new Error('Unexpected save() result: note does not match saved value');
        }
        lastSaved = result.note;
        if (dirty) return runSave();
        onStatus('saved');
        return result;
      }).catch(function (err) {
        inFlight = null;
        onStatus('error');
        throw err;
      });
      return inFlight;
    }

    function getState() {
      return { current: current, lastSaved: lastSaved, dirty: dirty, saving: !!inFlight };
    }

    return {
      reset: reset,
      setValue: setValue,
      // debounceは呼び出し側(setTimeout)の責務。runSave()は「今すぐ保存を試みる」実体。
      runSave: runSave,
      flush: runSave,
      getState: getState
    };
  }

  /**
   * HTTP応答を確認したうえでGraphQL実行する共通本体。ブラウザ(fetch)・Nodeテスト(モック)の
   * 両方から同じ判定を通す（テスト側で判定を再実装しない）。
   * - res.ok !== true は本文の内容にかかわらず失敗として扱う（HTTP 200台以外を成功扱いにしない）
   * - res.ok === true でも本文が無い/JSON解析できない場合（HTTP 204等）はres.json()の失敗でreject
   * - レスポンス本文やトークンはconsoleへ出さない
   */
  function performGraphQL(fetchImpl, endpoint, token, query, variables) {
    return fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token
      },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (res) {
      if (!res || res.ok !== true) {
        var httpErr = new Error('Shopify API request failed');
        httpErr.httpStatus = res && res.status;
        throw httpErr;
      }
      return res.json();
    }).then(function (json) {
      if (json && json.errors && json.errors.length) throw new Error(json.errors[0].message);
      return json && json.data;
    });
  }

  /**
   * Cartを返すMutation共通のfail-closed抽出。cartCreate/cartLinesAdd/cartLinesUpdate/
   * cartLinesRemove/cartNoteUpdate はいずれも成功時にCartオブジェクトを返す前提のため、
   * mutation nodeの欠落・cart欠落・cart.id欠落はすべて失敗として扱う。
   */
  function extractMutationCart(payload, field) {
    var node = payload && payload[field];
    if (!node || typeof node !== 'object') {
      throw new Error('Unexpected response: missing ' + field + ' result');
    }
    var userErrors = node.userErrors || [];
    if (userErrors.length) {
      var err = new Error(userErrors[0].message);
      err.userErrors = userErrors;
      throw err;
    }
    var cart = node.cart;
    if (!cart || typeof cart !== 'object' || !cart.id) {
      throw new Error('Unexpected response: missing cart in ' + field + ' result');
    }
    return { cart: cart, warnings: node.warnings || [] };
  }

  /**
   * cartNoteUpdate専用の追加検証。extractMutationCartを通過した後、さらに:
   * - 返却Cart IDが更新対象と一致すること
   * - noteフィールドが応答内に存在すること（欠落とnull:nullは区別する）
   * - 非空文字を送った場合は同一文字列の返却を必須とする
   * - 空文字を送った場合のみ null/空文字どちらも成功扱いにしてよい
   * を満たさない限り成功と認めない。入力値を成功結果として代用するフォールバックは行わない。
   */
  function validateNoteUpdateCart(cart, expectedCartId, sentNote) {
    if (!cart || cart.id !== expectedCartId) {
      throw new Error('cartNoteUpdate returned a different or missing cart id');
    }
    if (!Object.prototype.hasOwnProperty.call(cart, 'note')) {
      throw new Error('cartNoteUpdate response missing note field');
    }
    var returnedNote = cart.note;
    var matches = (returnedNote === sentNote) ||
      (sentNote === '' && (returnedNote === null || returnedNote === ''));
    if (!matches) {
      throw new Error('cartNoteUpdate returned note does not match saved value');
    }
    return (typeof returnedNote === 'string') ? returnedNote : '';
  }

  return {
    truncateNoteInput: truncateNoteInput,
    createNoteSaver: createNoteSaver,
    performGraphQL: performGraphQL,
    extractMutationCart: extractMutationCart,
    validateNoteUpdateCart: validateNoteUpdateCart
  };
});

/* =====================================================
   カート在庫再確認・Checkout安全停止（Phase 6-B F-01） — 純粋関数のみ。
   ブラウザ・Node回帰テストの両方から同一実装を呼ぶ（CartNoteLogicと同じ方針）。
   入力値から成功状態を推測するフォールバックは行わない — 判定できない場合は
   常にUNKNOWN（Checkout不可）へ倒す。
   ===================================================== */
(function (root, factory) {
  var mod = factory();
  // module.exportsを丸ごと差し替えず、既存のCartNoteLogicのexportへ合流させる
  // （同一ファイル内に複数のUMDモジュールがあるため、後勝ちで上書きしない）。
  if (typeof module === 'object' && module.exports) {
    if (module.exports && typeof module.exports === 'object') {
      for (var k in mod) { module.exports[k] = mod[k]; }
    } else {
      module.exports = mod;
    }
  }
  if (root) root.CartInventoryGuard = mod;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * Cart line 1件のVariant在庫状態を判定する。
   * status: AVAILABLE / BACKORDER_ALLOWED / SOLD_OUT / NOT_ENOUGH_STOCK / UNKNOWN
   */
  function lineInventoryStatus(line) {
    var lineId = (line && typeof line === 'object' && line.id) || null;
    var quantity = line && line.quantity;
    var merch = line && line.merchandise;
    var merchandiseId = (merch && typeof merch === 'object' && merch.id) || null;
    var productTitle = (merch && merch.product && merch.product.title) || null;
    var variantTitle = (merch && merch.title) || null;
    var requestedQuantity = isFiniteNumber(quantity) ? quantity : null;

    function unknown(availableQuantity) {
      return {
        lineId: lineId, merchandiseId: merchandiseId, productTitle: productTitle,
        variantTitle: variantTitle, requestedQuantity: requestedQuantity,
        availableQuantity: (availableQuantity === undefined) ? null : availableQuantity,
        status: 'UNKNOWN'
      };
    }

    if (!line || typeof line !== 'object' || !lineId) return unknown();
    if (!isFiniteNumber(quantity) || quantity <= 0) return unknown();
    if (!merch || typeof merch !== 'object' || !merchandiseId) return unknown();

    var availableForSale = merch.availableForSale;
    var currentlyNotInStock = merch.currentlyNotInStock;
    var quantityAvailable = merch.quantityAvailable;
    var qtyKnown = isFiniteNumber(quantityAvailable) && quantityAvailable >= 0;

    if (availableForSale === true && currentlyNotInStock === true) {
      return {
        lineId: lineId, merchandiseId: merchandiseId, productTitle: productTitle,
        variantTitle: variantTitle, requestedQuantity: requestedQuantity,
        availableQuantity: qtyKnown ? quantityAvailable : null,
        status: 'BACKORDER_ALLOWED'
      };
    }
    if (availableForSale !== true) {
      return {
        lineId: lineId, merchandiseId: merchandiseId, productTitle: productTitle,
        variantTitle: variantTitle, requestedQuantity: requestedQuantity,
        availableQuantity: qtyKnown ? quantityAvailable : null,
        status: 'SOLD_OUT'
      };
    }
    // ここでは availableForSale === true かつ currentlyNotInStock !== true
    if (!qtyKnown) return unknown();
    if (requestedQuantity > quantityAvailable) {
      return {
        lineId: lineId, merchandiseId: merchandiseId, productTitle: productTitle,
        variantTitle: variantTitle, requestedQuantity: requestedQuantity,
        availableQuantity: quantityAvailable, status: 'NOT_ENOUGH_STOCK'
      };
    }
    return {
      lineId: lineId, merchandiseId: merchandiseId, productTitle: productTitle,
      variantTitle: variantTitle, requestedQuantity: requestedQuantity,
      availableQuantity: quantityAvailable, status: 'AVAILABLE'
    };
  }

  /**
   * Cart全体を検証し、Checkoutへ進んでよいかを判定する純粋関数。
   * ok===true となるのは、空でないCartの全行がAVAILABLEまたはBACKORDER_ALLOWEDの場合のみ。
   * code: OK / CART_MISSING / LINES_MISSING / EMPTY_CART / SOLD_OUT / NOT_ENOUGH_STOCK / UNKNOWN_STOCK
   */
  function validateCartInventoryForCheckout(cart) {
    if (!cart || typeof cart !== 'object') {
      return { ok: false, code: 'CART_MISSING', issues: [] };
    }
    var edges = cart.lines && cart.lines.edges;
    if (!Array.isArray(edges)) {
      return { ok: false, code: 'LINES_MISSING', issues: [] };
    }
    if (edges.length === 0) {
      return { ok: false, code: 'EMPTY_CART', issues: [] };
    }
    var issues = edges.map(function (edge) { return lineInventoryStatus(edge && edge.node); });
    var blocking = issues.filter(function (i) { return i.status !== 'AVAILABLE' && i.status !== 'BACKORDER_ALLOWED'; });
    if (!blocking.length) {
      return { ok: true, code: 'OK', issues: issues };
    }
    var code = blocking.some(function (i) { return i.status === 'SOLD_OUT'; }) ? 'SOLD_OUT'
      : blocking.some(function (i) { return i.status === 'NOT_ENOUGH_STOCK'; }) ? 'NOT_ENOUGH_STOCK'
      : 'UNKNOWN_STOCK';
    return { ok: false, code: code, issues: issues };
  }

  /**
   * fetchCart()応答の厳格検証。cart欠落／id不一致／lines.edgesが配列でない／
   * （requireCheckoutUrl指定時）checkoutUrl欠落はすべてthrowする。
   * 呼び出し元でrejectとして扱う（成功を推測しない）。
   */
  function assertValidFetchedCart(cart, expectedCartId, opts) {
    opts = opts || {};
    if (!cart || typeof cart !== 'object' || !cart.id) {
      throw new Error('Cart missing or malformed');
    }
    if (expectedCartId && cart.id !== expectedCartId) {
      throw new Error('Cart id mismatch');
    }
    if (!cart.lines || !Array.isArray(cart.lines.edges)) {
      throw new Error('Cart lines missing or malformed');
    }
    if (opts.requireCheckoutUrl && !cart.checkoutUrl) {
      throw new Error('Cart checkoutUrl missing');
    }
    return cart;
  }

  /**
   * Checkout直前の最終判定（純粋関数）。fetchCartで既に厳格検証済みのCartを受け取り、
   * 「NAVIGATE（遷移してよい）」か「BLOCK（遷移禁止、理由あり）」かだけを返す。
   * window.location等の副作用は一切持たない — 呼び出し元（ブラウザUI）が実際の遷移を行う。
   */
  function planCheckoutTransition(freshCart, expectedCartId) {
    if (!freshCart || freshCart.id !== expectedCartId) {
      return { action: 'BLOCK', code: 'CART_ID_MISMATCH', issues: [] };
    }
    var inv = validateCartInventoryForCheckout(freshCart);
    if (!inv.ok) {
      return { action: 'BLOCK', code: inv.code, issues: inv.issues };
    }
    if (!freshCart.checkoutUrl) {
      return { action: 'BLOCK', code: 'CHECKOUT_URL_MISSING', issues: inv.issues };
    }
    return { action: 'NAVIGATE', url: freshCart.checkoutUrl, issues: inv.issues };
  }

  /**
   * Cart mutationのwarningsを、対象のCart line IDへ厳密一致でのみ紐付ける（純粋関数）。
   * target欠落・未知target（現在のCartに存在しないline id）は個別行へ割り当てず、
   * generalWarningCode（Cart全体の警告）として扱う。不明なtargetを別商品へ推測で
   * 割り当てない。対象コードは MERCHANDISE_OUT_OF_STOCK / MERCHANDISE_NOT_ENOUGH_STOCK のみ
   * （MERCHANDISE_NOT_APPLICABLEはCartErrorCode側であり、ここでは扱わない）。
   */
  function matchWarningsToLines(warnings, cart) {
    var byLine = {};
    var generalWarningCode = null;
    var edges = (cart && cart.lines && cart.lines.edges) || [];
    (warnings || []).forEach(function (w) {
      if (!w || (w.code !== 'MERCHANDISE_OUT_OF_STOCK' && w.code !== 'MERCHANDISE_NOT_ENOUGH_STOCK')) return;
      var matchedLineId = null;
      if (w.target) {
        edges.forEach(function (e) { if (e && e.node && e.node.id === w.target) matchedLineId = e.node.id; });
      }
      if (matchedLineId) { byLine[matchedLineId] = w.code; }
      else { generalWarningCode = w.code; }
    });
    return { byLine: byLine, generalWarningCode: generalWarningCode };
  }

  return {
    lineInventoryStatus: lineInventoryStatus,
    validateCartInventoryForCheckout: validateCartInventoryForCheckout,
    assertValidFetchedCart: assertValidFetchedCart,
    planCheckoutTransition: planCheckoutTransition,
    matchWarningsToLines: matchWarningsToLines
  };
});

// 以降はブラウザのカートUI本体（DOM必須）。Node（回帰テスト）でrequire()した際は
// document が無いため実行しない — CartNoteLogicのexportだけを取得できればよい。
if (typeof document !== 'undefined') {
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
    '.cart-message{font-size:.72rem;line-height:1.7;letter-spacing:.03em;padding:.8rem 1rem;margin:0 0 .8rem;border:1px solid rgba(181,71,58,.4);background:rgba(181,71,58,.06);color:#8a3a30;}' +
    '.cart-order-note{margin-top:1.6rem;padding-top:1.4rem;border-top:1px solid var(--line);}' +
    '.cart-order-note-label{display:block;font-size:.7rem;letter-spacing:.1em;color:var(--sumi);margin-bottom:.5rem;}' +
    '.cart-order-note-hint{font-size:.62rem;line-height:1.7;letter-spacing:.03em;color:var(--hai);margin:0 0 .6rem;}' +
    '.cart-order-note-textarea{width:100%;min-height:4.5em;resize:vertical;font:inherit;font-size:.78rem;line-height:1.7;letter-spacing:.02em;padding:.6rem .7rem;border:1px solid var(--line);background:var(--washi);color:var(--sumi);box-sizing:border-box;}' +
    '.cart-order-note-textarea:focus-visible{outline:1px solid var(--sumi);outline-offset:1px;}' +
    '.cart-order-note-status{display:flex;justify-content:space-between;align-items:baseline;font-size:.62rem;letter-spacing:.05em;color:var(--hai);margin-top:.4rem;gap:.6rem;}' +
    '.cart-order-note-state{white-space:nowrap;}' +
    '.cart-order-note-state.is-error{color:#8a3a30;}' +
    '.cart-row-warning{border-bottom-color:rgba(181,71,58,.4);}' +
    '.c-row-warning{grid-column:1/-1;font-size:.68rem;line-height:1.6;letter-spacing:.02em;color:#8a3a30;margin:.3rem 0 0;}' +
    '.cart-stock-notice{font-size:.68rem;line-height:1.7;letter-spacing:.02em;color:var(--hai);margin:0 0 .8rem;}';
  document.head.appendChild(style);

  var CART_KEY = 'arc_cart_id';
  var NOTE_MAX_LEN = 500;
  var NOTE_DEBOUNCE_MS = 600;
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
  var cartOrderNoteEl = document.getElementById('cartOrderNote');
  var cartOrderNoteCountEl = document.getElementById('cartOrderNoteCount');
  var cartOrderNoteStatusEl = document.getElementById('cartOrderNoteStatus');

  if (!cartDrawer || !cartOpenBtn) return; // このページにカートUIが無ければ何もしない

  /* ---------- 多言語対応（指示書22追記） ----------
     lang.js の LANG_TRANSLATIONS[lang] を参照。arc_lang の現在値に基づき都度翻訳する。 */
  var SHOP_MESSAGE_FALLBACKS = {
    shop_sold_out_other: 'Sold out due to other orders.',
    shop_stock_adjusted: 'Quantity adjusted due to stock changes.',
    cart_note_checkout_save_failed: 'Could not save your order note. Please try again before checking out.',
    cart_stock_no_reservation_notice: 'Items are not reserved when added to your cart. Orders are confirmed in the order payment is completed.',
    cart_stock_insufficient_notice: 'Stock has changed and this quantity is no longer available. Please reduce the quantity or remove the item from your cart.',
    cart_stock_sold_out_notice: 'This item is sold out. Please remove it from your cart.',
    cart_stock_check_failed_checkout: 'We could not confirm current stock. Checkout has been paused; please try again shortly.'
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

  // 「カートに入れただけでは在庫は確保されない」注意書き（3言語、指示書F-01 §7）。
  // 既存のShopifyによる安全な決済の注記に加えて表示する。
  function renderStockNotice() {
    if (!cartNoteEl) return;
    cartNoteEl.textContent = t('cart_stock_no_reservation_notice',
      'Items are not reserved when added to your cart. Orders are confirmed in the order payment is completed.');
  }
  renderStockNotice();

  // setLang() 実行時に、既に表示中のカートメッセージ／商品ページ側の在庫UIを再翻訳する。
  // lang.js 本体は変更せず、window.setLang をラップして再描画フックを追加する。
  if (typeof window.setLang === 'function' && !window.setLang.__shopWrapped) {
    var _origSetLang = window.setLang;
    window.setLang = function (lang) {
      _origSetLang(lang);
      renderStockNotice();
      if (lastMessageKey) showCartMessage(lastMessageKey);
      // ご注文備考の状態表示（保存中/保存済み等）だけ再翻訳する。入力済みの本文は一切変更しない。
      if (noteSaver && cartOrderNoteStatusEl && !cartOrderNoteStatusEl.__toolong) {
        var st = noteSaver.getState();
        renderNoteStatus(st.saving ? 'saving' : (st.current === st.lastSaved ? 'saved' : null));
      }
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
    // かごを閉じる際（×ボタン／背景クリック／Esc、いずれもこの関数を通る）、
    // 未保存のご注文備考があれば保存しておく（正本はShopify Cart側のnote）。
    // 失敗してもunhandledrejection・console errorにしない（runBackgroundNoteSave内でcatch済み）。
    if (!open && noteSaver) { flushNoteDebounce(); runBackgroundNoteSave(); }
  }
  if (cartCloseBtn) cartCloseBtn.addEventListener('click', function () { setCart(false); });
  if (cartScrim) cartScrim.addEventListener('click', function () { setCart(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && cartDrawer.classList.contains('open')) setCart(false);
  });

  /* ---------- Checkoutボタンのdisabled状態を一箇所で管理する ----------
     自動保存中／Checkout処理中／disableCommerce後／カート再取得中／再取得失敗／
     在庫未確認、という複数の理由が競合して互いのdisabled解除を上書きしないよう、
     理由ごとのフラグからdisabled値を毎回再計算する
     （直接 cartCheckoutBtn.disabled に代入する箇所を増やさない）。
     commerceDisabled は一度trueになったら絶対にfalseへ戻さない。
     lastInventoryResult は「まだ在庫検証していない」状態をnullで区別し、
     検証前はCheckoutを許可しない（fail-closed）。 */
  var commerceDisabled = false;
  var checkoutInProgress = false;
  var noteAutoSaveBusy = false;
  var cartRefreshBusy = false;
  var cartRefreshFailed = false;
  var lastInventoryResult = null;
  function recomputeCheckoutBtn() {
    if (!cartCheckoutBtn) return;
    var inventoryOk = !!(lastInventoryResult && lastInventoryResult.ok === true);
    cartCheckoutBtn.disabled = commerceDisabled || checkoutInProgress || noteAutoSaveBusy ||
      cartRefreshBusy || cartRefreshFailed || !inventoryOk;
  }

  /* ---------- 商品ページ等の「準備中」フォールバック表示 ---------- */
  function disableCommerce() {
    commerceDisabled = true;
    cartOpenBtn.disabled = true;
    recomputeCheckoutBtn();
    if (cartItemsEl) cartItemsEl.innerHTML = '<p class="cart-empty">オンライン購入は現在準備中です — お問合せください。<br>Online purchase is temporarily unavailable — please contact us.</p>';
    document.querySelectorAll('[data-shop-add]').forEach(function (btn) {
      btn.disabled = true;
      btn.textContent = 'オンライン購入は準備中です';
    });
  }

  /* ---------- Storefront GraphQL ---------- */
  var ENDPOINT = 'https://' + window.SHOP_CONFIG.domain + '/api/' + window.SHOP_CONFIG.apiVersion + '/graphql.json';
  var CART_FIELDS =
    'id checkoutUrl totalQuantity note cost{subtotalAmount{amount}} ' +
    'lines(first:50){edges{node{ id quantity cost{totalAmount{amount}} ' +
    'merchandise{... on ProductVariant{ id title availableForSale quantityAvailable currentlyNotInStock product{title} } } }}}';
  var RESULT_ERRORS = 'userErrors{code field message} warnings{code message target}';

  function gql(query, variables) {
    return window.CartNoteLogic.performGraphQL(fetch, ENDPOINT, window.SHOP_CONFIG.storefrontAccessToken, query, variables);
  }

  // userErrors は致命的失敗（throw）、warnings は非致命的（在庫調整等）— 呼び出し元に両方伝える
  // Cart欠落・mutation node欠落はfail-closed（CartNoteLogic.extractMutationCartに実装本体あり）
  function extractResult(payload, field) {
    return window.CartNoteLogic.extractMutationCart(payload, field);
  }

  function createCart() {
    var query = 'mutation { cartCreate { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query).then(function (data) {
      var r = extractResult(data, 'cartCreate');
      saveCartId(r.cart.id);
      return r;
    });
  }
  function fetchCart(id, opts) {
    var query = 'query($id: ID!) { cart(id: $id) { ' + CART_FIELDS + ' } }';
    return gql(query, { id: id }).then(function (data) {
      return window.CartInventoryGuard.assertValidFetchedCart(data && data.cart, id, opts);
    });
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
  // 注文メモ（Shopify Cart の note）。GraphQL変数として送信し、クエリ文字列へは連結しない。
  // 通常のcart mutation共通のfail-closed（extractResult）に加え、cartNoteUpdate専用の
  // Cart ID一致・note一致検証（CartNoteLogic.validateNoteUpdateCart）を必ず通す。
  // 入力値を成功結果として代用するフォールバックは行わない。
  function updateNote(cartId, note) {
    var query = 'mutation($cartId: ID!, $note: String!) {' +
      ' cartNoteUpdate(cartId: $cartId, note: $note) { cart { ' + CART_FIELDS + ' } ' + RESULT_ERRORS + ' } }';
    return gql(query, { cartId: cartId, note: note })
      .then(function (data) {
        var r = extractResult(data, 'cartNoteUpdate');
        var validatedNote = window.CartNoteLogic.validateNoteUpdateCart(r.cart, cartId, note);
        return { cart: r.cart, warnings: r.warnings, note: validatedNote };
      });
  }

  var cart = null;
  var noteCartId = null;

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
    if (!existing) return createCart().then(function (r) { setCartRef(r.cart); return cart; });
    return fetchCart(existing).then(function (c) {
      if (c) { setCartRef(c); return c; }
      return createCart().then(function (r) { setCartRef(r.cart); return cart; });
    }).catch(function () {
      return createCart().then(function (r) { setCartRef(r.cart); return cart; });
    });
  }

  // cartを差し替えるたびに呼ぶ唯一の入口。カートIDが変わった場合（期限切れ→新規カート等）
  // だけご注文備考をShopify Cartのnoteから再同期し、古いCartのメモを引き継がない。
  // 同一カートIDの間はローカルの入力内容を正本として保持し、他の操作（数量変更等）で上書きしない。
  function setCartRef(c) {
    cart = c;
    if (!cart || !noteSaver) return;
    if (cart.id !== noteCartId) {
      noteCartId = cart.id;
      noteSaver.reset(cart.note || '');
      renderNoteUI();
    }
  }

  /* ---------- 在庫判定結果・warning target の行への紐付け ----------
     商品を黙って自動削除・自動置換・数量変更しない。対象行を明示し、
     購入者自身に数量変更または削除をしてもらう。色だけに依存せずテキストで示す。 */
  var ROW_STATUS_KEYS = {
    SOLD_OUT: ['cart_stock_sold_out_notice', 'この商品は売り切れました。カートから削除してください。'],
    NOT_ENOUGH_STOCK: ['cart_stock_insufficient_notice', '在庫が変動したため、この数量では購入できません。数量を変更するか、商品をカートから削除してください。'],
    UNKNOWN: ['cart_stock_check_failed_checkout', '在庫を確認できませんでした。チェックアウトには進まず、時間をおいて再度お試しください。']
  };

  var lastWarningsByLine = {};
  var lastGeneralWarningCode = null;
  // targetと現在のCart line IDが完全一致した場合だけ対象行へ紐付ける（実体は
  // CartInventoryGuard.matchWarningsToLines — テスト側と同一実装を通す）。
  function applyWarnings(warnings, cartForMatching) {
    var r = window.CartInventoryGuard.matchWarningsToLines(warnings, cartForMatching);
    lastWarningsByLine = r.byLine;
    lastGeneralWarningCode = r.generalWarningCode;
  }

  function updateInventoryState(c) {
    lastInventoryResult = window.CartInventoryGuard.validateCartInventoryForCheckout(c);
  }

  function bannerKeyForState() {
    if (lastInventoryResult && lastInventoryResult.ok === false) {
      if (lastInventoryResult.code === 'SOLD_OUT') return 'cart_stock_sold_out_notice';
      if (lastInventoryResult.code === 'NOT_ENOUGH_STOCK') return 'cart_stock_insufficient_notice';
      if (lastInventoryResult.code === 'EMPTY_CART') return null;
      return 'cart_stock_check_failed_checkout'; // CART_MISSING / LINES_MISSING / UNKNOWN_STOCK
    }
    if (lastGeneralWarningCode === 'MERCHANDISE_OUT_OF_STOCK') return 'cart_stock_sold_out_notice';
    if (lastGeneralWarningCode === 'MERCHANDISE_NOT_ENOUGH_STOCK') return 'cart_stock_insufficient_notice';
    return null;
  }

  function renderCart(adjustedLineIds) {
    adjustedLineIds = adjustedLineIds || {};
    if (!cart) return;
    var edges = (cart.lines && cart.lines.edges) || [];
    cartCountEl.textContent = cart.totalQuantity || 0;
    cartSubtotalEl.textContent = yen(cart.cost && cart.cost.subtotalAmount && cart.cost.subtotalAmount.amount || 0);
    cartItemsEl.innerHTML = '';
    if (!edges.length) {
      cartItemsEl.innerHTML = '<p class="cart-empty">かごは空です — Your cart is empty.</p>';
      return;
    }
    var issuesByLine = {};
    if (lastInventoryResult && Array.isArray(lastInventoryResult.issues)) {
      lastInventoryResult.issues.forEach(function (i) { if (i.lineId) issuesByLine[i.lineId] = i; });
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

      // 対象行の在庫問題を明示する（色だけに依存しない：アイコン＋テキスト）。
      // 自動削除・自動数量変更・自動置換は行わない — 購入者自身の操作を促すのみ。
      var issue = issuesByLine[line.id];
      var rowWarningKey = null;
      var rowWarningFallback = null;
      if (issue && (issue.status === 'SOLD_OUT' || issue.status === 'NOT_ENOUGH_STOCK' || issue.status === 'UNKNOWN')) {
        var entry = ROW_STATUS_KEYS[issue.status];
        rowWarningKey = entry[0];
        rowWarningFallback = entry[1];
        if (issue.status === 'NOT_ENOUGH_STOCK' && adjustedLineIds[line.id]) {
          rowWarningKey = 'shop_stock_adjusted';
          rowWarningFallback = SHOP_MESSAGE_FALLBACKS.shop_stock_adjusted;
        }
      } else if (lastWarningsByLine[line.id]) {
        var isOutOfStock = lastWarningsByLine[line.id] === 'MERCHANDISE_OUT_OF_STOCK';
        var wEntry = ROW_STATUS_KEYS[isOutOfStock ? 'SOLD_OUT' : 'NOT_ENOUGH_STOCK'];
        rowWarningKey = wEntry[0];
        rowWarningFallback = wEntry[1];
      }
      if (rowWarningKey) {
        row.classList.add('cart-row-warning');
        var note = document.createElement('p');
        note.className = 'c-row-warning';
        note.textContent = '⚠ ' + t(rowWarningKey, rowWarningFallback);
        row.appendChild(note);
      }

      cartItemsEl.appendChild(row);
    });
  }

  function doUpdate(lineId, quantity) {
    var prevRequested = {}; prevRequested[lineId] = quantity;
    return getOrCreateCart().then(function (c) {
      return updateLine(c.id, lineId, quantity);
    }).then(function (r) {
      applyWarnings(r.warnings, r.cart);
      setCartRef(r.cart);
      updateInventoryState(r.cart);
      var adjusted = {};
      (r.cart.lines && r.cart.lines.edges || []).forEach(function (e) {
        var lid = e.node && e.node.id;
        if (lid && prevRequested[lid] !== undefined && prevRequested[lid] !== e.node.quantity) adjusted[lid] = true;
      });
      renderCart(adjusted);
      recomputeCheckoutBtn();
      showCartMessage(bannerKeyForState());
    }).catch(disableCommerce);
  }
  function doRemove(lineId) {
    return getOrCreateCart().then(function (c) {
      return removeLine(c.id, lineId);
    }).then(function (r) {
      applyWarnings(r.warnings, r.cart);
      setCartRef(r.cart);
      updateInventoryState(r.cart);
      renderCart();
      recomputeCheckoutBtn();
      showCartMessage(bannerKeyForState());
    }).catch(disableCommerce);
  }

  window.ShopCart = {
    // 成功時は {cart, warnings} を返す。呼び出し元は「追加できた」ことと「数量が調整された可能性」を区別できる
    add: function (merchandiseId, qty) {
      return getOrCreateCart().then(function (c) {
        return addLine(c.id, merchandiseId, qty || 1);
      }).then(function (r) {
        applyWarnings(r.warnings, r.cart);
        setCartRef(r.cart);
        updateInventoryState(r.cart);
        renderCart();
        setCart(true);
        recomputeCheckoutBtn();
        showCartMessage(bannerKeyForState());
        return r;
      });
    },
    open: function () { setCart(true); },
    showMessage: showCartMessage,
    t: t,
    currentLang: currentLang
  };

  /* ---------- カートを開くたびのCart再取得（Phase 6-B F-01） ----------
     1. Drawerを開く 2. Checkoutボタンを一時無効化 3. 最新Cartを再取得
     4. 成功時のみCart参照を更新して再描画 5. 在庫判定を再実行
     6. 成功時にCheckout無効を解除 7. 失敗時は古い表示を購入可能と扱わず、
        Checkoutを停止して再試行案内。
     多重クリック・並行取得で古い応答が新しい応答を上書きしないよう、
     request sequence（cartOpenRefreshSeq）で最新の呼び出しだけを反映する。
     一時的な取得失敗はcommerceDisabledを永久trueにしない — 次回の再取得成功で復旧できる。
     既存Cartが取得不能な場合、ここで新しいCartを自動作成しない（cartがまだ無い初回のみ
     getOrCreateCart経由で作成する。既存の実装済み挙動を維持）。 */
  var cartOpenRefreshSeq = 0;
  function refreshCartOnOpen() {
    var mySeq = ++cartOpenRefreshSeq;
    cartRefreshBusy = true;
    recomputeCheckoutBtn();
    var p = cart ? fetchCart(cart.id, { requireCheckoutUrl: true }) : getOrCreateCart();
    return p.then(function (c) {
      if (mySeq !== cartOpenRefreshSeq) return; // 古い応答は無視（single-flight/最新優先）
      cartRefreshFailed = false;
      applyWarnings([], c); // 開き直した時点でtargetに紐づく前回warningの表示は失効させる
      setCartRef(c);
      updateInventoryState(c);
      renderCart();
      cartRefreshBusy = false;
      recomputeCheckoutBtn();
      showCartMessage(bannerKeyForState());
    }).catch(function () {
      if (mySeq !== cartOpenRefreshSeq) return;
      cartRefreshBusy = false;
      cartRefreshFailed = true;
      recomputeCheckoutBtn();
      showCartMessage('cart_stock_check_failed_checkout');
    });
  }
  cartOpenBtn.addEventListener('click', function () {
    setCart(true);
    refreshCartOnOpen();
  });

  /* ---------- ご注文備考（カートnote） ---------- */
  var NOTE_STATUS_KEYS = {
    saving: ['cart_note_saving', '保存中…'],
    saved: ['cart_note_saved', '保存済み'],
    error: ['cart_note_save_failed', '保存に失敗しました']
  };
  var noteTooLongTimer = null;

  function renderNoteStatus(status) {
    // 自動保存中はCheckoutボタンを無効化する（バックグラウンド保存・Checkout直前の保存いずれも同じ
    // noteSaverを経由するため、ここで一元的にnoteAutoSaveBusyを更新する）。
    noteAutoSaveBusy = (status === 'saving');
    recomputeCheckoutBtn();
    if (!cartOrderNoteStatusEl) return;
    if (cartOrderNoteStatusEl.__toolong) return; // 「文字数超過」表示中は上書きしない（タイマーで自動的に戻す）
    cartOrderNoteStatusEl.classList.toggle('is-error', status === 'error');
    if (!status) { cartOrderNoteStatusEl.textContent = ''; return; }
    var entry = NOTE_STATUS_KEYS[status];
    cartOrderNoteStatusEl.textContent = entry ? t(entry[0], entry[1]) : '';
  }

  var noteSaver = window.CartNoteLogic.createNoteSaver({
    save: function (value) {
      return getOrCreateCart().then(function (c) {
        return updateNote(c.id, value);
      }).then(function (r) {
        // note更新はライン内容を変えないため cart 全体は setCartRef を通さず反映のみ行う
        // （noteCartIdは既に一致しているのでsetCartRefを呼んでも実害はないが、意図を明確にする）
        // r.note は updateNote() 内で Cart ID一致・note一致まで検証済みの値
        // （入力値へのフォールバックは行わない — 未検証の値を保存済み扱いにしないため）。
        cart = r.cart;
        return { note: r.note };
      });
    },
    onStatus: renderNoteStatus
  });

  function renderNoteUI() {
    if (!cartOrderNoteEl) return;
    var state = noteSaver.getState();
    if (document.activeElement !== cartOrderNoteEl) cartOrderNoteEl.value = state.current;
    if (cartOrderNoteCountEl) cartOrderNoteCountEl.textContent = state.current.length + '/' + NOTE_MAX_LEN;
    renderNoteStatus(state.saving ? 'saving' : (state.current === state.lastSaved ? 'saved' : null));
  }

  // バックグラウンド保存（自動保存・かごを閉じる際のフラッシュ）はここでcatchする。
  // 失敗はrenderNoteStatus('error')で既に画面表示済みなので、ここでは
  // unhandledrejection・console errorを発生させないよう握り潰すだけでよい
  // （入力内容はnoteSaver内部のcurrentに残るため次回保存時に自動的に再試行される）。
  // Checkout直前の保存だけはこの関数を使わず、呼び出し元で個別にcatchして遷移を阻止する。
  function runBackgroundNoteSave() {
    return noteSaver.runSave().catch(function () {});
  }

  var noteDebounceTimer = null;
  function scheduleNoteDebounce() {
    if (noteDebounceTimer) clearTimeout(noteDebounceTimer);
    noteDebounceTimer = setTimeout(function () {
      noteDebounceTimer = null;
      runBackgroundNoteSave();
    }, NOTE_DEBOUNCE_MS);
  }
  function flushNoteDebounce() {
    if (noteDebounceTimer) { clearTimeout(noteDebounceTimer); noteDebounceTimer = null; }
  }

  if (cartOrderNoteEl) {
    cartOrderNoteEl.addEventListener('input', function () {
      var res = window.CartNoteLogic.truncateNoteInput(cartOrderNoteEl.value, NOTE_MAX_LEN);
      if (res.truncated) {
        cartOrderNoteEl.value = res.value;
        if (cartOrderNoteStatusEl) {
          cartOrderNoteStatusEl.__toolong = true;
          cartOrderNoteStatusEl.classList.remove('is-error');
          cartOrderNoteStatusEl.textContent = t('cart_note_too_long', '500文字を超える内容は保存されません');
          if (noteTooLongTimer) clearTimeout(noteTooLongTimer);
          noteTooLongTimer = setTimeout(function () {
            cartOrderNoteStatusEl.__toolong = false;
            var st = noteSaver.getState();
            renderNoteStatus(st.saving ? 'saving' : (st.current === st.lastSaved ? 'saved' : null));
          }, 2000);
        }
      }
      noteSaver.setValue(res.value);
      if (cartOrderNoteCountEl) cartOrderNoteCountEl.textContent = res.value.length + '/' + NOTE_MAX_LEN;
      scheduleNoteDebounce();
    });
  }

  /* ---------- Checkout直前処理（Phase 6-B F-01） ----------
     1. checkoutInProgressで二重クリック防止 2. 注文備考のdebounceを停止
     3. 未保存の注文備考をShopifyへ保存 4. 保存結果のCart ID・note一致を既存ロジックで検証
        （updateNote内のvalidateNoteUpdateCartで実施済み）
     5. 同じCart IDを最新取得 6. Cart ID・lines・Variant在庫を検証
     7. 最新Cartを再描画 8. 在庫判定が全件可の場合のみ最新checkoutUrlへ遷移。
     note保存失敗／Cart再取得失敗／在庫確認不能／売切れ／数量不足／Cart ID不一致／
     checkoutUrl欠落／空Cartのいずれも遷移を禁止する。失敗時はDrawerを開いたままにし、
     入力済み注文備考を消さず、対象商品と理由を表示する。console error・unhandled
     rejectionを発生させないよう、ここで必ずcatchする。 */
  if (cartCheckoutBtn) {
    cartCheckoutBtn.addEventListener('click', function () {
      if (checkoutInProgress || commerceDisabled) return; // 二重クリック防止／準備中は絶対に進めない
      if (!cart) return;
      checkoutInProgress = true;
      recomputeCheckoutBtn();
      flushNoteDebounce();
      var cartIdAtStart = cart.id;

      Promise.resolve(noteSaver.runSave())
        .catch(function (err) {
          err = err || new Error('note save failed');
          err.__checkoutPhase = 'note';
          throw err;
        })
        .then(function () {
          // 直前に保存したCartと同じIDを最新取得する（新しいCartは自動作成しない）。
          return fetchCart(cartIdAtStart, { requireCheckoutUrl: true });
        })
        .then(function (freshCart) {
          applyWarnings([], freshCart); // Checkout直前再取得はwarningsを伴わない。前回分は失効させる
          setCartRef(freshCart);
          updateInventoryState(freshCart); // renderCart()での行表示用に判定を保持する
          renderCart();
          var plan = window.CartInventoryGuard.planCheckoutTransition(freshCart, cartIdAtStart);
          checkoutInProgress = false;
          if (plan.action !== 'NAVIGATE') {
            recomputeCheckoutBtn();
            showCartMessage(bannerKeyForState());
            return;
          }
          checkoutInProgress = true; // 遷移するため無効状態を維持する
          window.location.href = plan.url;
        })
        .catch(function (err) {
          // note保存失敗、Cart再取得失敗（HTTP非2xx／JSON不正／GraphQL errors／Cart欠落／
          // Cart ID不一致／lines欠落／checkoutUrl欠落）のいずれもここに到達する。
          // 入力済み注文備考は消さない。Drawerも開いたままにする。
          checkoutInProgress = false;
          recomputeCheckoutBtn();
          showCartMessage(err && err.__checkoutPhase === 'note'
            ? 'cart_note_checkout_save_failed' : 'cart_stock_check_failed_checkout');
        });
    });
  }

  getOrCreateCart().then(function (c) {
    updateInventoryState(c);
    renderCart();
    renderNoteUI();
  }).catch(function () {
    disableCommerce();
  });
})();
}
