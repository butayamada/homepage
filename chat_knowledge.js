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
    // owner_script: 店主承認済みの模範回答（Phase2）。会期終了済みの「ナツメク」を
    // 現在開催中と回答していた問題を解消し、次回展示への案内に更新した。
    // validUntilを過ぎたら期限切れとして自動的に回答不能になり、店主の再確認を促す。
    state: "active",
    authority: "owner_script",
    reviewedAt: "2026-08-10",
    validFrom: "2026-08-10",
    validUntil: "2026-08-21",
    // F-03: 「企画展」「展示情報」等の汎用語をqから削除し、企画展に関するあらゆる
    // 質問（作家・販売方法・オンライン開始日等）を吸着していた誤ルーティングを解消。
    // 「現在開催中かどうか」を明示的に尋ねる表現だけをqへ登録する。汎用語はkeywordsに
    // 残すが、keywordsだけではMATCH_THRESHOLD(3)へ到達しない（+1ずつのため）。
    // F-04B: exhibition_nextと同時に閾値以上でマッチした場合、片方だけを回答せず
    // MULTI_INTENTでescalateする（chat_core.jsのfindConflictPair参照）。
    q: [
      "現在の企画展", "今の企画展", "現在の展示", "今の展示", "開催中の企画展", "今やっている企画展",
      "current exhibition", "what is the current exhibition", "what exhibition is currently on", "what exhibition is on now",
      "当前展览", "现在的展览", "目前有什么展览"
    ],
    keywords: ["企画展", "展示", "展覧会", "exhibition", "展览"],
    conflictsWith: ["exhibition_next"],
    answer: {
      ja: "現在開催中の企画展はありません。次回は8月22日から30日まで「処暑、線を辿る」を開催予定です。詳しくは企画展ページをご確認ください。",
      en: "There is no exhibition currently in progress. Our next exhibition, “処暑、線を辿る,” is scheduled for August 22–30. Please see the exhibition page for details.",
      zh: "目前没有正在举办的企划展。下一场「処暑、線を辿る」计划于8月22日至30日举行。详情请查看企划展页面。"
    },
    source: { label: "企画展", href: "event_test.html" },
    updated: "2026-08-10"
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
    // F-03: 「次の展示」「next exhibition」「upcoming exhibition」等の広すぎる部分一致qを
    // 削除し、日程・予定を具体的に尋ねる表現へ限定。作家・販売方法・オンライン開始日
    // を尋ねる質問（現在の登録回答では直接答えられない）はここへもマッチさせない。
    // F-04A: 「次の企画展はいつですか」等の日程表現を追加。
    // F-04B: exhibition_currentと同時に閾値以上でマッチした場合はMULTI_INTENTでescalate。
    q: [
      "次の企画展はいつからですか", "次回の企画展はいつですか", "次の展示はいつからですか",
      "次の企画展の会期はいつまでですか", "今後の展示予定を教えてください",
      "次の企画展はいつですか", "次の企画展はいつ", "次回の日程", "次の企画展の日程", "次回展示の日程",
      "When is your next exhibition?", "What are your upcoming exhibition dates?", "When does the next exhibition start?",
      "when is the next exhibition", "next exhibition dates", "when is the next",
      "下一次展览什么时候开始", "接下来的展览日期是什么", "今后有什么展览安排",
      "下一次展览是什么时候", "下次展览的日期", "下一次展览什么时候"
    ],
    keywords: ["次回", "今後", "予定", "next", "upcoming", "以后", "接下来"],
    conflictsWith: ["exhibition_current"],
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
    // owner_script: 店主承認済みの模範回答（Phase2）。「現在はBASEのみ」という
    // 旧回答がShopify移行状況と整合しない問題を解消し、BASE案内＋新オンライン
    // ストア準備中の案内に更新した。validUntilを過ぎたら期限切れとして
    // 自動的に回答不能になり、店主の再確認を促す。
    state: "active",
    authority: "owner_script",
    reviewedAt: "2026-08-10",
    validFrom: "2026-08-10",
    validUntil: "2026-08-31",
    // F-03: 自然な問い合わせ文言を追加（回答本文・state・authority・有効期間は無変更）。
    q: [
      "オンライン購入", "通販", "ネットで買える", "online shop", "buy online",
      "オンラインでの購入方法を教えてください", "オンラインで購入するにはどうすればいいですか",
      "How can I buy online?", "如何在线购买商品"
    ],
    keywords: ["オンライン", "通販", "ネット", "購入", "買う", "online", "buy", "purchase", "网上", "购买"],
    answer: {
      ja: "現在、オンラインでの商品購入はBASEショップをご利用ください。新しいオンラインストアは準備中です。公開後は本ホームページからご案内します。",
      en: "Online purchases are currently available through our BASE shop. A new online store is in preparation. We will announce it on this website after it opens.",
      zh: "目前可通过BASE网店在线购买商品。新的在线商店正在筹备中，公开后将在本网站通知。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-08-10"
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
    // F-03: 自然な問い合わせ文言を追加。
    q: [
      "どんな商品", "取扱い商品", "扱っているもの", "what products",
      "どんな商品を売っていますか", "何を取り扱っていますか",
      "What kinds of products do you sell?", "你们销售什么商品"
    ],
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
    // F-03: 自然な問い合わせ文言を追加。
    q: [
      "作家について", "作家一覧", "誰が作ってる", "about the artists",
      "作家さんについて教えてください", "どんな作家さんの商品がありますか",
      "Can you tell me about the artists?", "请介绍一下商品的作者"
    ],
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
    q: [
      "在庫ある", "在庫確認", "売り切れ", "is it in stock",
      "在庫はありますか", "在庫がありますか", "在庫ありますか", "在庫は残っていますか", "まだ在庫はありますか",
      "Is this in stock?", "Is this item in stock?", "Do you have this in stock?", "Is it available?",
      "有库存吗", "还有库存吗"
    ],
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
  },
  {
    // Phase3-C: 店主承認済みの模範回答。特定商品の実寸・重量・素材や、追加撮影の
    // 可否を推測で回答せず、必ず店主確認へ誘導する定型文。
    id: "product_additional_photos",
    category: "shop",
    state: "active",
    authority: "owner_script",
    reviewedAt: "2026-08-10",
    validFrom: "2026-08-10",
    validUntil: null,
    q: [
      "追加写真を見せてください", "詳しい写真はありますか", "裏面の写真を見たいです", "側面の写真を見せてください",
      "別の角度から見たいです", "傷に見える部分を確認したいです",
      "Can I see more photos?", "Do you have additional photos?", "Can I see the back of the item?", "Can I see it from another angle?",
      "可以看更多照片吗", "有追加的照片吗", "可以看商品背面的照片吗", "可以从其他角度看吗",
      // F-04と同方針: 特定の複合質問（product_specsとの同時言及）だけを対象にした
      // 明確なフレーズを個別に登録する。単独の「写真」等の汎用語では閾値に届かない。
      "サイズと追加写真", "重さと裏面の写真", "tell me the size and show me more photos", "请告诉我尺寸并提供更多照片"
    ],
    keywords: ["写真", "追加", "裏面", "側面", "角度", "photo", "photos", "照片"],
    conflictsWith: ["product_specs"],
    answer: {
      ja: "商品ページに掲載している写真をご確認ください。追加写真をご希望の場合は、商品名と確認したい箇所を具体的にお知らせください。商品の状況により、追加撮影や写真の送付ができない場合があります。",
      en: "Please check the photos shown on the product page. If you would like additional photos, tell us the product name and the specific area you would like to see. Depending on the product’s circumstances, we may not be able to take or send additional photos.",
      zh: "请先查看商品页面中刊载的照片。如需更多照片，请告知商品名称以及希望确认的具体部位。根据商品情况，我们可能无法补拍或发送照片。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-08-10"
  },
  {
    // Phase3-C: 店主承認済みの模範回答。KBにない実寸・重量・素材の具体値を
    // 推測で生成しない。記載がない場合・個体差の確認は店主へ誘導する。
    id: "product_specs",
    category: "shop",
    state: "active",
    authority: "owner_script",
    reviewedAt: "2026-08-10",
    validFrom: "2026-08-10",
    validUntil: null,
    q: [
      "サイズを教えてください", "大きさを教えてください", "重さはどれくらいですか", "素材は何ですか", "個体差はありますか",
      "商品ページにサイズがありません",
      "What size is it?", "How much does it weigh?", "What material is it made from?", "Are there individual variations?",
      "商品尺寸是多少", "商品有多重", "是什么材质", "有个体差异吗",
      // F-04と同方針: product_additional_photosとの複合質問を検出するための
      // 明確なフレーズ。単独の「サイズ」等の汎用語は追加しない。
      "サイズと追加写真", "重さと裏面の写真", "tell me the size and show me more photos", "请告诉我尺寸并提供更多照片"
    ],
    keywords: ["サイズ", "大きさ", "重さ", "素材", "個体差", "size", "weight", "material", "尺寸", "材质"],
    conflictsWith: ["product_additional_photos"],
    answer: {
      ja: "サイズ・重さ・素材は、商品ページに記載されている情報をご確認ください。記載がない場合や、個体差について確認したい場合は、商品名と確認事項をお知らせください。チャットでは推測せず、店主へ確認します。",
      en: "Please check the product page for information about size, weight, and materials. If the information is not listed or you would like to ask about individual variations, tell us the product name and what you would like to confirm. The chat will not guess; it will ask the shop owner to confirm.",
      zh: "尺寸、重量和材质请查看商品页面中的信息。如页面未记载，或希望确认个体差异，请告知商品名称及需要确认的事项。聊天不会推测，而会向店主确认。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-08-10"
  },
  {
    // Phase3-C: 店主は文面を承認済みだが、Shopify同時購入・売り越し防止監査が
    // 未完了のためreview_requiredのまま維持する。Shopify同時購入監査完了後に
    // active化を再検討する。顧客へは絶対に回答せず、店主確認へ誘導する。
    id: "cart_inventory_reservation",
    category: "shop",
    state: "review_required",
    authority: "owner_script",
    blocksAnswerWhenMatched: true,
    reviewedAt: "2026-08-10",
    validFrom: "2026-08-10",
    validUntil: null,
    q: [
      "カートに入れたら在庫は確保されますか", "カートに入れた商品は取り置きされますか", "カートに入れたのに売り切れました",
      "カートに商品を入れておいたのに売り切れ", "カートに追加したのに在庫がなくなっていた",
      "Does adding it to my cart reserve it?", "Is an item held when it is in my cart?",
      "why did the item in my cart become sold out", "the product in my cart is now out of stock",
      "加入购物车后会保留库存吗", "购物车里的商品怎么变成缺货了",
      "カートに入れた商品はまだ在庫がありますか", "カートに入れた商品の在庫はありますか", "カートの商品の在庫はありますか",
      "Is the item in my cart still in stock?", "Is the product in my cart still available?",
      "购物车里的商品还有库存吗"
    ],
    keywords: ["カート", "在庫確保", "cart", "reserve", "购物车"],
    answer: {
      ja: "商品をカートに入れただけでは、在庫は確保されません。お手続き中に他のお客様の注文が先に完了した場合、売り切れとなることがあります。",
      en: "Adding an item to your cart does not reserve inventory. If another customer completes their order first while you are checking out, the item may become sold out.",
      zh: "仅将商品加入购物车并不会保留库存。如果其他顾客在您办理购买手续期间先完成订单，商品可能会售罄。"
    },
    source: { label: "商品紹介", href: "products_test.html" },
    updated: "2026-08-10"
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
