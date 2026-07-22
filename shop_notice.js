/* =====================================================
   ARC FUKAMEKI — オンラインショップ入場時の注意事項確認モーダル（テストページ専用）
   本文は日本語を正本とし、店主承認なしに英語・中文へ自動翻訳・確定しない。
   UIラベル（見出し・ボタン等）のみ lang.js 経由で JA/EN/中文に対応する。
   公開ID確認中も背景操作を禁止するため、オーバーレイは公開ID取得より前に構築・表示する。
   ===================================================== */
(function () {
  'use strict';

  // 旧方式のキー（arc_shop_notice_ack_v1）は新方式では確認済みとして扱わない。読み込みも行わない。
  var ACK_RELEASE_KEY = 'arc_shop_notice_ack_release_v1';

  function readLS(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function scriptTagReleaseId() {
    return (typeof window.SHOP_NOTICE_RELEASE_ID === 'string' && window.SHOP_NOTICE_RELEASE_ID) ? window.SHOP_NOTICE_RELEASE_ID : null;
  }

  // shop_notice_release.js を cache:'no-store' で再取得し、キャッシュによる古い公開IDの残留を避ける。
  // 取得できない場合は <script src> 経由で既に読み込まれている値にフォールバックする。
  function currentReleaseId(callback) {
    if (!window.fetch) { callback(scriptTagReleaseId()); return; }
    fetch('shop_notice_release.js', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('bad status');
      return r.text();
    }).then(function (text) {
      var m = text.match(/SHOP_NOTICE_RELEASE_ID\s*=\s*['"]([^'"]+)['"]/);
      callback(m ? m[1] : scriptTagReleaseId());
    }).catch(function () {
      callback(scriptTagReleaseId());
    });
  }

  function t(key, fallback) {
    var lang = 'ja';
    try { lang = localStorage.getItem('arc_lang') || 'ja'; } catch (e) {}
    var dict = window.LANG_TRANSLATIONS && window.LANG_TRANSLATIONS[lang];
    return (dict && dict[key]) || fallback || key;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function bullets(lines) {
    return '<ul>' + lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
  }
  function heading(text) {
    return '<p class="shop-notice-h">' + esc(text) + '</p>';
  }

  var PAGE1_HTML =
    bullets([
      'この度は当店のオンライン販売にお付き合いをくださいまして誠にありがとうございます。',
      'ご利用にあたりましてお願い事を記させて頂きます。',
      'ご注文はこちらの明記内容をご了承いただけているものとさせて頂きます。'
    ]) +
    heading('発送につきまして') +
    bullets([
      '発送はご注文日より一週間頂戴いたします。',
      '順次対応させて頂きます。',
      '着日のご指定はお受けできません。',
      'いつ頃となるかも前後しますためお伝え出来かねます。',
      'ご了承頂けます場合にご注文をお願い致します。',
      '別注文を頂いた後での同梱は発送遅延につながりますことと、ミスによるご迷惑をおかけしかねませんためお断りさせて頂いております。',
      '同梱ご希望の場合は、同時にご注文を頂きますようお願い申し上げます。',
      '期間中は企画展作品以外の商品も含めご注文後の同梱はご遠慮頂いております。',
      '店舗お受け取りを希望されます場合は備考欄へ「店舗受け取り希望」とご明記の上ご注文くださいませ。',
      '確認後、相談の連絡をさせて頂きます。'
    ]);

  var PAGE2_HTML =
    heading('返品、交換、キャンセルにつきまして') +
    bullets([
      '返品や交換、キャンセルはお受けしておりません。（こちらは常設作品も含みます。）',
      '店舗の発送、掲載ミス、不良品は内容により対応をさせて頂きます。',
      '初期不良と疑われる場合はお受け取り後3日以内のご連絡をお願い申し上げます。'
    ]) +
    heading('ご注文確定の前に') +
    bullets([
      'ご注文確認画面で内容を今一度ご確認くださいませ。',
      '宛先のご住所、ご連絡先に誤りがあることが多くございます。',
      '到着遅延、宛名不明にて発送不可、連絡によるご相談ができなくなりますため、お間違いないかあらためてのご確認をお願い申しあげます。',
      '宛名不明による再送手配となりました場合は着払いで対応させて頂きます。',
      'fukameki.zakkaten@gmail.com より連絡をさせて頂く事がございます。',
      '受信可能な設定を事前にお願い致します。'
    ]) +
    heading('取扱作品につきまして') +
    bullets([
      '企画展作品は天然素材を使用しています。同一品でも色味や状態に個体差がございます。',
      '各作品商品説明の特徴をご理解いただきお求めの決断をお願い申し上げます。',
      '選択制でない複数在庫の作品へご希望を明記いただく事がございますが、お気持ちに添えているか判断ができかねます。お書き添えはご遠慮くださいませ。',
      '少しでもご不安がございます場合はご注文の前にご質問をお願い致します。',
      'ご質問につきまして1人での対応でありますためすぐお答えができない場合もございます。大変申し訳ございません。',
      '撮影環境、ご使用端末により色味や風合いなどが実際のものと印象が異なると感じる場合がございます。',
      '現物での撮影をしておりますが、全ての状態を写し込むのは困難なためそちらをご理解頂いてお求めをお願い申し上げます。'
    ]) +
    heading('お問い合わせにつきまして') +
    bullets([
      'ご連絡はお問い合わせフォームよりお願い申し上げます。',
      '可能でしたら作品名、作家名もお書き添えくださいませ。',
      'Shopifyアプリ取得されておりましたら、メッセージをタップいただくと「ショップへのお問い合わせ」へ進むことが可能です。',
      'もしくはインスタグラム投稿欄の固定記事でお問い合わせ方法をご確認いただけます。',
      'インスタグラムのDMは確認漏れがある場合がございます。',
      'メールアドレスへ直接の場合受信できていないことがございます。',
      '受付後自動送信メールが届くお問い合わせフォームからのご協力をよろしくお願い申し上げます。',
      '初期不良への相談のご連絡もなるべくお問い合わせフォームよりお願い致します。'
    ]) +
    '<p class="shop-notice-closing">' + esc('お読みくださいまして、いつもご利用を頂きまして誠にありがとうございます。') + '</p>';

  /* ---------- オーバーレイは公開ID確認より前に、即座に構築・表示する ---------- */
  var style = document.createElement('style');
  style.textContent =
    '#shop-notice-overlay{position:fixed;inset:0;z-index:99999;background:rgba(20,18,15,.72);' +
    'display:flex;align-items:center;justify-content:center;padding:4vh 1rem;box-sizing:border-box;}' +
    '#shop-notice-modal{background:var(--washi,#f2efe9);color:var(--sumi,#1b1a18);width:min(560px,92vw);' +
    'max-height:88vh;display:flex;flex-direction:column;box-sizing:border-box;box-shadow:0 10px 40px rgba(0,0,0,.3);}' +
    '.shop-notice-head{position:relative;padding:1.6rem 1.6rem .8rem;border-bottom:1px solid var(--line,rgba(27,26,24,.15));flex-shrink:0;}' +
    '.shop-notice-close{position:absolute;top:.5rem;right:.5rem;width:2.75rem;height:2.75rem;display:flex;' +
    'align-items:center;justify-content:center;background:transparent;border:none;cursor:pointer;' +
    'font-family:"Inter Tight",sans-serif;font-size:1.4rem;font-weight:300;line-height:1;color:var(--hai,#a39d92);padding:0;}' +
    '.shop-notice-close:hover{color:var(--sumi,#1b1a18);}' +
    '.shop-notice-title{font-family:"Shippori Mincho",serif;font-weight:500;font-size:1.15rem;letter-spacing:.06em;margin:0 0 .5rem;}' +
    '.shop-notice-subtitle{font-size:.72rem;letter-spacing:.05em;color:var(--hai,#a39d92);margin:0;display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;}' +
    '.shop-notice-body{padding:1.2rem 1.6rem;overflow-y:auto;overscroll-behavior:contain;font-size:.85rem;line-height:1.9;letter-spacing:.02em;box-sizing:border-box;min-height:2rem;}' +
    '.shop-notice-body ul{margin:0 0 1rem;padding-left:1.2em;}' +
    '.shop-notice-body li{margin-bottom:.4em;word-break:break-word;}' +
    '.shop-notice-h{font-weight:700;margin:1.2rem 0 .5rem;}' +
    '.shop-notice-h:first-child{margin-top:0;}' +
    '.shop-notice-closing{margin-top:1rem;}' +
    '.shop-notice-foot{padding:1rem 1.6rem 1.4rem;border-top:1px solid var(--line,rgba(27,26,24,.15));display:flex;justify-content:flex-end;gap:.8rem;flex-shrink:0;flex-wrap:wrap;}' +
    '.shop-notice-foot:empty{display:none;}' +
    '.shop-notice-btn{font-family:"Inter Tight",sans-serif;font-weight:300;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;' +
    'padding:.8em 1.4em;border:1px solid var(--sumi,#1b1a18);background:var(--sumi,#1b1a18);color:var(--washi,#f2efe9);cursor:pointer;}' +
    '.shop-notice-btn.secondary{background:transparent;color:var(--sumi,#1b1a18);}' +
    '.shop-notice-btn:focus-visible{outline:2px solid var(--sumi,#1b1a18);outline-offset:2px;}' +
    '@media (max-width:480px){#shop-notice-modal{width:96vw;max-height:92vh;}' +
    '.shop-notice-head{padding:1.2rem 1.1rem .7rem;}.shop-notice-body{padding:1rem 1.1rem;}.shop-notice-foot{padding:.9rem 1.1rem 1.1rem;}}' +
    /* 常設リンク（商品一覧・商品詳細で共通の見た目）。購入ボタンより控えめ・下線付きテキストリンク調。 */
    '.shop-notice-open-link{display:inline-flex;align-items:center;min-height:2.75rem;background:transparent;border:none;' +
    'border-bottom:1px solid var(--hai,#a39d92);font-family:"Inter Tight",sans-serif;font-weight:300;font-size:.74rem;' +
    'letter-spacing:.05em;color:var(--hai,#a39d92);cursor:pointer;padding:0 .1em;max-width:100%;box-sizing:border-box;}' +
    '.shop-notice-open-link:hover{color:var(--sumi,#1b1a18);border-color:var(--sumi,#1b1a18);}' +
    '.shop-notice-open-link:focus-visible{outline:2px solid var(--sumi,#1b1a18);outline-offset:3px;}';
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.id = 'shop-notice-overlay';
  overlay.innerHTML =
    '<div id="shop-notice-modal" role="dialog" aria-modal="true" aria-labelledby="shop-notice-heading">' +
      '<div class="shop-notice-head">' +
        '<button type="button" id="shop-notice-close" class="shop-notice-close" style="display:none;"></button>' +
        '<p class="shop-notice-title" id="shop-notice-heading" tabindex="-1"></p>' +
        '<p class="shop-notice-subtitle"><span id="shop-notice-subtitle-text"></span><span id="shop-notice-page-indicator"></span></p>' +
      '</div>' +
      '<div class="shop-notice-body" id="shop-notice-body"></div>' +
      '<div class="shop-notice-foot" id="shop-notice-foot"></div>' +
    '</div>';
  overlay.style.display = 'none'; // 初期状態は非表示。open/close で切り替えるのみで、DOMからは外さない（再表示で使い回す）
  document.body.appendChild(overlay);

  var modal = document.getElementById('shop-notice-modal');
  var headingEl = document.getElementById('shop-notice-heading');
  var subtitleEl = document.getElementById('shop-notice-subtitle-text');
  var pageIndicatorEl = document.getElementById('shop-notice-page-indicator');
  var bodyEl = document.getElementById('shop-notice-body');
  var footEl = document.getElementById('shop-notice-foot');
  var closeBtnEl = document.getElementById('shop-notice-close');
  closeBtnEl.textContent = '×';
  closeBtnEl.addEventListener('click', closeReopened);

  var page = 1;
  var releaseIdToSave = null;
  var showingNotice = false; // 読み込み中(false)か、実際の注意事項本文を表示中(true)か
  var isOpen = false;
  var triggerEl = null; // 常設リンクから開いた場合、閉じた時にフォーカスを戻す対象
  var isReopen = false; // 常設リンクからの再表示中のみ true（初回ゲートは false のまま）

  function renderLoading() {
    // 公開ID確認は通常ごく短時間で完了するため、簡潔な表示のみとする（多言語対応は今回のスコープ外）。
    headingEl.textContent = '読み込み中';
    subtitleEl.textContent = '';
    pageIndicatorEl.textContent = '';
    bodyEl.innerHTML = '';
    footEl.innerHTML = '';
  }

  function render() {
    closeBtnEl.setAttribute('aria-label', t('shop_notice_close', '閉じる'));
    headingEl.textContent = t('shop_notice_title', 'オンラインショップご利用案内');
    subtitleEl.textContent = t('shop_notice_subtitle', 'ご注文前に必ずお読みください');
    pageIndicatorEl.textContent = page + ' / 2';
    bodyEl.innerHTML = page === 1 ? PAGE1_HTML : PAGE2_HTML;
    bodyEl.scrollTop = 0;

    footEl.innerHTML = '';
    if (page === 1) {
      var nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'shop-notice-btn';
      nextBtn.textContent = t('shop_notice_next', '次へ');
      nextBtn.addEventListener('click', function () { page = 2; render(); focusFirst(); });
      footEl.appendChild(nextBtn);
    } else {
      var backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'shop-notice-btn secondary';
      backBtn.textContent = t('shop_notice_back', '戻る');
      backBtn.addEventListener('click', function () { page = 1; render(); focusFirst(); });
      var confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'shop-notice-btn';
      confirmBtn.textContent = t('shop_notice_confirm', '内容を確認しました。オンラインショップを見る');
      confirmBtn.addEventListener('click', close);
      footEl.appendChild(backBtn);
      footEl.appendChild(confirmBtn);
    }
  }

  function focusables() {
    return Array.prototype.slice.call(modal.querySelectorAll('button, [tabindex]'))
      .filter(function (el) { return el.offsetParent !== null; });
  }
  function focusFirst() {
    headingEl.focus();
  }

  function trapTab(e) {
    if (e.key !== 'Tab') return;
    var els = focusables();
    if (!els.length) return;
    var first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    } else if (els.indexOf(document.activeElement) === -1) {
      e.preventDefault(); first.focus();
    }
  }

  function blockKeys(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (isReopen) closeReopened(); // 初回ゲートでは従来どおり何も起きない
      return;
    }
    trapTab(e);
  }

  var prevBodyOverflow = document.body.style.overflow;
  var inertedEls = [];

  // オーバーレイはDOMから外さず、display切替のみで開閉する（再表示APIで使い回すため）。
  function lockBackground() {
    if (isOpen) return; // 二重生成防止（連続クリック等でも overlay は1個のみ）
    isOpen = true;
    overlay.style.display = 'flex';
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inertedEls = [];
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el === overlay) return;
      if ('inert' in el) { el.inert = true; inertedEls.push(el); }
    });
    document.addEventListener('keydown', blockKeys, true);
  }

  function unlockBackground() {
    if (!isOpen) return;
    isOpen = false;
    overlay.style.display = 'none';
    document.removeEventListener('keydown', blockKeys, true);
    inertedEls.forEach(function (el) { el.inert = false; });
    inertedEls = [];
    document.body.style.overflow = prevBodyOverflow;
  }

  // 公開ID確認結果が「一致」だった場合: 保存は不要、ちらつきなく即座に解除する。
  function dismissWithoutNotice() {
    unlockBackground();
  }

  // 注意事項本文を表示する（初回の不一致・取得不能時、および常設リンクからの再表示で共通利用）。
  function showNotice(releaseId) {
    if (releaseId !== undefined) releaseIdToSave = releaseId;
    showingNotice = true;
    page = 1; // 再表示時も必ず1ページ目から
    render();
    closeBtnEl.style.display = isReopen ? 'flex' : 'none'; // ×は再表示のときだけ出す
    lockBackground();
    focusFirst();
  }

  function close() {
    // 公開IDが読み込めない状態（releaseIdToSave===null）では「確認済み」を永久保存しない。
    // 安全側として、次回アクセス時にも再表示させる。再表示APIだけで公開IDが変わることもない
    // （releaseIdToSave は初回確認時の値のまま。ここでは書き込むだけで再取得はしない）。
    if (releaseIdToSave) writeLS(ACK_RELEASE_KEY, releaseIdToSave);
    unlockBackground();
    isReopen = false;
    var toFocus = triggerEl;
    triggerEl = null;
    if (toFocus && document.body.contains(toFocus)) toFocus.focus();
  }

  // 常設リンクからの再表示中のみ使う閉じ方。
  // 確認済み状態(localStorage)にも公開IDにも一切書き込まない（読み返しただけの操作のため）。
  function closeReopened() {
    if (!isOpen || !isReopen) return;
    unlockBackground();
    isReopen = false;
    var toFocus = triggerEl;
    triggerEl = null;
    if (toFocus && document.body.contains(toFocus)) toFocus.focus();
  }

  // 背景クリックでは閉じない（オーバーレイ自体に閉じる動作を割り当てない）

  // 言語切替時にUIラベルを再翻訳する。読み込み中はまだ翻訳対象の本文が無いため何もしない。
  // 本文（正本＝日本語）はページ内容として変更しない。
  if (typeof window.setLang === 'function' && !window.setLang.__noticeWrapped) {
    var _origSetLang = window.setLang;
    window.setLang = function (lang) {
      _origSetLang(lang);
      if (isOpen && showingNotice) render();
    };
    window.setLang.__noticeWrapped = true;
  }

  // ---- 確認済み状態とは無関係に、いつでもモーダルを開ける公開API ----
  // 常設リンク（data-shop-notice-open）から呼ばれる。公開IDの再取得・変更は一切行わない。
  window.ShopNotice = {
    open: function (fromEl) {
      if (isOpen) return; // 連続クリックしてもオーバーレイは1個だけ
      isReopen = true;
      triggerEl = (fromEl && fromEl.nodeType === 1) ? fromEl : null;
      showNotice(); // releaseIdToSave は変更しない（初回確認時の値をそのまま使う）
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.hasAttribute && el.hasAttribute('data-shop-notice-open')) {
        window.ShopNotice.open(el);
        return;
      }
      el = el.parentNode;
    }
  });

  // 公開ID確認が完了する前から、既にオーバーレイで背景操作・スクロールを禁止しておく。
  // これにより商品本文が注意事項より先に読める状態にはならない。
  renderLoading();
  lockBackground();
  focusFirst();

  // 公開IDを確認し、保存済みIDと完全一致する場合のみ即座にブロックを解除する。
  // 公開IDが読み込めない場合は安全側として必ず注意事項を表示する。
  currentReleaseId(function (releaseId) {
    if (releaseId) {
      var saved = readLS(ACK_RELEASE_KEY);
      if (saved === releaseId) {
        dismissWithoutNotice();
        return;
      }
    }
    showNotice(releaseId); // releaseId が null の場合も含め表示する
  });
})();
