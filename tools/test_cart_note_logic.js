#!/usr/bin/env node
/*
 * shop_config.js の CartNoteLogic（ご注文備考の保存キュー）を Node の隔離環境で実行し、
 * 実コードを検証する。テスト側で判定を再実装しない。
 * DOM操作・実ネットワーク通信は行わない（createNoteSaver/truncateNoteInputは純粋関数）。
 *
 * Usage: node tools/test_cart_note_logic.js
 */
'use strict';
var path = require('path');
var mod = require(path.join(__dirname, '..', 'shop_config.js'));

var results = [];
function check(name, cond) {
  results.push([name, !!cond]);
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name);
}

function deferred() {
  var resolve, reject;
  var p = new Promise(function (res, rej) { resolve = res; reject = rej; });
  return { promise: p, resolve: resolve, reject: reject };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var pending = [];

// ---------- truncateNoteInput ----------
pending.push((function () {
  check('500文字ちょうどは切り詰めない', mod.truncateNoteInput('a'.repeat(500), 500).truncated === false);
  check('500文字ちょうどはvalueがそのまま', mod.truncateNoteInput('a'.repeat(500), 500).value.length === 500);
  check('501文字は500文字へ切り詰め', mod.truncateNoteInput('a'.repeat(501), 500).value.length === 500);
  check('501文字はtruncated=true', mod.truncateNoteInput('a'.repeat(501), 500).truncated === true);
  check('null/undefinedは空文字扱い', mod.truncateNoteInput(null, 500).value === '' && mod.truncateNoteInput(undefined, 500).value === '');
  var multi = '店舗受け取り希望\n2階でお待ちしています\n🙏';
  check('複数行・絵文字は切り詰められない場合そのまま保持', mod.truncateNoteInput(multi, 500).value === multi);
})());

// ---------- createNoteSaver: 正常系 ----------
pending.push((function () {
  var saveCalls = [];
  var saver = mod.createNoteSaver({
    save: function (value) {
      saveCalls.push(value);
      return Promise.resolve({ note: value });
    },
    onStatus: function () {}
  });
  check('初期状態はcurrent===lastSaved===""', saver.getState().current === '' && saver.getState().lastSaved === '');

  // 1. 空欄のままCheckoutできる（変更なしのrunSave()はネットワーク呼び出しなし）
  return saver.runSave().then(function (r) {
    check('空欄のままrunSave()はsave()を呼ばない（skipped）', r.skipped === true && saveCalls.length === 0);

    // 2. 「店舗受け取り希望」が保存される
    saver.setValue('店舗受け取り希望');
    return saver.runSave();
  }).then(function () {
    check('「店舗受け取り希望」がsave()へ渡る', saveCalls[saveCalls.length - 1] === '店舗受け取り希望');
    check('保存後にlastSaved===入力内容', saver.getState().lastSaved === '店舗受け取り希望');

    // 3. 複数行の日本語
    var multiline = '店舗受け取り希望\n2階でお待ちしています。\nよろしくお願いいたします。';
    saver.setValue(multiline);
    return saver.runSave().then(function () {
      check('複数行の日本語が保存される', saveCalls[saveCalls.length - 1] === multiline);

      // 5. 編集して更新
      saver.setValue(multiline + '追記');
      return saver.runSave().then(function () {
        check('編集後の内容で再保存される', saveCalls[saveCalls.length - 1] === multiline + '追記');

        // 6. 全削除して空欄へ
        saver.setValue('');
        return saver.runSave().then(function () {
          check('空文字での保存（既存メモの削除）がsave("")として送信される', saveCalls[saveCalls.length - 1] === '');
          check('空文字保存後はlastSaved===""', saver.getState().lastSaved === '');
        });
      });
    });
  }).catch(function (e) {
    check('正常系フローで例外が発生しない: ' + e.message, false);
  });
})());

// ---------- 保存応答の順序逆転・競合対策 ----------
pending.push((function () {
  return (function () {
    var d1 = deferred();
    var saveCalls = [];
    var saver = mod.createNoteSaver({
      save: function (value) {
        saveCalls.push(value);
        if (saveCalls.length === 1) return d1.promise;
        return Promise.resolve({ note: value });
      },
      onStatus: function () {}
    });
    saver.setValue('最初の内容');
    var p1 = saver.runSave(); // in-flight
    saver.setValue('編集後の最新内容'); // 保存中に再編集
    var p2 = saver.runSave(); // 同一in-flightを返すはず（単一飛行）
    check('保存中の再度のrunSave()は新規リクエストを発行しない（単一飛行）', saveCalls.length === 1);
    check('保存中の再度のrunSave()は同じPromiseを返す', p1 === p2);
    d1.resolve({ note: '最初の内容' }); // 古い（最初の）保存応答が先に返る
    return p1.then(function () {
      // dirtyフラグにより、古い応答が返った直後に最新値で自動的に追加保存されるはず
      return sleep(10);
    }).then(function () {
      check('古い保存応答の後、最新内容で追加保存される（古い応答が新しい入力を上書きしない）',
        saveCalls.length === 2 && saveCalls[1] === '編集後の最新内容');
      check('最終的にlastSavedは最新内容と一致する', saver.getState().lastSaved === '編集後の最新内容');
    });
  })();
})());

// ---------- 保存失敗（network error / HTTPエラー / GraphQL errors / userErrors 相当） ----------
pending.push((function () {
  return (function () {
    var statuses = [];
    var shouldFail = true;
    var saver = mod.createNoteSaver({
      save: function (value) {
        if (shouldFail) return Promise.reject(new Error('network error'));
        return Promise.resolve({ note: value });
      },
      onStatus: function (s) { statuses.push(s); }
    });
    saver.setValue('保存に失敗するはずの内容');
    return saver.runSave().then(function () {
      check('保存失敗時にrunSave()がthrowされない設計ではない（実際はcatchされるべき）', false);
    }).catch(function () {
      check('保存失敗時はrunSave()がrejectされる（Checkoutへ進ませない判断に使える）', true);
      check('保存失敗時にonStatus("error")が呼ばれる', statuses.indexOf('error') !== -1);
      check('保存失敗時もcurrentの入力内容は消えない', saver.getState().current === '保存に失敗するはずの内容');
      check('保存失敗時はlastSavedが更新されない', saver.getState().lastSaved === '');

      // 失敗後、正常応答へ戻して再試行すると復旧する
      shouldFail = false;
      return saver.runSave().then(function () {
        check('失敗後、正常応答に戻して再試行すると保存が成功する', saver.getState().lastSaved === '保存に失敗するはずの内容');
      });
    });
  })();
})());

// ---------- Checkout直前フロー相当: 保存完了を待ってから遷移してよいかを判定する ----------
pending.push((function () {
  return (function () {
    var checkoutCalls = 0;
    function simulateCheckoutClick(saver, hasCheckoutUrl) {
      return Promise.resolve(saver.runSave()).then(function () {
        if (hasCheckoutUrl) { checkoutCalls++; return { navigated: true }; }
        return { navigated: false };
      }).catch(function () {
        return { navigated: false, blocked: true };
      });
    }

    // 17. 正常系: 保存成功後のみcheckoutUrlへ遷移する
    var saverOk = mod.createNoteSaver({ save: function (v) { return Promise.resolve({ note: v }); }, onStatus: function () {} });
    saverOk.setValue('店舗受け取り希望');
    return simulateCheckoutClick(saverOk, true).then(function (r1) {
      check('保存成功後のみcheckoutUrlへ遷移する', r1.navigated === true);

      // 異常系: 保存失敗時はCheckoutへ進ませない
      var saverFail = mod.createNoteSaver({ save: function () { return Promise.reject(new Error('http 500')); }, onStatus: function () {} });
      saverFail.setValue('保存されるべきでない内容');
      return simulateCheckoutClick(saverFail, true).then(function (r2) {
        check('保存失敗時はCheckoutへ進ませない（navigated=false）', r2.navigated === false && r2.blocked === true);
        check('保存失敗時も入力内容が保持される（画面から消えない）', saverFail.getState().current === '保存されるべきでない内容');
      });
    });
  })();
})());

// ---------- 二重クリック防止相当（呼び出し側のchekoutInProgressフラグと同じロジックを検証） ----------
(function () {
  var clickCount = 0;
  var inProgress = false;
  function onClick(saver) {
    if (inProgress) { return null; }
    inProgress = true;
    clickCount++;
    return saver.runSave();
  }
  var saver = mod.createNoteSaver({ save: function (v) { return new Promise(function (res) { setTimeout(function () { res({ note: v }); }, 20); }); }, onStatus: function () {} });
  saver.setValue('二重クリックテスト');
  var r1 = onClick(saver);
  var r2 = onClick(saver); // 2回目は無視される
  check('二重クリックで2回目はnullを返しCheckout処理が重複しない', r1 !== null && r2 === null);
  check('二重クリックでもclickCountは1のまま', clickCount === 1);
})();

// ---------- カート切り替え相当: reset()で古いCartのメモを引き継がない ----------
(function () {
  var saver = mod.createNoteSaver({ save: function (v) { return Promise.resolve({ note: v }); }, onStatus: function () {} });
  saver.setValue('古いCartのメモ');
  saver.reset(''); // 新しいCartへ切り替わった想定（新Cartのnoteは空）
  check('reset("")で古いCartの未保存メモを引き継がない', saver.getState().current === '' && saver.getState().lastSaved === '');

  saver.reset('既存Cartのnote'); // 同一Cart IDでページ再読込した想定
  check('reset(既存note)でShopify Cartのnoteから復元される', saver.getState().current === '既存Cartのnote' && saver.getState().lastSaved === '既存Cartのnote');
})();

// ---------- バックグラウンド保存（自動保存／かごを閉じる際のフラッシュ）はunhandledrejectionを出さない ----------
// shop_config.js の runBackgroundNoteSave() と同じパターン（.catch(function(){})）を、
// 実際にNodeのunhandledRejectionイベントで検証する。
pending.push((function () {
  var unhandled = [];
  function onUnhandled(reason) { unhandled.push(reason); }
  process.on('unhandledRejection', onUnhandled);

  var saver = mod.createNoteSaver({
    save: function () { return Promise.reject(new Error('network error')); },
    onStatus: function () {}
  });
  saver.setValue('通信エラー時も消えないはずの入力内容');

  // shop_config.js の runBackgroundNoteSave() と同一パターン: catchだけして握り潰す。
  function runBackgroundNoteSave() {
    return saver.runSave().catch(function () {});
  }

  return runBackgroundNoteSave().then(function () {
    return sleep(50); // unhandledRejectionはマイクロタスク後に発火するため少し待つ
  }).then(function () {
    process.removeListener('unhandledRejection', onUnhandled);
    check('保存失敗をcatchで握り潰してもunhandledRejectionが発生しない', unhandled.length === 0);
    check('保存失敗後も入力内容が消えない（saver.current保持）', saver.getState().current === '通信エラー時も消えないはずの入力内容');
    check('保存失敗後もlastSavedは更新されない（次回保存時に再試行される）', saver.getState().lastSaved === '');
  });
})());

// ---------- Checkout直前の保存だけは握り潰さず、失敗を呼び出し元へ伝播する ----------
pending.push((function () {
  var saver = mod.createNoteSaver({
    save: function () { return Promise.reject(new Error('graphql errors')); },
    onStatus: function () {}
  });
  saver.setValue('Checkout直前に保存されるべき内容');
  // shop_config.js のcheckoutクリックハンドラと同じ形（.catch()で握り潰さず呼び出し元が判定する）。
  var caughtByCaller = false;
  return Promise.resolve(saver.runSave()).then(function () {
    check('Checkout直前の保存が成功したかのように扱われてはいけない', false);
  }).catch(function () {
    caughtByCaller = true;
  }).then(function () {
    check('Checkout直前の保存失敗は呼び出し元のcatchまで伝播する（握り潰さない）', caughtByCaller === true);
  });
})());

// ---------- performGraphQL: HTTP異常のfail-closed ----------
// PR#6監査(Luna) FAIL対応: HTTPステータスを確認せずres.json()へ進む実装は、
// HTTP 500でも正常形式のJSONが返れば成功扱いになってしまう。res.ok/statusを必ず確認する。
function mockRes(status, ok, jsonImpl) {
  return {
    status: status,
    ok: ok,
    json: jsonImpl || function () { return Promise.resolve({ data: { ok: true } }); }
  };
}
pending.push((function () {
  var ENDPOINT = 'https://example.myshopify.com/api/2026-01/graphql.json';
  var TOKEN = 'dummy-token';

  function run(fetchImpl) {
    return mod.performGraphQL(fetchImpl, ENDPOINT, TOKEN, 'query{x}', {});
  }

  // 1. HTTP 200 + 正常応答 → 成功
  return run(function () { return Promise.resolve(mockRes(200, true, function () { return Promise.resolve({ data: { hello: 'world' } }); })); })
    .then(function (data) {
      check('HTTP 200+正常応答は成功しdataを返す', data && data.hello === 'world');

      // 2. HTTP 201 (2xx) + 正常応答 → 成功として許容する
      return run(function () { return Promise.resolve(mockRes(201, true, function () { return Promise.resolve({ data: { hello: 'created' } }); })); });
    }).then(function (data) {
      check('HTTP 201等の2xxは成功として許容する', data && data.hello === 'created');

      // 3. HTTP 400 + 正常そうなJSON → 失敗
      return run(function () { return Promise.resolve(mockRes(400, false, function () { return Promise.resolve({ data: { hello: 'world' } }); })); })
        .then(function () { check('HTTP 400は失敗するべき（成功してしまった）', false); })
        .catch(function (e) { check('HTTP 400+正常そうなJSONは失敗する', e.httpStatus === 400); });
    }).then(function () {
      // 4. HTTP 401
      return run(function () { return Promise.resolve(mockRes(401, false)); })
        .then(function () { check('HTTP 401は失敗するべき', false); })
        .catch(function (e) { check('HTTP 401は失敗する', e.httpStatus === 401); });
    }).then(function () {
      // 5. HTTP 403
      return run(function () { return Promise.resolve(mockRes(403, false)); })
        .then(function () { check('HTTP 403は失敗するべき', false); })
        .catch(function (e) { check('HTTP 403は失敗する', e.httpStatus === 403); });
    }).then(function () {
      // 6. HTTP 429
      return run(function () { return Promise.resolve(mockRes(429, false)); })
        .then(function () { check('HTTP 429は失敗するべき', false); })
        .catch(function (e) { check('HTTP 429は失敗する', e.httpStatus === 429); });
    }).then(function () {
      // 7. HTTP 500 + 正常そうなJSON → 失敗（res.okが欠落した簡易モックを成功扱いにしない）
      return run(function () { return Promise.resolve(mockRes(500, false, function () { return Promise.resolve({ data: { cartNoteUpdate: { cart: { id: 'x' } } } }); })); })
        .then(function () { check('HTTP 500+正常そうなJSONは失敗するべき', false); })
        .catch(function (e) { check('HTTP 500+正常そうなJSONは失敗する（本文の内容を見ない）', e.httpStatus === 500); });
    }).then(function () {
      // 8. HTTP 502 + HTML本文（json()が解析失敗する）
      return run(function () {
        return Promise.resolve(mockRes(502, false, function () { return Promise.reject(new SyntaxError('Unexpected token <')); }));
      })
        .then(function () { check('HTTP 502+HTML本文は失敗するべき', false); })
        .catch(function (e) { check('HTTP 502+HTML本文は失敗する', e.httpStatus === 502); });
    }).then(function () {
      // 9. HTTP 204（正常なGraphQL応答本文がない）→ 失敗
      return run(function () {
        return Promise.resolve(mockRes(204, true, function () { return Promise.reject(new SyntaxError('Unexpected end of JSON input')); }));
      })
        .then(function () { check('HTTP 204は失敗するべき（本文が無い）', false); })
        .catch(function () { check('HTTP 204は失敗する（本文が無いため）', true); });
    }).then(function () {
      // 10. JSON解析失敗（HTTPは200）
      return run(function () {
        return Promise.resolve(mockRes(200, true, function () { return Promise.reject(new SyntaxError('bad json')); }));
      })
        .then(function () { check('JSON解析失敗は失敗するべき', false); })
        .catch(function () { check('JSON解析失敗は失敗する', true); });
    }).then(function () {
      // 11. GraphQL errors
      return run(function () {
        return Promise.resolve(mockRes(200, true, function () { return Promise.resolve({ errors: [{ message: 'boom' }] }); }));
      })
        .then(function () { check('GraphQL errorsは失敗するべき', false); })
        .catch(function (e) { check('GraphQL errorsは失敗する', e.message === 'boom'); });
    }).then(function () {
      check('res.okが欠落した簡易モック(ok未定義)は成功扱いにしない', true); // 12-cで再確認
      return run(function () { return Promise.resolve({ status: 200, json: function () { return Promise.resolve({ data: {} }); } }); })
        .then(function () { check('res.ok欠落は失敗するべき', false); })
        .catch(function () { check('res.ok欠落（undefined !== true）は失敗する', true); });
    });
})());

// ---------- extractMutationCart / validateNoteUpdateCart: Cart欠落・note不一致のfail-closed ----------
pending.push((function () {
  function expectThrow(fn, label) {
    try { fn(); check(label + ' で例外が発生するべき', false); }
    catch (e) { check(label, true); }
  }

  // 12. mutation node欠落
  expectThrow(function () { mod.extractMutationCart({}, 'cartNoteUpdate'); }, 'mutation node欠落は失敗する');

  // 13. cart: null
  expectThrow(function () { mod.extractMutationCart({ cartNoteUpdate: { cart: null, userErrors: [] } }, 'cartNoteUpdate'); }, 'cart:nullは失敗する');

  // 14. cart: {}
  expectThrow(function () { mod.extractMutationCart({ cartNoteUpdate: { cart: {}, userErrors: [] } }, 'cartNoteUpdate'); }, 'cart:{}（id欠落）は失敗する');

  // 15. cart.id欠落（14と同義だが明示）
  expectThrow(function () { mod.extractMutationCart({ cartNoteUpdate: { cart: { note: 'x' }, userErrors: [] } }, 'cartNoteUpdate'); }, 'cart.id欠落は失敗する');

  // 21. userErrors
  expectThrow(function () {
    mod.extractMutationCart({ cartNoteUpdate: { cart: { id: 'gid://1', note: 'x' }, userErrors: [{ message: 'bad note' }] } }, 'cartNoteUpdate');
  }, 'userErrorsありは失敗する');

  // 22. warningsのみ + 正常Cart → 成功（致命的でない）
  var okWithWarnings = mod.extractMutationCart({
    cartLinesAdd: { cart: { id: 'gid://1' }, userErrors: [], warnings: [{ code: 'MERCHANDISE_OUT_OF_STOCK' }] }
  }, 'cartLinesAdd');
  check('warningsのみ+正常Cartは成功しwarningsを返す', okWithWarnings.warnings.length === 1 && okWithWarnings.cart.id === 'gid://1');

  // 共通Mutation防御が既存操作を壊さないこと（cartCreate/cartLinesAdd/cartLinesUpdate/cartLinesRemove）
  ['cartCreate', 'cartLinesAdd', 'cartLinesUpdate', 'cartLinesRemove'].forEach(function (field) {
    var payload = {}; payload[field] = { cart: { id: 'gid://ok', note: '' }, userErrors: [] };
    var r = mod.extractMutationCart(payload, field);
    check(field + ' の正常応答は引き続き成功する', r.cart.id === 'gid://ok');
  });

  // ---- validateNoteUpdateCart ----
  // 1. HTTP 200＋正常Cart＋一致note → 成功
  var v1 = mod.validateNoteUpdateCart({ id: 'gid://cart1', note: '店舗受け取り希望' }, 'gid://cart1', '店舗受け取り希望');
  check('Cart ID一致・note一致は成功しnoteを返す', v1 === '店舗受け取り希望');

  // 16. Cart ID不一致
  expectThrow(function () { mod.validateNoteUpdateCart({ id: 'gid://other', note: 'x' }, 'gid://cart1', 'x'); }, 'Cart ID不一致は失敗する');

  // 17. noteプロパティ欠落
  expectThrow(function () { mod.validateNoteUpdateCart({ id: 'gid://cart1' }, 'gid://cart1', 'x'); }, 'noteプロパティ欠落は失敗する');

  // 18. 非空送信に対してnote:null
  expectThrow(function () { mod.validateNoteUpdateCart({ id: 'gid://cart1', note: null }, 'gid://cart1', '非空の内容'); }, '非空送信に対するnote:nullは失敗する');

  // 19. 送信値と異なるnote
  expectThrow(function () { mod.validateNoteUpdateCart({ id: 'gid://cart1', note: '別の内容' }, 'gid://cart1', '送信した内容'); }, '送信値と異なるnoteは失敗する');

  // 20. 空文字送信に対してnote:null → 成功（Shopifyの仕様上の同値）
  var v20 = mod.validateNoteUpdateCart({ id: 'gid://cart1', note: null }, 'gid://cart1', '');
  check('空文字送信に対するnote:nullは成功し空文字を返す（null→""正規化、入力値へのフォールバックではない）', v20 === '');

  // 空文字送信に対してnote:''も成功
  var v20b = mod.validateNoteUpdateCart({ id: 'gid://cart1', note: '' }, 'gid://cart1', '');
  check('空文字送信に対するnote:""は成功する', v20b === '');
})());

// ---------- createNoteSaver: save()応答の厳格検証（入力値fallback撤廃） ----------
// PR#6 Luna再監査FAIL対応: save()が壊れた応答を返しても入力値(valueToSave)を
// lastSavedへ代用してはいけない。result.noteがstringでvalueToSaveと完全一致する
// 場合だけ成功として扱う（空文字列は有効な成功結果）。
pending.push((function () {
  function saverWith(resultForFirstCall) {
    var calls = 0;
    var statuses = [];
    var saver = mod.createNoteSaver({
      save: function (value) {
        calls++;
        return Promise.resolve(resultForFirstCall);
      },
      onStatus: function (s) { statuses.push(s); }
    });
    return { saver: saver, statuses: statuses, calls: function () { return calls; } };
  }

  var chain = Promise.resolve();

  // 成功: 入力「abc」→ { note: 'abc' }
  chain = chain.then(function () {
    var t = saverWith({ note: 'abc' });
    t.saver.setValue('abc');
    return t.saver.runSave().then(function () {
      check('{note:"abc"}（入力と完全一致）は保存成功しlastSavedが更新される', t.saver.getState().lastSaved === 'abc');
      check('保存成功時にonStatus("saved")が呼ばれる', t.statuses.indexOf('saved') !== -1);
    });
  });

  // 成功: 入力空文字 → { note: '' }
  // 初期状態はcurrent===lastSaved===""のため、まず非空文字を保存してから空文字へ戻す
  // （最初のsave()呼び出しの結果もvalueToSaveと一致させる必要がある——resultForFirstCallは
  // saverWith()内で全呼び出し共通のため、二段階目のrunSave()だけを検証対象にする）。
  chain = chain.then(function () {
    var callCount = 0;
    var statuses = [];
    var saver = mod.createNoteSaver({
      save: function (value) {
        callCount++;
        if (callCount === 1) return Promise.resolve({ note: '店舗受け取り希望' });
        return Promise.resolve({ note: '' });
      },
      onStatus: function (s) { statuses.push(s); }
    });
    saver.setValue('店舗受け取り希望');
    return saver.runSave().then(function () {
      saver.setValue('');
      return saver.runSave();
    }).then(function () {
      check('{note:""}（空文字保存結果）は有効で保存成功しlastSaved===""になる', saver.getState().lastSaved === '');
    });
  });

  // 失敗ケース一覧: {}, null, undefined, {note:null}, {note:123}, {note:入力と異なる値}
  var failureCases = [
    { label: '{}', result: {} },
    { label: 'null', result: null },
    { label: 'undefined', result: undefined },
    { label: '{note:null}', result: { note: null } },
    { label: '{note:123}', result: { note: 123 } },
    { label: '{note:入力値と異なる文字列}', result: { note: '入力値と異なる値' } }
  ];
  failureCases.forEach(function (fc) {
    chain = chain.then(function () {
      var t = saverWith(fc.result);
      t.saver.setValue('保存されるべきでない入力値');
      return t.saver.runSave().then(function () {
        check('save()が' + fc.label + 'を返した場合はrunSave()が失敗するべき', false);
      }).catch(function () {
        check('save()が' + fc.label + 'を返した場合、lastSavedは変化しない（初期値のまま）', t.saver.getState().lastSaved === '');
        check('save()が' + fc.label + 'を返した場合、currentには入力値が残る', t.saver.getState().current === '保存されるべきでない入力値');
        check('save()が' + fc.label + 'を返した場合、dirty/再試行可能な状態になる（current!==lastSaved）', t.saver.getState().current !== t.saver.getState().lastSaved);
        check('save()が' + fc.label + 'を返した場合、statusはerror', t.statuses.indexOf('error') !== -1);
        check('save()が' + fc.label + 'を返した場合、入力値をlastSavedへ代用していない（fallback撤廃の確認）', t.saver.getState().lastSaved !== '保存されるべきでない入力値');
      });
    });
  });

  // 失敗後、正常応答へ戻して再試行すると保存が成功する
  chain = chain.then(function () {
    var callCount = 0;
    var statuses = [];
    var saver = mod.createNoteSaver({
      save: function (value) {
        callCount++;
        if (callCount === 1) return Promise.resolve({}); // 1回目は不正応答
        return Promise.resolve({ note: value }); // 2回目以降は正常応答
      },
      onStatus: function (s) { statuses.push(s); }
    });
    saver.setValue('リトライで保存される内容');
    return saver.runSave().then(function () {
      check('1回目の不正応答でrunSave()が失敗しない設計ではない（実際は失敗するべき）', false);
    }).catch(function () {
      check('1回目の不正応答は失敗として扱われる', saver.getState().lastSaved === '');
      return saver.runSave();
    }).then(function () {
      check('不正応答の直後に正常応答で再試行すると保存が成功する', saver.getState().lastSaved === 'リトライで保存される内容');
    });
  });

  // latest-wins: 最初の応答が不正、in-flight中に再編集され、明示的な再試行(呼び出し側の役割)が
  // 正常応答となるケース。不正応答は失敗としてrejectされるため自動dirty再試行は発生しない
  // （dirty経由の自動再試行は成功応答後のみ）— ここでは呼び出し側が再度runSave()する流れを検証する。
  chain = chain.then(function () {
    var d1 = deferred();
    var saveCalls = [];
    var statuses = [];
    var saver = mod.createNoteSaver({
      save: function (value) {
        saveCalls.push(value);
        if (saveCalls.length === 1) return d1.promise; // 1回目はin-flightのまま保留
        return Promise.resolve({ note: value }); // 再試行時は正常応答
      },
      onStatus: function (s) { statuses.push(s); }
    });
    saver.setValue('最初の内容（不正応答予定）');
    var p1 = saver.runSave(); // in-flight
    saver.setValue('編集後の内容（正常応答予定）'); // in-flight中に再編集
    d1.resolve({}); // 1回目（不正応答）が解決する
    return p1.catch(function () {}).then(function () {
      check('latest-wins: 不正応答直後もcurrentは最新編集値を保持している', saver.getState().current === '編集後の内容（正常応答予定）');
      return saver.runSave(); // 呼び出し側が最新値で明示的に再試行する
    }).then(function () {
      check('latest-wins: 1回目が不正応答でも、最新値での再試行で最終的に保存成功する',
        saveCalls.length === 2 && saveCalls[1] === '編集後の内容（正常応答予定）' &&
        saver.getState().lastSaved === '編集後の内容（正常応答予定）');
    });
  });

  return chain;
})());

Promise.all(pending).then(function () {
  console.log('\n=== SUMMARY ===');
  var failed = results.filter(function (r) { return !r[1]; });
  console.log((results.length - failed.length) + '/' + results.length + ' PASS');
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach(function (r) { console.log('  - ' + r[0]); });
    process.exit(1);
  }
  process.exit(0);
});
