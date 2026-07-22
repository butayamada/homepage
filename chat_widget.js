/* =====================================================
   ARC FUKAMEKI — クローズド型チャットウィジェット（フェーズ1・ルールベース）
   表示してよい回答文は chat_knowledge.js の CHAT_KB[].answer の逐語出力のみ。
   生成・要約・言い換えは行わない。マッチしなければエスカレーション（Formspree送信）に切り替える。
   ===================================================== */
(function () {
  'use strict';

  if (!window.CHAT_KB || !Array.isArray(window.CHAT_KB) || !window.CHAT_KB.length) return;

  var FORMSPREE_URL = 'https://formspree.io/f/mlgodarw';
  var chatLog = []; // { q, matchedId }

  function t(key, fallback) {
    var lang = 'ja';
    try { lang = localStorage.getItem('arc_lang') || 'ja'; } catch (e) {}
    var dict = window.LANG_TRANSLATIONS && window.LANG_TRANSLATIONS[lang];
    return (dict && dict[key] !== undefined) ? dict[key] : fallback;
  }
  function curLang() {
    try { return localStorage.getItem('arc_lang') || 'ja'; } catch (e) { return 'ja'; }
  }

  /* ---------- normalization / matching ---------- */
  function toHiragana(str) {
    return str.replace(/[ァ-ヶ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
  }
  function normalize(str) {
    str = String(str || '').normalize('NFKC').toLowerCase();
    str = toHiragana(str);
    str = str.replace(/[\s　。、！？!?.,・「」『』（）()\-—…?]/g, '');
    return str;
  }
  function applySynonyms(str) {
    var syn = window.CHAT_SYNONYMS || {};
    Object.keys(syn).forEach(function (k) {
      var nk = normalize(k);
      var nv = normalize(syn[k]);
      if (nk && str.indexOf(nk) !== -1) str = str.split(nk).join(nv);
    });
    return str;
  }
  function scoreEntry(queryNorm, entry) {
    var score = 0;
    (entry.q || []).forEach(function (qv) {
      var qn = normalize(qv);
      if (qn && queryNorm.indexOf(qn) !== -1) score += 3;
    });
    (entry.keywords || []).forEach(function (kw) {
      var kn = normalize(kw);
      if (kn && queryNorm.indexOf(kn) !== -1) score += 1;
    });
    return score;
  }
  function matchQuery(rawQuery) {
    var norm = applySynonyms(normalize(rawQuery));
    var scored = window.CHAT_KB.map(function (e) { return { entry: e, score: scoreEntry(norm, e) }; });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored[0];
    if (!top || top.score < 3) return { type: 'escalate' };
    var second = scored[1];
    if (second && second.score === top.score) {
      return { type: 'choice', options: [top.entry, second.entry] };
    }
    return { type: 'answer', entry: top.entry };
  }
  function relatedEntries(entry) {
    return window.CHAT_KB.filter(function (e) {
      return e.category === entry.category && e.id !== entry.id;
    }).slice(0, 3);
  }
  function findEntry(id) {
    for (var i = 0; i < window.CHAT_KB.length; i++) {
      if (window.CHAT_KB[i].id === id) return window.CHAT_KB[i];
    }
    return null;
  }

  /* ---------- styles ---------- */
  var style = document.createElement('style');
  style.textContent =
    '.chat-toggle{position:fixed;right:1rem;bottom:1rem;z-index:120;width:44px;height:44px;border-radius:50%;' +
    'border:1px solid var(--line,rgba(233,229,221,.16));background:var(--night,#0e0d0c);color:var(--bone,#e9e5dd);' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;transition:border-color .3s,background .3s;}' +
    '.chat-toggle:hover{border-color:var(--ash,#8f887c);background:var(--coal,#151413);}' +
    '.chat-toggle svg{width:18px;height:18px;}' +
    '.chat-panel{position:fixed;right:1rem;bottom:calc(1rem + 56px);z-index:120;width:min(380px,92vw);height:min(560px,80vh);height:min(560px,80dvh);' +
    'background:var(--coal,#151413);border:1px solid var(--line,rgba(233,229,221,.16));display:flex;flex-direction:column;' +
    'opacity:0;visibility:hidden;transform:translateY(12px);transition:opacity .35s,transform .35s,visibility .35s;font-family:var(--ui,"Inter Tight",sans-serif);}' +
    '.chat-panel.open{opacity:1;visibility:visible;transform:translateY(0);}' +
    '.chat-head{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.2rem;border-bottom:1px solid var(--line,rgba(233,229,221,.16));}' +
    '.chat-head p{font-family:var(--ui,"Inter Tight",sans-serif);font-weight:200;font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;color:var(--bone,#e9e5dd);}' +
    '.chat-close{font-size:1.1rem;line-height:1;color:var(--ash,#8f887c);background:none;border:none;cursor:pointer;padding:.2rem .4rem;}' +
    '.chat-close:hover{color:var(--bone,#e9e5dd);}' +
    '.chat-body{flex:1;overflow-y:auto;padding:1rem 1.2rem;display:flex;flex-direction:column;gap:.7rem;}' +
    '.chat-msg{max-width:88%;font-size:.8rem;line-height:1.7;letter-spacing:.03em;padding:.6rem .8rem;}' +
    '.chat-msg.user{align-self:flex-end;background:var(--bone,#e9e5dd);color:var(--night,#0e0d0c);}' +
    '.chat-msg.bot{align-self:flex-start;background:transparent;border:1px solid var(--line,rgba(233,229,221,.16));color:var(--bone,#e9e5dd);}' +
    '.chat-msg .chat-source{display:block;margin-top:.5rem;font-size:.68rem;color:var(--ash,#8f887c);}' +
    '.chat-msg .chat-source a{color:var(--ash,#8f887c);border-bottom:1px solid var(--line,rgba(233,229,221,.16));}' +
    '.chat-msg .chat-source a:hover{color:var(--bone,#e9e5dd);}' +
    '.chat-chip-row{display:flex;flex-wrap:wrap;gap:.4rem;padding:0 1.2rem .8rem;}' +
    '.chat-chip{font-size:.64rem;letter-spacing:.08em;color:var(--ash,#8f887c);border:1px solid var(--line,rgba(233,229,221,.16));' +
    'padding:.35rem .7rem;background:none;cursor:pointer;transition:color .3s,border-color .3s;}' +
    '.chat-chip:hover{color:var(--bone,#e9e5dd);border-color:var(--ash,#8f887c);}' +
    '.chat-form-row{display:flex;gap:.6rem;padding:1rem 1.2rem;border-top:1px solid var(--line,rgba(233,229,221,.16));}' +
    '.chat-form-row.hidden{display:none;}' +
    '.chat-chip-row.hidden{display:none;}' +
    '.chat-form-row input[type=text]{flex:1;background:transparent;border:none;border-bottom:1px solid var(--line,rgba(233,229,221,.16));' +
    'color:var(--bone,#e9e5dd);font-family:var(--ja,"Noto Serif JP",serif);font-size:16px;padding:.4rem 0;outline:none;}' +
    '.chat-form-row input[type=text]::placeholder{color:rgba(233,229,221,.35);}' +
    '.chat-form-row input[type=text]:focus{border-bottom-color:var(--bone,#e9e5dd);}' +
    '.chat-form-row button{font-family:var(--ui,"Inter Tight",sans-serif);font-size:.62rem;letter-spacing:.18em;text-transform:uppercase;' +
    'background:var(--bone,#e9e5dd);color:var(--night,#0e0d0c);border:none;padding:.5rem 1rem;cursor:pointer;}' +
    '.chat-esc{display:flex;flex-direction:column;gap:.6rem;margin-top:.6rem;}' +
    '.chat-esc label{font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ash,#8f887c);}' +
    '.chat-esc input,.chat-esc textarea{background:transparent;border:none;border-bottom:1px solid var(--line,rgba(233,229,221,.16));' +
    'color:var(--bone,#e9e5dd);font-family:var(--ja,"Noto Serif JP",serif);font-size:16px;padding:.4rem 0;outline:none;width:100%;}' +
    '.chat-esc textarea{resize:vertical;min-height:60px;}' +
    '.chat-esc button{align-self:flex-start;font-family:var(--ui,"Inter Tight",sans-serif);font-size:.62rem;letter-spacing:.18em;' +
    'text-transform:uppercase;background:var(--bone,#e9e5dd);color:var(--night,#0e0d0c);border:none;padding:.55rem 1.1rem;cursor:pointer;margin-top:.3rem;}' +
    '.chat-esc button:disabled{opacity:.5;cursor:default;}' +
    '.chat-esc-error{font-size:.68rem;color:#d9776e;letter-spacing:.05em;margin-top:.2rem;}' +
    '@media (max-width:600px){.chat-panel{right:.6rem;bottom:calc(.6rem + 56px);}.chat-toggle{right:.6rem;bottom:.6rem;}}';
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var toggle = document.createElement('button');
  toggle.className = 'chat-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 5h16v11H8l-4 3.5V5z"/></svg>';

  var panel = document.createElement('div');
  panel.className = 'chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.innerHTML =
    '<div class="chat-head"><p></p><button type="button" class="chat-close" aria-label="close">&times;</button></div>' +
    '<div class="chat-body"></div>' +
    '<div class="chat-chip-row chat-suggestions"></div>' +
    '<form class="chat-form-row"><input type="text" autocomplete="off"><button type="submit"></button></form>';

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  var headTitle = panel.querySelector('.chat-head p');
  var closeBtn = panel.querySelector('.chat-close');
  var body = panel.querySelector('.chat-body');
  var suggestionRow = panel.querySelector('.chat-suggestions');
  var form = panel.querySelector('.chat-form-row');
  var input = form.querySelector('input');
  var sendBtn = form.querySelector('button');

  function refreshTexts() {
    toggle.setAttribute('aria-label', t('chat_label', 'Chat'));
    headTitle.textContent = t('chat_title', 'Contact — Chat');
    closeBtn.setAttribute('aria-label', t('chat_close', 'Close'));
    input.setAttribute('placeholder', t('chat_placeholder', 'Ask a question'));
    sendBtn.textContent = t('chat_send', 'Send');
    renderSuggestions();
  }

  var SUGGESTIONS = [
    { key: 'chat_chip_hours', id: 'hours' },
    { key: 'chat_chip_access', id: 'access' },
    { key: 'chat_chip_exhibition', id: 'exhibition_current' },
    { key: 'chat_chip_shop', id: 'online_shop' },
    { key: 'chat_chip_other', id: null }
  ];

  function renderSuggestions() {
    suggestionRow.innerHTML = '';
    SUGGESTIONS.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-chip';
      btn.textContent = t(s.key, s.key);
      btn.addEventListener('click', function () {
        if (!s.id) { input.focus(); return; }
        var entry = findEntry(s.id);
        if (!entry) return;
        addUserMessage(btn.textContent);
        addBotAnswer(entry);
      });
      suggestionRow.appendChild(btn);
    });
  }

  function addUserMessage(text) {
    var div = document.createElement('div');
    div.className = 'chat-msg user';
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function addBotAnswer(entry) {
    var lang = curLang();
    var answer = (entry.answer && (entry.answer[lang] || entry.answer.ja)) || '';
    var div = document.createElement('div');
    div.className = 'chat-msg bot';
    var p = document.createElement('p');
    p.textContent = answer;
    div.appendChild(p);
    if (entry.source && entry.source.href) {
      var srcWrap = document.createElement('span');
      srcWrap.className = 'chat-source';
      var a = document.createElement('a');
      a.href = entry.source.href;
      a.textContent = '→ ' + entry.source.label;
      if (/^https?:/.test(entry.source.href)) { a.target = '_blank'; a.rel = 'noopener'; }
      srcWrap.appendChild(a);
      div.appendChild(srcWrap);
    }
    var related = relatedEntries(entry);
    if (related.length) {
      var relLabel = document.createElement('span');
      relLabel.className = 'chat-source';
      relLabel.textContent = t('chat_related', 'Related questions') + ':';
      div.appendChild(relLabel);
      var relRow = document.createElement('div');
      relRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem;';
      related.forEach(function (re) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chat-chip';
        chip.textContent = re.q[0];
        chip.addEventListener('click', function () {
          addUserMessage(re.q[0]);
          addBotAnswer(re);
        });
        relRow.appendChild(chip);
      });
      div.appendChild(relRow);
    }
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    chatLog.push({ q: entry.q[0], matchedId: entry.id });
  }

  function addChoiceMessage(options, rawQuery) {
    var div = document.createElement('div');
    div.className = 'chat-msg bot';
    var p = document.createElement('p');
    p.textContent = t('chat_related', 'Related questions') + '?';
    div.appendChild(p);
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.4rem;';
    options.forEach(function (entry) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chat-chip';
      chip.textContent = entry.q[0];
      chip.addEventListener('click', function () { addBotAnswer(entry); });
      row.appendChild(chip);
    });
    div.appendChild(row);
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    chatLog.push({ q: rawQuery, matchedId: null });
  }

  function addEscalation(rawQuery) {
    chatLog.push({ q: rawQuery, matchedId: null });
    var div = document.createElement('div');
    div.className = 'chat-msg bot';
    var p = document.createElement('p');
    p.textContent = t('chat_escalation_intro', 'Our staff will answer this directly. Please share your contact details.');
    div.appendChild(p);

    var wrap = document.createElement('div');
    wrap.className = 'chat-esc';

    var nameLabel = document.createElement('label');
    nameLabel.textContent = t('chat_esc_name', 'Name');
    var nameInput = document.createElement('input');
    nameInput.type = 'text';

    var emailLabel = document.createElement('label');
    emailLabel.textContent = t('chat_esc_email', 'Email');
    var emailInput = document.createElement('input');
    emailInput.type = 'email';

    var qLabel = document.createElement('label');
    qLabel.textContent = t('chat_esc_question', 'Your question');
    var qInput = document.createElement('textarea');
    qInput.value = rawQuery || '';

    var sendEscBtn = document.createElement('button');
    sendEscBtn.type = 'button';
    sendEscBtn.textContent = t('chat_esc_send', 'Send');

    var errorP = document.createElement('p');
    errorP.className = 'chat-esc-error';
    errorP.style.display = 'none';

    wrap.appendChild(nameLabel); wrap.appendChild(nameInput);
    wrap.appendChild(emailLabel); wrap.appendChild(emailInput);
    wrap.appendChild(qLabel); wrap.appendChild(qInput);
    wrap.appendChild(sendEscBtn);
    wrap.appendChild(errorP);
    div.appendChild(wrap);
    body.appendChild(div);

    // 送信ボタンを画面外に押し出さないよう、フォーム入力欄とサジェスション行を隠して1本化する
    form.classList.add('hidden');
    suggestionRow.classList.add('hidden');

    requestAnimationFrame(function () {
      body.scrollTop = body.scrollHeight;
      sendEscBtn.scrollIntoView({ block: 'nearest' });
    });

    sendEscBtn.addEventListener('click', function () {
      sendEscBtn.disabled = true;
      errorP.style.display = 'none';
      var logText = chatLog.map(function (turn) {
        return '- Q: ' + turn.q + (turn.matchedId ? (' → A[' + turn.matchedId + ']') : ' → (未回答)');
      }).join('\n');
      var payload = {
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        subject: '[CHAT] ' + (qInput.value.trim().slice(0, 60) || 'お問い合わせ'),
        message: '未回答質問: ' + qInput.value.trim() + '\n\n--- チャットログ ---\n' + logText
      };
      fetch(FORMSPREE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (res.ok) {
          wrap.innerHTML = '';
          var successP = document.createElement('p');
          successP.textContent = t('chat_esc_success', 'Thank you for contacting us.');
          wrap.appendChild(successP);
          form.classList.remove('hidden');
          suggestionRow.classList.remove('hidden');
        } else {
          errorP.textContent = t('chat_esc_error', 'Something went wrong sending this. Please try again in a moment.');
          errorP.style.display = '';
          sendEscBtn.disabled = false;
        }
      }).catch(function () {
        errorP.textContent = t('chat_esc_error', 'Something went wrong sending this. Please try again in a moment.');
        errorP.style.display = '';
        sendEscBtn.disabled = false;
      });
    });
  }

  function handleSubmit(rawQuery) {
    rawQuery = rawQuery.trim();
    if (!rawQuery) return;
    addUserMessage(rawQuery);
    var result = matchQuery(rawQuery);
    if (result.type === 'answer') {
      addBotAnswer(result.entry);
    } else if (result.type === 'choice') {
      addChoiceMessage(result.options, rawQuery);
    } else {
      addEscalation(rawQuery);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value;
    input.value = '';
    handleSubmit(v);
  });

  function greet() {
    if (body.childElementCount) return;
    var div = document.createElement('div');
    div.className = 'chat-msg bot';
    div.textContent = t('chat_greeting', 'Hello! I can answer common questions right away.');
    body.appendChild(div);
  }

  function openPanel() {
    panel.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
    refreshTexts();
    greet();
    input.focus();
  }
  function closePanel() {
    panel.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  }

  toggle.addEventListener('click', function () {
    if (panel.classList.contains('open')) closePanel(); else openPanel();
  });
  closeBtn.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
  });

  /* 言語切替と連動（既存の setLang をラップ。既存の onLangChange 等は上書きしない） */
  var originalSetLang = window.setLang;
  if (typeof originalSetLang === 'function') {
    window.setLang = function (lang) {
      originalSetLang(lang);
      refreshTexts();
    };
  }

  refreshTexts();
})();
