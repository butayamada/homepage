/* =====================================================
   ARC FUKAMEKI — チャットKB共通ロジック（DOM非依存・純粋関数）
   ブラウザ（chat_widget.js）・Node回帰テスト（tools/test_chat_logic.js）の
   両方から同一実装を呼ぶ（テスト側で判定を再実装しない、shop_config.jsと同方針）。
   ここには「回答文を生成・要約・言い換えする」処理を一切含めない。
   KB項目の answer をそのまま返すか、返せない場合は escalate を返すだけ。
   ===================================================== */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ChatCore = mod;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this), function () {
  'use strict';

  var ALLOWED_STATES = ['active', 'review_required', 'disabled'];
  var ALLOWED_AUTHORITIES = ['website', 'shopify', 'owner_script'];
  var LANGS = ['ja', 'en', 'zh'];
  var MATCH_THRESHOLD = 3;

  /* ---------- 1. 正規化 ---------- */
  function toHiragana(str) {
    return str.replace(/[ァ-ヶ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
  }
  function normalize(str) {
    str = String(str === null || str === undefined ? '' : str).normalize('NFKC').toLowerCase();
    str = toHiragana(str);
    str = str.replace(/[\s　。、！？!?.,・「」『』（）()\-—…?]/g, '');
    return str;
  }

  /* ---------- 2. 同義語適用 ---------- */
  function applySynonyms(str, synonyms) {
    synonyms = synonyms || {};
    Object.keys(synonyms).forEach(function (k) {
      var nk = normalize(k);
      var nv = normalize(synonyms[k]);
      if (nk && str.indexOf(nk) !== -1) str = str.split(nk).join(nv);
    });
    return str;
  }

  /* ---------- URL安全性 ---------- */
  // 許可: スキーム無し（相対パス。ただし "//" 始まりのプロトコル相対URLは拒否）
  //       または "https:" スキームの絶対URL。
  // 拒否: javascript:, data:, vbscript:, http:, その他すべてのスキーム。
  function isSafeUrl(href) {
    if (typeof href !== 'string' || href === '') return false;
    if (href.slice(0, 2) === '//') return false;
    var schemeMatch = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) return true; // 相対パス
    return schemeMatch[1].toLowerCase() === 'https';
  }

  /* ---------- 3. KB項目検証（構造） ---------- */
  function validateEntryStructure(entry) {
    var reasons = [];
    if (!entry || typeof entry !== 'object') return { valid: false, reasons: ['NOT_AN_OBJECT'] };
    if (typeof entry.id !== 'string' || !entry.id) reasons.push('ID_MISSING');
    if (typeof entry.category !== 'string' || !entry.category) reasons.push('CATEGORY_MISSING');
    if (ALLOWED_STATES.indexOf(entry.state) === -1) reasons.push('STATE_INVALID');
    if (ALLOWED_AUTHORITIES.indexOf(entry.authority) === -1) reasons.push('AUTHORITY_INVALID');
    if (!Array.isArray(entry.q) || !entry.q.length) reasons.push('Q_MISSING');
    if (!Array.isArray(entry.keywords)) reasons.push('KEYWORDS_INVALID');
    if (!entry.answer || typeof entry.answer !== 'object') {
      reasons.push('ANSWER_MISSING');
    } else {
      LANGS.forEach(function (lang) {
        var v = entry.answer[lang];
        if (typeof v !== 'string' || v.trim() === '') reasons.push('ANSWER_' + lang.toUpperCase() + '_EMPTY');
      });
    }
    if (!entry.source || typeof entry.source !== 'object' || typeof entry.source.label !== 'string' || !entry.source.label) {
      reasons.push('SOURCE_MISSING');
    } else if (!isSafeUrl(entry.source.href)) {
      reasons.push('SOURCE_URL_UNSAFE');
    }
    if (typeof entry.reviewedAt !== 'string' || !entry.reviewedAt) reasons.push('REVIEWED_AT_MISSING');
    return { valid: reasons.length === 0, reasons: reasons };
  }

  /* 同一idの重複はどちらも回答候補から除外する（安全側） */
  function findDuplicateIds(kb) {
    var seen = {};
    var dup = {};
    (kb || []).forEach(function (e) {
      if (!e || typeof e.id !== 'string') return;
      if (seen[e.id]) dup[e.id] = true;
      seen[e.id] = true;
    });
    return dup;
  }

  /* ---------- 4. 有効期限判定 ---------- */
  // nowStr は 'YYYY-MM-DD'。文字列比較で判定する（ISO日付は辞書順=時系列順）。
  function isWithinValidity(entry, nowStr) {
    if (!entry) return false;
    if (typeof nowStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nowStr)) return false;
    if (entry.validFrom && nowStr < entry.validFrom) return false;
    if (entry.validUntil && nowStr > entry.validUntil) return false;
    return true;
  }

  /* ---------- 5. 回答候補判定 ---------- */
  function isAnswerable(entry, duplicateIds, nowStr) {
    if (!entry) return false;
    if (duplicateIds && duplicateIds[entry.id]) return false;
    if (entry.state !== 'active') return false;
    if (ALLOWED_AUTHORITIES.indexOf(entry.authority) === -1) return false;
    if (!validateEntryStructure(entry).valid) return false;
    if (!isWithinValidity(entry, nowStr)) return false;
    return true;
  }

  function filterAnswerableKB(kb, nowStr) {
    kb = Array.isArray(kb) ? kb : [];
    var duplicateIds = findDuplicateIds(kb);
    var answerable = [];
    var excluded = {};
    kb.forEach(function (e) {
      if (!e || typeof e.id !== 'string') return;
      if (isAnswerable(e, duplicateIds, nowStr)) {
        answerable.push(e);
      } else {
        var reason = 'UNANSWERABLE';
        if (duplicateIds[e.id]) reason = 'DUPLICATE_ID';
        else if (e.state !== 'active') reason = 'STATE_' + String(e.state).toUpperCase();
        else if (ALLOWED_AUTHORITIES.indexOf(e.authority) === -1) reason = 'AUTHORITY_INVALID';
        else if (!validateEntryStructure(e).valid) reason = 'STRUCTURE_INVALID';
        else if (!isWithinValidity(e, nowStr)) reason = 'EXPIRED';
        excluded[e.id] = reason;
      }
    });
    return { answerable: answerable, excluded: excluded };
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

  // findEntry: 回答可能（answerable）な項目からのみIDで検索する。
  // 無効・期限切れ・review_required・disabled・重複IDのいずれも直接ID指定で回答させない。
  function findAnswerableEntry(id, kb, nowStr) {
    var result = filterAnswerableKB(kb, nowStr);
    for (var i = 0; i < result.answerable.length; i++) {
      if (result.answerable[i].id === id) return result.answerable[i];
    }
    return null;
  }

  function matchQuery(rawQuery, kb, synonyms, nowStr) {
    var norm = applySynonyms(normalize(rawQuery), synonyms);
    var filtered = filterAnswerableKB(kb, nowStr);
    var scored = filtered.answerable.map(function (e) { return { entry: e, score: scoreEntry(norm, e) }; });
    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored[0];
    if (!top || top.score < MATCH_THRESHOLD) {
      // 除外された項目の中に、もし governance フィルタがなければ一致していたはずのものがあるかを
      // 診断用に確認する（未回答理由の精度を上げるためだけで、回答はしない）。
      var allScored = (kb || []).filter(function (e) { return e && typeof e.id === 'string'; })
        .map(function (e) { return { entry: e, score: scoreEntry(norm, e) }; })
        .sort(function (a, b) { return b.score - a.score; });
      var bestRaw = allScored[0];
      if (bestRaw && bestRaw.score >= MATCH_THRESHOLD) {
        return { type: 'escalate', reasonCode: 'MATCHED_BUT_UNANSWERABLE', matchedId: bestRaw.entry.id };
      }
      return { type: 'escalate', reasonCode: 'NO_MATCH', matchedId: null };
    }
    var second = scored[1];
    if (second && second.score === top.score) {
      return { type: 'choice', options: [top.entry, second.entry] };
    }
    return { type: 'answer', entry: top.entry };
  }

  /* ---------- 6. 未回答理由判定 ---------- */
  function escalationReason(matchResult) {
    if (!matchResult) return 'NO_MATCH';
    if (matchResult.type === 'escalate') {
      if (matchResult.reasonCode === 'MATCHED_BUT_UNANSWERABLE') {
        return 'MATCHED_BUT_UNANSWERABLE:' + (matchResult.matchedId || 'unknown');
      }
      return 'NO_MATCH';
    }
    return 'NOT_ESCALATED';
  }

  function relatedEntries(entry, kb, nowStr) {
    var filtered = filterAnswerableKB(kb, nowStr).answerable;
    return filtered.filter(function (e) {
      return e.category === entry.category && e.id !== entry.id;
    }).slice(0, 3);
  }

  /* ---------- エスカレーション（未回答→店主確認）入力検証・送信ステートマシン ----------
     DOM/fetchに依存しない純粋ロジック。shop_config.js の CartNoteLogic.createNoteSaver と
     同じ方針（single-flight + 呼び出し側が注入したsend()の結果を厳格検証）。
     ここでは一切のHTML生成・fetch呼び出しを行わない。 */
  var NAME_MAX = 100;
  var EMAIL_MAX = 200;
  var QUESTION_MAX = 2000;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function validateEscalationInput(name, email, question) {
    if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX) return false;
    if (typeof email !== 'string' || !email.trim() || email.length > EMAIL_MAX || !EMAIL_RE.test(email.trim())) return false;
    if (typeof question !== 'string' || !question.trim() || question.length > QUESTION_MAX) return false;
    return true;
  }

  // Cart ID・アクセストークン・Cookie・localStorage内容・Checkout URLは絶対に含めない。
  function buildEscalationPayload(fields) {
    fields = fields || {};
    var name = String(fields.name || '').trim();
    var email = String(fields.email || '').trim();
    var question = String(fields.question || '').trim();
    var kbIds = Array.isArray(fields.kbIdsReferenced) ? fields.kbIdsReferenced : [];
    var logText = (fields.chatLog || []).map(function (turn) {
      return '- Q: ' + turn.q + (turn.matchedId ? (' → A[' + turn.matchedId + ']') : ' → (未回答)');
    }).join('\n');
    return {
      name: name,
      email: email,
      subject: '[CHAT][UNANSWERED] ' + (question.slice(0, 60) || 'お問い合わせ'),
      message: '未回答質問: ' + question + '\n\n' +
        '返信先メールアドレス: ' + email + '\n' +
        '選択言語: ' + (fields.lang || '') + '\n' +
        '質問時のページURL: ' + (fields.pageUrl || '') + '\n' +
        'ページtitle: ' + (fields.pageTitle || '') + '\n' +
        '商品名（取得できた場合）: ' + (fields.productName || '(なし)') + '\n' +
        '参照したKB ID: ' + (kbIds.length ? kbIds.join(', ') : '(なし)') + '\n' +
        '未回答理由: ' + (fields.reasonCode || 'NO_MATCH') + '\n' +
        '送信日時: ' + (fields.timestampIso || '') + '\n\n' +
        '--- チャットログ ---\n' + logText
    };
  }

  // opts.send(payload) は Promise<{ok:boolean}> を返す関数（呼び出し側がfetch等を実装する）。
  function createEscalationSubmitter(opts) {
    opts = opts || {};
    var send = opts.send;
    var onStatus = opts.onStatus || function () {};
    var inFlight = null;

    function submit(fields) {
      if (inFlight) return inFlight; // 単一飛行（二重送信防止）
      if (!validateEscalationInput(fields && fields.name, fields && fields.email, fields && fields.question)) {
        onStatus('validation_error');
        return Promise.reject(new Error('VALIDATION_ERROR'));
      }
      onStatus('sending');
      var payload = buildEscalationPayload(fields);
      inFlight = send(payload).then(function (result) {
        inFlight = null;
        if (!result || result.ok !== true) {
          onStatus('error');
          throw new Error('SEND_FAILED');
        }
        onStatus('success');
        return result;
      }).catch(function (err) {
        inFlight = null;
        onStatus('error');
        throw err;
      });
      return inFlight;
    }

    function isSending() { return !!inFlight; }

    return { submit: submit, isSending: isSending };
  }

  return {
    ALLOWED_STATES: ALLOWED_STATES,
    ALLOWED_AUTHORITIES: ALLOWED_AUTHORITIES,
    LANGS: LANGS,
    MATCH_THRESHOLD: MATCH_THRESHOLD,
    normalize: normalize,
    applySynonyms: applySynonyms,
    isSafeUrl: isSafeUrl,
    validateEntryStructure: validateEntryStructure,
    findDuplicateIds: findDuplicateIds,
    isWithinValidity: isWithinValidity,
    isAnswerable: isAnswerable,
    filterAnswerableKB: filterAnswerableKB,
    scoreEntry: scoreEntry,
    findAnswerableEntry: findAnswerableEntry,
    matchQuery: matchQuery,
    escalationReason: escalationReason,
    relatedEntries: relatedEntries,
    NAME_MAX: NAME_MAX,
    EMAIL_MAX: EMAIL_MAX,
    QUESTION_MAX: QUESTION_MAX,
    validateEscalationInput: validateEscalationInput,
    buildEscalationPayload: buildEscalationPayload,
    createEscalationSubmitter: createEscalationSubmitter
  };
});
