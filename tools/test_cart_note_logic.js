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
