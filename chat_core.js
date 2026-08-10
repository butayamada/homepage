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

  /* ---------- 日付検証 ----------
     'YYYY-MM-DD' 形式かつ実在するカレンダー日付だけを有効とする。
     2026-02-30 のような形式は一致するが実在しない日付は、Date.UTCで
     ロールオーバーした結果と入力値を突き合わせて確実に検出・拒否する。 */
  function isValidIsoDate(str) {
    if (typeof str !== 'string') return false;
    var m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return false;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }

  /* ---------- URL安全性 ----------
     絶対URLで許可するのは固定の許可リストに載ったホストだけ（HTTPSなら何でも
     許可、ではない）。相対URLは既知の安全な文字集合のみ、コロンを含む文字列は
     scheme偽装の可能性があるため無条件に拒否する。 */
  var ALLOWED_ABSOLUTE_HOSTS = ['fukameki.jp', 'www.fukameki.jp', 'www.instagram.com', 'vh55x1-pa.myshopify.com'];
  var INSTAGRAM_ALLOWED_PATH = /^\/arcfukameki_minoh\/?$/;
  var SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9_\-./#?=&]+$/;

  function hasControlChars(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 || c === 127) return true;
    }
    return false;
  }

  function isSafeUrl(href) {
    if (typeof href !== 'string' || href === '') return false;
    if (hasControlChars(href)) return false;
    if (href.indexOf('\\') !== -1) return false; // バックスラッシュはブラウザによってスラッシュ扱いされうるため拒否
    if (href.slice(0, 2) === '//') return false; // プロトコル相対URL

    var schemeMatch = href.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) {
      // 相対パス: コロンを含めば拒否（"java\tscript:" 等のscheme偽装対策）。
      if (href.indexOf(':') !== -1) return false;
      return SAFE_RELATIVE_PATH_RE.test(href);
    }

    var scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'https') return false; // http:, javascript:, data:, vbscript: 等はすべて拒否

    var rest = href.slice(schemeMatch[0].length);
    var m = rest.match(/^\/\/([^\/?#]*)([\/?#].*)?$/);
    if (!m) return false;
    var authority = m[1];
    var pathAndRest = m[2] || '';
    if (authority.indexOf('@') !== -1) return false; // user@host 形式は拒否
    if (authority.indexOf(':') !== -1) return false; // ポート指定は現状不要のため拒否（安全側）

    var host = authority.toLowerCase();
    if (ALLOWED_ABSOLUTE_HOSTS.indexOf(host) === -1) return false; // 許可リストに完全一致するホストだけ
    if (host === 'www.instagram.com') {
      var pathOnly = pathAndRest.split('?')[0].split('#')[0];
      if (!INSTAGRAM_ALLOWED_PATH.test(pathOnly)) return false; // ARC公式アカウントのURLだけ許可
    }
    return true;
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
    if (!isValidIsoDate(entry.reviewedAt)) reasons.push('REVIEWED_AT_INVALID');
    if (entry.validFrom !== null && entry.validFrom !== undefined && !isValidIsoDate(entry.validFrom)) {
      reasons.push('VALID_FROM_INVALID');
    }
    if (entry.validUntil !== null && entry.validUntil !== undefined && !isValidIsoDate(entry.validUntil)) {
      reasons.push('VALID_UNTIL_INVALID');
    }
    if (entry.validFrom && entry.validUntil && isValidIsoDate(entry.validFrom) && isValidIsoDate(entry.validUntil)
      && entry.validFrom > entry.validUntil) {
      reasons.push('VALID_RANGE_INVERTED');
    }
    // conflictsWith（任意項目）: 存在する場合は配列・各要素が空でない文字列・自己参照なし・
    // 重複なしを要求する。KB全体に対する参照先ID存在チェックはfilterAnswerableKB側で行う
    // （このエントリ単体では他エントリの情報を持たないため）。
    if (entry.conflictsWith !== undefined) {
      if (!Array.isArray(entry.conflictsWith)) {
        reasons.push('CONFLICTS_WITH_INVALID');
      } else {
        var seenConflict = {};
        var conflictOk = true;
        entry.conflictsWith.forEach(function (cid) {
          if (typeof cid !== 'string' || !cid) conflictOk = false;
          else if (cid === entry.id) conflictOk = false;
          else if (seenConflict[cid]) conflictOk = false;
          else seenConflict[cid] = true;
        });
        if (!conflictOk) reasons.push('CONFLICTS_WITH_INVALID');
      }
    }
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

  /* ---------- 4. 有効期限判定 ----------
     直接呼び出されてもfail-closedになるよう、validateEntryStructureを経由せず
     ここでも日付の実在性・範囲の整合性を自前で再検証する。
     nowStr は 'YYYY-MM-DD'。実在する日付同士なら文字列比較で時系列判定できる。 */
  function isWithinValidity(entry, nowStr) {
    if (!entry) return false;
    if (!isValidIsoDate(nowStr)) return false; // 不正なnowStrは期限内とみなさない
    var vf = entry.validFrom;
    var vu = entry.validUntil;
    if (vf !== null && vf !== undefined) {
      if (!isValidIsoDate(vf)) return false; // 壊れたvalidFromは無条件で期限外扱い
    }
    if (vu !== null && vu !== undefined) {
      if (!isValidIsoDate(vu)) return false; // 壊れたvalidUntilは無条件で期限外扱い
    }
    if (vf && vu && vf > vu) return false; // 前後逆転は無条件で期限外扱い
    if (vf && nowStr < vf) return false;
    if (vu && nowStr > vu) return false;
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

  // conflictsWithの参照先IDがKB内に実在するかどうかはKB全体を見ないと判定できないため、
  // ここ（KB全体を扱う関数）でのみチェックする。存在しないIDを参照するentryはfail-closedで
  // 回答不可にする。
  function hasUnknownConflictReference(entry, kb) {
    if (!Array.isArray(entry.conflictsWith)) return false;
    var validIds = {};
    kb.forEach(function (e) { if (e && typeof e.id === 'string') validIds[e.id] = true; });
    for (var i = 0; i < entry.conflictsWith.length; i++) {
      if (!validIds[entry.conflictsWith[i]]) return true;
    }
    return false;
  }

  function filterAnswerableKB(kb, nowStr) {
    kb = Array.isArray(kb) ? kb : [];
    var duplicateIds = findDuplicateIds(kb);
    var answerable = [];
    var excluded = {};
    kb.forEach(function (e) {
      if (!e || typeof e.id !== 'string') return;
      var unknownRef = validateEntryStructure(e).valid && hasUnknownConflictReference(e, kb);
      if (isAnswerable(e, duplicateIds, nowStr) && !unknownRef) {
        answerable.push(e);
      } else {
        var reason = 'UNANSWERABLE';
        if (duplicateIds[e.id]) reason = 'DUPLICATE_ID';
        else if (e.state !== 'active') reason = 'STATE_' + String(e.state).toUpperCase();
        else if (ALLOWED_AUTHORITIES.indexOf(e.authority) === -1) reason = 'AUTHORITY_INVALID';
        else if (!validateEntryStructure(e).valid) reason = 'STRUCTURE_INVALID';
        else if (unknownRef) reason = 'CONFLICTS_WITH_UNKNOWN_ID';
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

  // qualifying（閾値以上）の候補同士に、どちらか一方でもconflictsWith指定があれば
  // その2件を返す。KB配列内の出現順で並べて返し、順序を固定する。
  function findConflictPair(qualifyingEntries, kb) {
    for (var i = 0; i < qualifyingEntries.length; i++) {
      for (var j = i + 1; j < qualifyingEntries.length; j++) {
        var a = qualifyingEntries[i], b = qualifyingEntries[j];
        var aConflicts = Array.isArray(a.conflictsWith) && a.conflictsWith.indexOf(b.id) !== -1;
        var bConflicts = Array.isArray(b.conflictsWith) && b.conflictsWith.indexOf(a.id) !== -1;
        if (aConflicts || bConflicts) {
          var pair = [a.id, b.id];
          pair.sort(function (x, y) {
            var ix = kb.findIndex(function (e) { return e && e.id === x; });
            var iy = kb.findIndex(function (e) { return e && e.id === y; });
            return ix - iy;
          });
          return pair;
        }
      }
    }
    return null;
  }

  function matchQuery(rawQuery, kb, synonyms, nowStr) {
    var norm = applySynonyms(normalize(rawQuery), synonyms);
    var filtered = filterAnswerableKB(kb, nowStr);
    var scored = filtered.answerable.map(function (e) { return { entry: e, score: scoreEntry(norm, e) }; });
    scored.sort(function (a, b) { return b.score - a.score; });
    var qualifying = scored.filter(function (s) { return s.score >= MATCH_THRESHOLD; });

    if (!qualifying.length) {
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

    // MULTI_INTENT判定は回答・choiceより優先する。特定の文言一致ではなく、
    // 閾値以上に達した候補同士のconflictsWithメタデータで判定するため、
    // JA/EN/ZHいずれの言い換えでも同じ仕組みで検出できる。
    var conflictPair = findConflictPair(qualifying.map(function (s) { return s.entry; }), kb);
    if (conflictPair) {
      return { type: 'escalate', reasonCode: 'MULTI_INTENT', matchedIds: conflictPair };
    }

    var top = qualifying[0];
    var second = qualifying[1];
    if (second && second.score === top.score) {
      return { type: 'choice', options: [top.entry, second.entry] };
    }
    return { type: 'answer', entry: top.entry };
  }

  /* ---------- 6. 未回答理由判定 ---------- */
  function escalationReason(matchResult) {
    if (!matchResult) return 'NO_MATCH';
    if (matchResult.type === 'escalate') {
      if (matchResult.reasonCode === 'MULTI_INTENT') {
        return 'MULTI_INTENT:' + (matchResult.matchedIds || []).join(',');
      }
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

  /* ---------- ページURL・商品参照IDの安全な抽出 ----------
     location.href をそのままメール本文へ入れると、Cart ID・token等の
     機密queryごと本文へ流出しうる（旧実装のsplit('?')[0]は全query削除で
     安全だったが、商品ページのidまで消えて同名商品を特定できなくなる問題があった）。
     ここでは「product_test.htmlのidパラメータだけ」を明示的に許可し、
     それ以外のqueryはページ種別を問わず一切保持しない。 */
  var PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function extractProductRefId(queryString) {
    if (typeof queryString !== 'string' || !queryString) return null;
    var q = queryString.charAt(0) === '?' ? queryString.slice(1) : queryString;
    var params = q.split('&');
    for (var i = 0; i < params.length; i++) {
      var eq = params[i].indexOf('=');
      var key = eq === -1 ? params[i] : params[i].slice(0, eq);
      if (key !== 'id') continue;
      var raw = eq === -1 ? '' : params[i].slice(eq + 1);
      var val;
      try { val = decodeURIComponent(raw); } catch (e) { return null; } // 不正なパーセントエンコードはfail-closed
      return PRODUCT_ID_RE.test(val) ? val : null;
    }
    return null;
  }

  // rawUrl: 実行中ページの完全なURL文字列（location.href相当）。
  // 通常ページ: query・fragmentを除去。product_test.htmlのみ、安全な既知形式のidだけ保持する。
  function sanitizePageUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    var noHash = rawUrl.split('#')[0];
    var qIdx = noHash.indexOf('?');
    var base = qIdx === -1 ? noHash : noHash.slice(0, qIdx);
    var query = qIdx === -1 ? '' : noHash.slice(qIdx + 1);
    var isProductPage = /(^|\/)product_test\.html$/.test(base);
    if (!isProductPage) return base;
    var id = extractProductRefId(query);
    return id ? (base + '?id=' + id) : base;
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
        '商品参照ID: ' + (fields.productRefId || '(なし)') + '\n' +
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
    isValidIsoDate: isValidIsoDate,
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
    extractProductRefId: extractProductRefId,
    sanitizePageUrl: sanitizePageUrl,
    validateEscalationInput: validateEscalationInput,
    buildEscalationPayload: buildEscalationPayload,
    createEscalationSubmitter: createEscalationSubmitter
  };
});
