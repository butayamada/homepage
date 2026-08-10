/* =====================================================
   ARC FUKAMEKI — チャットKB（クローズド型・逐語回答のみ）
   運用ループ: エスカレーションで届いた質問に店主が回答したら、
   そのQ&Aをここに3言語で追記する。answerは登録文の逐語出力のみで、
   chat_widget.js は生成・要約・言い換えを一切行わない。

   ガバナンス項目（chat_core.js が判定に使用）:
   - state: "active"（回答可）| "review_required"（店主確認待ち・回答不可）
            | "disabled"（無効・回答不可）
   - authority: この回答の根拠元。"website"（本サイトのページ記載内容）
            | "shopify"（Shopify側の設定・データ）| "owner_script"（店主承認済みスクリプト・原文）
   - reviewedAt: 最終確認日（YYYY-MM-DD）
   - validFrom / validUntil: 有効期間（YYYY-MM-DD、null=無期限側）。
     現在日がこの範囲外の項目は state に関わらず回答不可（chat_core.jsが判定）。
   ===================================================== */
// Node（回帰テスト）から require() してもエラーにならないよう window が無い環境ではglobalへ
// （shop_config.js と同方針）。ブラウザでの挙動は従来通り window.CHAT_KB のまま。
var CHAT_ROOT = typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this);
CHAT_ROOT.CHAT_KB = [
  {
    id: "hours",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["営業時間", "何時から", "何時まで", "opening hours", "open hours"],
    keywords: ["営業", "時間", "何時", "オープン", "hours", "open", "close", "时间", "营业"],
    answer: {
      ja: "営業時間は 13:00–18:00 です。定休日は不定休のため、営業カレンダーをご確認ください。",
      en: "We are open 13:00–18:00. Closing days are irregular — please check the business calendar.",
      zh: "营业时间为 13:00–18:00。休息日不定期，请查看营业日历。"
    },
    source: { label: "営業カレンダー", href: "calendar_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "closed_days",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["定休日", "休み", "何曜日休み", "closed days"],
    keywords: ["定休", "休み", "休業", "閉まってる", "closed", "holiday", "休息"],
    answer: {
      ja: "定休日は不定休です。営業カレンダーで営業日をご確認ください。",
      en: "Closing days are irregular. Please check the business calendar for open days.",
      zh: "休息日不定期，请查看营业日历确认营业日。"
    },
    source: { label: "営業カレンダー", href: "calendar_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "access",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["アクセス", "住所", "場所", "行き方", "access", "address", "location"],
    keywords: ["アクセス", "住所", "場所", "行き方", "駅", "access", "address", "location", "地址", "交通"],
    answer: {
      ja: "住所は〒562-0001 大阪府箕面市箕面2丁目3-10、阪急電鉄箕面線箕面駅より徒歩5分です。駐車場についてはお問い合わせください。",
      en: "Our address is 2-3-10 Minoh, Minoh-shi, Osaka 562-0001 — a 5-minute walk from Hankyu Minoh Station.",
      zh: "地址为大阪府箕面市箕面2丁目3-10，从阪急电铁箕面线箕面站步行5分钟可达。"
    },
    source: { label: "店舗情報", href: "access_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "exhibition_current",
    category: "exhibition",
    // review_required: 2026-07-25に会期終了済みの「ナツメク」を現在開催中として
    // 回答してしまう問題が確認されているため、店主確認まで回答不可とする。
    // 回答文自体は推測で書き換えず、登録済みの原文のまま保持する。
    state: "review_required",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: "2026-07-25",
    q: ["企画展", "展示情報", "今の展示", "current exhibition", "現在の展示"],
    keywords: ["企画展", "展示", "展覧会", "ナツメク", "exhibition", "展览"],
    answer: {
      ja: "現在の企画展は「ナツメク」（2026.07.18–07.25）。deco＋、noragrassworks、fika、BRASSYARDの4組によるグループ展です。",
      en: "The current exhibition is \"Natsumeku\" (2026.07.18–07.25), a group show by deco+, noragrassworks, fika, and BRASSYARD.",
      zh: "当前展览为「夏目」（2026.07.18–07.25），由 deco+、noragrassworks、fika、BRASSYARD 四组作家共同展出。"
    },
    source: { label: "企画展", href: "event_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "exhibition_next",
    category: "exhibition",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    // event_test.html の Next Exhibitions 一覧と一致することを確認済み。
    // 一覧の先頭「処暑、線を辿る」が始まる前日までを有効期限とし、
    // それ以降は自動的に回答不能にして店主の再確認を促す。
    validUntil: "2026-08-21",
    q: ["次の展示", "今後の展示予定", "next exhibition", "upcoming exhibition"],
    keywords: ["次回", "今後", "予定", "next", "upcoming", "以后", "接下来"],
    answer: {
      ja: "次回以降の展示予定: 「処暑、線を辿る」(8/22–8/30)、「yoshida pottery 個展」(9/12–9/20)、「ヂェン先生の日常着展」(10/3–10/10)、「端田敏也 個展」(10/24–11/1)です。",
      en: "Upcoming exhibitions: Aug 22–30, Sep 12–20, Oct 3–10, and Oct 24–Nov 1 — see the exhibition section for details.",
      zh: "接下来的展览安排：8/22–8/30、9/12–9/20、10/3–10/10、10/24–11/1，详情请查看展览版块。"
    },
    source: { label: "企画展", href: "event_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "online_shop",
    category: "shop",
    // review_required: 「現在はBASEのみ」という説明が、現在進行中のShopify移行
    // （リニューアルテストページでのカート実装等）と整合しないため、
    // 店主確認まで回答不可とする。回答文は推測で書き換えず原文のまま保持する。
    state: "review_required",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["オンライン購入", "通販", "ネットで買える", "online shop", "buy online"],
    keywords: ["オンライン", "通販", "ネット", "購入", "買う", "online", "buy", "purchase", "网上", "购买"],
    answer: {
      ja: "現在はBASEのオンラインショップにて商品をご購入いただけます。商品ページの「購入はこちら」からお進みください。",
      en: "Online purchases are currently handled via our BASE shop. Use the \"Purchase\" link on each product page.",
      zh: "目前可通过BASE网店购买商品，请点击商品页面的「立即购买」链接。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "contact",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["問い合わせ", "連絡先", "メールで質問", "contact", "how to contact"],
    keywords: ["問い合わせ", "連絡", "メール", "contact", "email", "联系", "咨询"],
    answer: {
      ja: "お問合せフォームよりご連絡ください。通常、ご返信までに2〜3営業日を要します。",
      en: "Please use our contact form. We usually reply within 2–3 business days.",
      zh: "请通过咨询表单联系我们，通常会在2-3个工作日内回复。"
    },
    source: { label: "お問合せ", href: "contact_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "instagram",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["インスタ", "instagram", "sns"],
    keywords: ["インスタ", "instagram", "sns", "ig"],
    answer: {
      ja: "Instagramは @arcfukameki_minoh です。最新情報を発信しています。",
      en: "Follow us on Instagram at @arcfukameki_minoh for the latest updates.",
      zh: "Instagram账号为 @arcfukameki_minoh，会发布最新信息。"
    },
    source: { label: "Instagram", href: "https://www.instagram.com/arcfukameki_minoh" },
    updated: "2026-07-11"
  },
  {
    id: "product_categories",
    category: "shop",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["どんな商品", "取扱い商品", "扱っているもの", "what products"],
    keywords: ["商品", "陶器", "硝子", "ガラス", "木工", "布", "ファブリック", "products", "ceramics", "glass", "woodwork", "fabric", "商品种类"],
    answer: {
      ja: "陶器・ガラス・木工・布・照明など、作家の手仕事による生活道具を扱っています。",
      en: "We carry handmade ceramics, glass, woodwork, fabric, and lighting from craftspeople.",
      zh: "我们经营陶瓷、玻璃、木工、布艺、灯具等手工艺生活用品。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "artists",
    category: "shop",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["作家について", "作家一覧", "誰が作ってる", "about the artists"],
    keywords: ["作家", "作り手", "artist", "artists", "craftsperson", "作者"],
    answer: {
      ja: "作家ごとの一覧は商品紹介ページの「作家別」タブからご覧いただけます。",
      en: "You can browse by artist using the \"By Artist\" tab on the product page.",
      zh: "可以在商品页面的「按作家」标签中按作家浏览。"
    },
    source: { label: "作家別", href: "products_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "stock",
    category: "shop",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["在庫ある", "在庫確認", "売り切れ", "is it in stock"],
    keywords: ["在庫", "売り切れ", "soldout", "stock", "availability", "库存", "缺货"],
    answer: {
      ja: "在庫は商品ページの表示をご確認ください。確実な確認をご希望の場合はお問い合わせください。",
      en: "Please check the product page for current availability. Contact us if you'd like a definite confirmation.",
      zh: "请查看商品页面确认库存。如需确认，请通过咨询表单联系我们。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-07-11"
  },
  {
    id: "payment_instore",
    category: "store",
    state: "active",
    authority: "website",
    reviewedAt: "2026-08-10",
    validFrom: null,
    validUntil: null,
    q: ["支払い方法", "決済方法", "payment method"],
    keywords: ["支払い", "決済", "現金", "クレジット", "payment", "cash", "credit", "paypay", "支付", "付款"],
    answer: {
      ja: "店頭でのお支払いは現金、クレジットカード、PayPayに対応しています。",
      en: "In-store payment methods: cash, credit card, and PayPay.",
      zh: "店内支付方式支持现金、信用卡和PayPay。"
    },
    source: { label: "店舗情報", href: "access_test.html" },
    updated: "2026-07-11"
  }
];

/* 同義語辞書: マッチング前に本文中の語をKBの代表語へ正規化置換する */
CHAT_ROOT.CHAT_SYNONYMS = {
  "開いてる": "営業",
  "空いてる": "営業",
  "オープンしてる": "営業",
  "閉まってる": "定休",
  "クローズド": "定休",
  "休業": "定休",
  "行き方": "アクセス",
  "場所": "アクセス",
  "地図": "アクセス",
  "展覧会": "企画展",
  "展示会": "企画展",
  "イベント": "企画展",
  "通販": "オンライン購入",
  "ネット購入": "オンライン購入",
  "買える": "購入",
  "連絡先": "問い合わせ",
  "問合せ": "問い合わせ",
  "メール": "問い合わせ",
  "パーキング": "駐車場",
  "決済": "支払い"
};
