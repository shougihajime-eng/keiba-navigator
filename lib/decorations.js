/* =====================================================================
   KEIBA NAVIGATOR — decorations.js  (Wave22)
   役割:
     1) 画面左右の余白に「走る馬」「名馬の名言」「蹄跡」「ターフ装飾」を配置
     2) 名馬列伝・名言を一定間隔でローテーション
     3) 章 (Chapter) 区切りを動的に挿入して情報密度を下げる
     4) reduced-motion ユーザーには全アニメ停止
   ===================================================================== */
(function () {
  "use strict";

  const prefersReduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ───────────────────────────────────────────────────────────
  //  名馬列伝 (歴史的名馬 + 一行で語れるエピソード)
  // ───────────────────────────────────────────────────────────
  const LEGENDS = [
    { name: "シンザン",          aka: "五冠馬",            year: "1961",  story: "戦後初の三冠 + 天皇賞春 + 有馬記念。「鉄の馬」と呼ばれた不沈艦。" },
    { name: "ハイセイコー",      aka: "怪物",              year: "1970",  story: "地方競馬出身の社会現象。日本中が熱狂し、競馬ブームを作った。" },
    { name: "テンポイント",      aka: "流星の貴公子",      year: "1973",  story: "気品ある芦毛の三冠候補。日本ダービー後の故障から伝説に。" },
    { name: "ミスターシービー",  aka: "巨漢",              year: "1980",  story: "差し追い込みの三冠馬。クラシック三冠を 27 年ぶりに達成。" },
    { name: "シンボリルドルフ",  aka: "皇帝",              year: "1981",  story: "無敗三冠 + 有馬記念連覇 + ジャパンカップ制覇。完璧な馬。" },
    { name: "オグリキャップ",    aka: "芦毛の怪物",        year: "1985",  story: "地方→中央→引退の有馬記念で号泣の優勝。武豊と国民の希望。" },
    { name: "メジロマックイーン",aka: "白い貴公子",        year: "1987",  story: "天皇賞春連覇 + ステイヤーの究極。気品と血統が見せる王道。" },
    { name: "トウカイテイオー",  aka: "奇跡の復活",        year: "1988",  story: "1 年休養明けで有馬記念優勝。「奇跡の名馬」と称された。" },
    { name: "ナリタブライアン",  aka: "シャドーロールの怪物",year: "1991", story: "圧倒的三冠 + 有馬記念。シャドーロールの黒い影は今も伝説。" },
    { name: "サイレンススズカ",  aka: "サイレントランナー",year: "1994",  story: "逃げて逃げて逃げ切る。武豊との快進撃は刹那的な美しさ。" },
    { name: "エルコンドルパサー",aka: "コンドル",          year: "1995",  story: "凱旋門賞 2 着で日本馬の世界進出を予告した先駆者。" },
    { name: "ステイゴールド",    aka: "悲願の GI",         year: "1994",  story: "50 回近く GI に挑戦。7 歳で香港ヴァーズ制覇。父系の祖。" },
    { name: "テイエムオペラオー",aka: "世紀末覇王",        year: "1996",  story: "2000 年 GI 5 勝 + 重賞 7 勝。「年間無敗」の絶対王者。" },
    { name: "ディープインパクト",aka: "翼があるかのよう",  year: "2002",  story: "無敗三冠 + ジャパンカップ + 凱旋門 3 着。「飛んでいる」と評された天才。" },
    { name: "ウオッカ",          aka: "牝馬の革命児",      year: "2004",  story: "牝馬で 64 年ぶり日本ダービー制覇。芝マイル&中距離の女傑。" },
    { name: "オルフェーヴル",    aka: "金色の暴君",        year: "2008",  story: "三冠 + 有馬記念 + 凱旋門賞 2 着 2 回。気性難と天才性が同居。" },
    { name: "ゴールドシップ",    aka: "ゴルシ",            year: "2009",  story: "気まぐれな天才。出遅れても勝つ、勝つときは派手に勝つ。" },
    { name: "ジェンティルドンナ",aka: "貴婦人",            year: "2009",  story: "牝馬三冠 + 牡馬撃破ジャパンカップ連覇。世界の女王。" },
    { name: "キタサンブラック",  aka: "みんなの春",        year: "2012",  story: "GI 7 勝。北島三郎が共有馬主、引退時は競馬場が涙に包まれた。" },
    { name: "アーモンドアイ",    aka: "牝馬三冠の女王",    year: "2015",  story: "GI 9 勝の歴代記録。日本馬最高峰、最速の女王。" },
    { name: "コントレイル",      aka: "無敗の三冠",        year: "2017",  story: "シンボリルドルフ・ディープに続く無敗三冠。父子無敗三冠を達成。" },
    { name: "イクイノックス",    aka: "世界 No.1",         year: "2019",  story: "天皇賞秋・ジャパンカップ・有馬記念連勝。Longines レート世界 1 位。" },
  ];

  // ───────────────────────────────────────────────────────────
  //  名言 (騎手・調教師・競馬を生きる人々の言葉)
  // ───────────────────────────────────────────────────────────
  const QUOTES = [
    { text: "勝つために走るのではない。走るために生まれた。", by: "— 名馬の宿命" },
    { text: "馬は嘘をつかない。嘘をつくのはいつも人間だ。", by: "— ある厩務員" },
    { text: "完璧な馬などいない。完璧に近づこうとする馬がいる。", by: "— 調教師の口癖" },
    { text: "一番強い馬が勝つとは限らない。一番タイミングを掴んだ馬が勝つ。", by: "— 古今の鉄則" },
    { text: "見送りも投資。買わない勇気が長期の勝者を作る。", by: "— 期待値の哲学" },
    { text: "期待値プラスを 100 回続けたら、確率はあなたの味方になる。", by: "— 数学の福音" },
    { text: "オッズは群衆の声。本物の声は馬の中にある。", by: "— 競馬の真理" },
    { text: "1 R の結果は運。100 R の結果は実力。", by: "— ベテランの教え" },
    { text: "勝った日は静かに。負けた日はもっと静かに。", by: "— 馬券師の流儀" },
    { text: "本命を信じる勇気。穴を見抜く目。両方なくして勝者はない。", by: "— 競馬予想の極意" },
    { text: "良い騎手は風を読む。最高の騎手は馬の心を読む。", by: "— ホースマンの誇り" },
    { text: "勝負どころは 4 コーナーじゃない。買い目を決めた瞬間だ。", by: "— ある馬券師" },
    { text: "競馬は数字のスポーツ。だが、最後の 1 ハロンは魂が走る。", by: "— ターフの詩人" },
    { text: "オグリが教えてくれた。「諦めない」は時に「奇跡」と呼ばれる。", by: "— 1990 有馬記念" },
    { text: "馬券を買う前に、自分の心拍数を測れ。", by: "— 平常心の戒め" },
    { text: "ベストの 1 点。ただそれだけが、回収率を上に押し上げる。", by: "— 必殺の流儀" },
    { text: "情報を集めすぎると、確信は逆に薄まる。", by: "— 過剰分析の罠" },
    { text: "予想は科学。馬券は芸術。", by: "— 両輪の格言" },
    { text: "ディープは飛んでいた。あれは競馬ではなく、別の何かだった。", by: "— 2005 日本ダービー" },
    { text: "1 着を見抜く目より、2 着を絞れる目を磨け。", by: "— ワイドの真髄" },
    { text: "馬を信じることは、自分の予想を信じること。", by: "— ある馬主" },
    { text: "勝負服の色には意味がある。馬券の色 (券種) にも意味を持たせよ。", by: "— 馬券設計" },
    { text: "去年勝った馬は、去年強かっただけ。今年勝つのは今年強い馬。", by: "— 時の流れ" },
    { text: "オッズは過去の知識。実力は未来の事実。", by: "— 期待値の言葉" },
  ];

  // ───────────────────────────────────────────────────────────
  //  SVG アート (馬・蹄跡・トロフィー・フィニッシュフラッグ)
  //  ※ どれもインライン SVG・currentColor で色制御可能
  // ───────────────────────────────────────────────────────────
  function svgRunningHorse() {
    // 疾走する馬のシルエット (右向き)
    return `
<svg viewBox="0 0 240 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="rhg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#34d399"/>
      <stop offset="55%"  stop-color="#10b981"/>
      <stop offset="100%" stop-color="#047857"/>
    </linearGradient>
  </defs>
  <g fill="url(#rhg)">
    <!-- 胴体 -->
    <path d="M40,110 Q60,80 100,82 Q140,80 175,90 Q200,98 210,110 Q200,125 180,128 Q170,142 175,158 Q172,162 167,160 Q158,150 158,138 L140,140 Q138,160 132,164 Q126,162 128,148 L112,148 Q108,168 102,172 Q96,168 100,154 L86,154 Q80,170 74,172 Q70,166 76,150 Q60,144 50,132 Q44,122 40,110 Z"/>
    <!-- 首 -->
    <path d="M30,90 Q34,72 50,62 Q66,55 76,60 Q70,72 64,80 Q56,90 50,98 Q44,102 38,100 Q32,96 30,90 Z"/>
    <!-- 顔 -->
    <path d="M40,55 Q48,45 60,42 Q72,40 78,46 Q82,52 78,58 Q70,62 60,62 Q50,60 44,60 Q40,58 40,55 Z"/>
    <!-- 耳 -->
    <path d="M60,40 L64,30 L70,42 Z"/>
    <!-- たてがみ -->
    <path d="M55,55 Q40,60 30,82 Q40,80 50,75 Q60,68 55,55 Z" opacity="0.85"/>
    <!-- しっぽ -->
    <path d="M205,108 Q230,100 234,112 Q230,124 218,128 Q210,124 205,118 Z"/>
  </g>
  <!-- 目 -->
  <circle cx="58" cy="51" r="2" fill="#0f172a"/>
</svg>`;
  }

  function svgHorseProfile() {
    // 横顔のミニマル馬 (高貴な雰囲気)
    return `
<svg viewBox="0 0 160 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="hpg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fbbf24"/>
      <stop offset="50%"  stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
  </defs>
  <g fill="url(#hpg)">
    <!-- 顔 -->
    <path d="M40,160 Q35,130 38,110 Q42,90 48,72 Q54,55 62,42 Q70,30 80,28 Q90,30 96,40 Q100,55 98,72 Q96,90 92,108 Q92,120 94,130 L90,140 L82,140 L82,160 Z"/>
    <!-- 耳 -->
    <path d="M62,38 L60,20 L72,32 Z"/>
    <path d="M80,30 L84,12 L92,30 Z"/>
    <!-- たてがみ -->
    <path d="M64,42 Q50,55 42,80 Q48,72 60,68 Q70,62 72,52 Z" opacity="0.85"/>
  </g>
  <!-- 目 -->
  <ellipse cx="78" cy="58" rx="2.5" ry="3.5" fill="#0f172a"/>
</svg>`;
  }

  function svgHoofprint() {
    // 蹄跡
    return `
<svg viewBox="0 0 40 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="currentColor">
    <ellipse cx="20" cy="25" rx="13" ry="18" opacity="0.85"/>
    <ellipse cx="20" cy="35" rx="9" ry="6" fill="#fff" opacity="0.4"/>
  </g>
</svg>`;
  }

  function svgTrophy() {
    // G1 トロフィー
    return `
<svg viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="trg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#fde047"/>
      <stop offset="50%"  stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
  </defs>
  <g fill="url(#trg)">
    <!-- カップ本体 -->
    <path d="M30,30 L90,30 L86,80 Q80,95 60,98 Q40,95 34,80 Z"/>
    <!-- 取っ手 (左) -->
    <path d="M28,38 Q12,42 14,60 Q18,72 30,72 L32,62 Q22,60 22,52 Q22,46 30,46 Z"/>
    <!-- 取っ手 (右) -->
    <path d="M92,38 Q108,42 106,60 Q102,72 90,72 L88,62 Q98,60 98,52 Q98,46 90,46 Z"/>
    <!-- 台 -->
    <rect x="48" y="96" width="24" height="10"/>
    <path d="M36,108 L84,108 L80,124 L40,124 Z"/>
  </g>
  <text x="60" y="64" font-family="Inter, sans-serif" font-weight="900" font-size="22"
        text-anchor="middle" fill="#7c2d12">G1</text>
</svg>`;
  }

  function svgFinishFlag() {
    // チェッカーフラッグ
    return `
<svg viewBox="0 0 120 140" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="14" y="10" width="3" height="124" fill="#475569"/>
  <g>
    <rect x="17" y="12" width="80" height="60" fill="#0f172a"/>
    <g fill="#fff">
      <rect x="17" y="12" width="20" height="15"/>
      <rect x="57" y="12" width="20" height="15"/>
      <rect x="37" y="27" width="20" height="15"/>
      <rect x="77" y="27" width="20" height="15"/>
      <rect x="17" y="42" width="20" height="15"/>
      <rect x="57" y="42" width="20" height="15"/>
      <rect x="37" y="57" width="20" height="15"/>
      <rect x="77" y="57" width="20" height="15"/>
    </g>
  </g>
</svg>`;
  }

  function svgHorseshoe() {
    // ラッキー蹄鉄
    return `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path
    d="M20,15 Q20,5 50,5 Q80,5 80,15 L80,55 Q80,85 50,90 Q20,85 20,55 Z
       M32,18 L32,55 Q32,72 50,76 Q68,72 68,55 L68,18 Z"
    fill="currentColor" fill-rule="evenodd"/>
  <circle cx="26" cy="22" r="3" fill="#0f172a" opacity="0.4"/>
  <circle cx="74" cy="22" r="3" fill="#0f172a" opacity="0.4"/>
  <circle cx="26" cy="38" r="3" fill="#0f172a" opacity="0.4"/>
  <circle cx="74" cy="38" r="3" fill="#0f172a" opacity="0.4"/>
  <circle cx="28" cy="54" r="3" fill="#0f172a" opacity="0.4"/>
  <circle cx="72" cy="54" r="3" fill="#0f172a" opacity="0.4"/>
</svg>`;
  }

  function svgJockey() {
    // 騎手 (シルエット)
    return `
<svg viewBox="0 0 140 180" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="jkg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <g fill="url(#jkg)">
    <!-- ヘルメット -->
    <ellipse cx="70" cy="40" rx="22" ry="20"/>
    <rect x="48" y="42" width="44" height="8" rx="4"/>
    <!-- 胴体 -->
    <path d="M50,58 Q60,60 70,60 Q80,60 90,58 L100,95 Q102,108 95,118 L72,124 Q60,124 50,118 Q44,108 46,95 Z"/>
    <!-- 腕 (鞭) -->
    <path d="M92,72 L120,90 L116,96 L88,82 Z"/>
    <!-- 太もも -->
    <path d="M52,118 L66,118 L62,150 Q60,160 54,162 Q48,160 50,148 Z"/>
    <path d="M76,118 L92,118 L96,150 Q98,160 92,162 Q86,160 84,148 Z"/>
  </g>
</svg>`;
  }

  // ───────────────────────────────────────────────────────────
  //  名馬列伝 縦リスト DOM
  // ───────────────────────────────────────────────────────────
  function renderLegendsList(target, items, max) {
    const wrap = document.createElement("div");
    wrap.className = "margin-legends-list";
    const sub = items.slice(0, max || 6);
    sub.forEach((l) => {
      const row = document.createElement("div");
      row.className = "margin-legend-row";
      row.innerHTML = `
        <div class="ml-year">${l.year}</div>
        <div class="ml-block">
          <div class="ml-name">${l.name}</div>
          <div class="ml-aka">${l.aka}</div>
        </div>`;
      wrap.appendChild(row);
    });
    target.appendChild(wrap);
  }

  // ───────────────────────────────────────────────────────────
  //  ヒーロー名馬カード (3.5 秒ごとに切替)
  // ───────────────────────────────────────────────────────────
  function renderLegendHero(container) {
    container.innerHTML = "";
    const card = document.createElement("div");
    card.className = "margin-legend-hero";
    card.innerHTML = `
      <div class="mlh-tag">名馬列伝</div>
      <div class="mlh-name" id="mlh-name">—</div>
      <div class="mlh-aka"  id="mlh-aka">—</div>
      <div class="mlh-year" id="mlh-year">—</div>
      <div class="mlh-story" id="mlh-story">—</div>
    `;
    container.appendChild(card);

    let i = Math.floor(Math.random() * LEGENDS.length);

    function apply() {
      const l = LEGENDS[i % LEGENDS.length];
      const name = container.querySelector("#mlh-name");
      const aka  = container.querySelector("#mlh-aka");
      const year = container.querySelector("#mlh-year");
      const story= container.querySelector("#mlh-story");
      if (!name) return;
      name.textContent  = l.name;
      aka.textContent   = "「" + l.aka + "」";
      year.textContent  = "DEBUT " + l.year;
      story.textContent = l.story;
      if (!prefersReduceMotion) {
        card.classList.remove("mlh-in");
        // 強制リフロー
        void card.offsetWidth;
        card.classList.add("mlh-in");
      }
    }
    apply();
    if (!prefersReduceMotion) {
      setInterval(() => { i++; apply(); }, 9000);
    }
  }

  // ───────────────────────────────────────────────────────────
  //  名言カード (5.5 秒ごとに切替)
  // ───────────────────────────────────────────────────────────
  function renderQuoteCard(container) {
    container.innerHTML = "";
    const card = document.createElement("blockquote");
    card.className = "margin-quote-card";
    card.innerHTML = `
      <div class="mq-mark">"</div>
      <div class="mq-text" id="mq-text">—</div>
      <div class="mq-by"   id="mq-by">—</div>
    `;
    container.appendChild(card);

    let i = Math.floor(Math.random() * QUOTES.length);

    function apply() {
      const q = QUOTES[i % QUOTES.length];
      const t = container.querySelector("#mq-text");
      const b = container.querySelector("#mq-by");
      if (!t) return;
      t.textContent = q.text;
      b.textContent = q.by;
      if (!prefersReduceMotion) {
        card.classList.remove("mq-in");
        void card.offsetWidth;
        card.classList.add("mq-in");
      }
    }
    apply();
    if (!prefersReduceMotion) {
      setInterval(() => { i++; apply(); }, 7500);
    }
  }

  // ───────────────────────────────────────────────────────────
  //  蹄跡のトレイル (縦に並ぶ・スクロールでフェード)
  // ───────────────────────────────────────────────────────────
  function renderHoofTrail(container, count, side) {
    container.innerHTML = "";
    const trail = document.createElement("div");
    trail.className = "margin-hoof-trail " + (side === "right" ? "is-right" : "is-left");
    for (let i = 0; i < count; i++) {
      const wrap = document.createElement("div");
      wrap.className = "margin-hoof";
      wrap.style.opacity = String(0.10 + (i % 3) * 0.05);
      wrap.style.transform = `rotate(${i % 2 === 0 ? -8 : 8}deg) translateX(${i % 2 === 0 ? -8 : 8}px)`;
      wrap.style.animationDelay = (i * 0.4) + "s";
      wrap.innerHTML = svgHoofprint();
      trail.appendChild(wrap);
    }
    container.appendChild(trail);
  }

  // ───────────────────────────────────────────────────────────
  //  全体マウント
  // ───────────────────────────────────────────────────────────
  function mount() {
    if (document.querySelector(".margin-art-left")) return;  // 二重マウント防止

    const leftAside = document.createElement("aside");
    leftAside.className = "margin-art margin-art-left";
    leftAside.setAttribute("aria-hidden", "true");
    leftAside.innerHTML = `
      <div class="margin-section ms-horse">
        ${svgRunningHorse()}
        <div class="ms-caption">疾走する希望</div>
      </div>
      <div class="margin-section ms-quote" id="mq-mount-left"></div>
      <div class="margin-section ms-hooves" id="hoof-left"></div>
      <div class="margin-section ms-legend-hero" id="mlh-mount"></div>
      <div class="margin-section ms-jockey">
        ${svgJockey()}
        <div class="ms-caption">勝負服</div>
      </div>
    `;
    document.body.appendChild(leftAside);

    const rightAside = document.createElement("aside");
    rightAside.className = "margin-art margin-art-right";
    rightAside.setAttribute("aria-hidden", "true");
    rightAside.innerHTML = `
      <div class="margin-section ms-trophy">
        ${svgTrophy()}
        <div class="ms-caption">G1 へ</div>
      </div>
      <div class="margin-section ms-legends-list" id="legends-list-mount"></div>
      <div class="margin-section ms-finish">
        ${svgFinishFlag()}
        <div class="ms-caption">フィニッシュへ</div>
      </div>
      <div class="margin-section ms-quote" id="mq-mount-right"></div>
      <div class="margin-section ms-horseshoe">
        ${svgHorseshoe()}
        <div class="ms-caption">幸運の蹄鉄</div>
      </div>
      <div class="margin-section ms-profile">
        ${svgHorseProfile()}
        <div class="ms-caption">気高きサラブレッド</div>
      </div>
    `;
    document.body.appendChild(rightAside);

    // 子コンテンツを描画
    const leftQuote = leftAside.querySelector("#mq-mount-left");
    if (leftQuote) renderQuoteCard(leftQuote);

    const rightQuote = rightAside.querySelector("#mq-mount-right");
    if (rightQuote) renderQuoteCard(rightQuote);

    const legendHero = leftAside.querySelector("#mlh-mount");
    if (legendHero) renderLegendHero(legendHero);

    const legendsList = rightAside.querySelector("#legends-list-mount");
    if (legendsList) renderLegendsList(legendsList, LEGENDS.slice().sort(() => Math.random() - 0.5), 6);

    const hoofLeft = leftAside.querySelector("#hoof-left");
    if (hoofLeft) renderHoofTrail(hoofLeft, 8, "left");
  }

  // ───────────────────────────────────────────────────────────
  //  章 (Chapter) 区切りを動的に挿入
  // ───────────────────────────────────────────────────────────
  // Wave23: ユーザー指示「結論カード最優先・他は折りたたみ」に応えて
  // 章区切りは結論カードの上だけ。他は details の summary が代わりになる
  const CHAPTERS = [
    { sel: "#decision-mount",    num: "01", title: "今日の <em>絶好機</em>",      sub: "AI が選ぶ 本日いちばん買う 1 点", icon: "🎯" },
  ];

  function insertChapters() {
    CHAPTERS.forEach(ch => {
      let target;
      try { target = document.querySelector(ch.sel); } catch { return; }
      if (!target) return;
      if (target.previousElementSibling && target.previousElementSibling.classList.contains("chapter-divider")) return;

      const div = document.createElement("div");
      div.className = "chapter-divider";
      div.setAttribute("data-chapter", ch.num);
      div.innerHTML = `
        <div class="chapter-rail"></div>
        <div class="chapter-core">
          <div class="chapter-num">${ch.num}</div>
          <div class="chapter-block">
            <div class="chapter-icon" aria-hidden="true">${ch.icon}</div>
            <div class="chapter-title">${ch.title}</div>
            <div class="chapter-sub">${ch.sub}</div>
          </div>
        </div>
        <div class="chapter-rail"></div>
      `;
      target.parentNode.insertBefore(div, target);
    });
  }

  // ───────────────────────────────────────────────────────────
  //  Daily Headline (モバイルでも遊び心が見える縦パネル + 横カルーセル)
  // ───────────────────────────────────────────────────────────
  function renderDailyHeadline() {
    if (document.querySelector(".daily-headline")) return;
    const host = document.querySelector(".live-strip");
    if (!host) return;

    // 直近の名馬 5 頭 + 名言 3 個 を 1 つのカルーセルにまとめる
    const items = [];
    LEGENDS.slice().sort(() => Math.random() - 0.5).slice(0, 5).forEach(l => {
      items.push({
        type: "legend",
        head: l.year,
        title: l.name,
        body: "「" + l.aka + "」",
      });
    });
    QUOTES.slice().sort(() => Math.random() - 0.5).slice(0, 3).forEach(q => {
      items.push({
        type: "quote",
        head: "WORD",
        title: q.text,
        body: q.by,
      });
    });

    // shuffle で legend と quote を混ぜる
    items.sort(() => Math.random() - 0.5);

    const wrap = document.createElement("section");
    wrap.className = "daily-headline";
    wrap.innerHTML = `
      <div class="dh-marquee" aria-hidden="true">
        <div class="dh-track" id="dh-track-${Math.random().toString(36).slice(2,7)}">
          ${items.concat(items).map(it => `
            <div class="dh-card dh-${it.type}">
              <div class="dh-head">${it.head}</div>
              <div class="dh-title">${it.title}</div>
              <div class="dh-body">${it.body}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
    host.parentNode.insertBefore(wrap, host.nextSibling);
  }

  // ───────────────────────────────────────────────────────────
  //  ヒーローステージ (TV OP 風)
  // ───────────────────────────────────────────────────────────
  function setupHeroStage() {
    const stage = document.getElementById("hero-stage");
    if (!stage) return;
    const greeting = document.getElementById("hero-greeting");
    const eyebrow  = document.getElementById("hero-eyebrow");
    const dateEl   = document.getElementById("hero-date");
    const celest   = document.getElementById("hero-celestial");
    const qText    = document.getElementById("hero-quote-text");
    const qBy      = document.getElementById("hero-quote-by");

    function applyTimeOfDay() {
      const h = new Date().getHours();
      let tod, emoji, eyebrowText;
      if (h >= 5 && h < 10) {
        tod = "morning"; emoji = "☀️";
        eyebrowText = "— TODAY'S TURF — MORNING GREETING —";
      } else if (h >= 10 && h < 16) {
        tod = "day"; emoji = "🌤";
        eyebrowText = "— TODAY'S TURF — RACE TIME —";
      } else if (h >= 16 && h < 19) {
        tod = "evening"; emoji = "🌅";
        eyebrowText = "— TODAY'S TURF — SUNSET LAP —";
      } else {
        tod = "night"; emoji = "🌙";
        eyebrowText = "— TODAY'S TURF — NIGHT REVIEW —";
      }
      stage.classList.remove("tod-morning", "tod-day", "tod-evening", "tod-night");
      stage.classList.add("tod-" + tod);
      if (celest) celest.textContent = emoji;
      if (eyebrow) eyebrow.textContent = eyebrowText;
    }

    function applyGreeting() {
      const h = new Date().getHours();
      let greet;
      if (h >= 5 && h < 10)       greet = "おはよう、はじめさん";
      else if (h >= 10 && h < 14) greet = "いらっしゃい、はじめさん";
      else if (h >= 14 && h < 17) greet = "本日の本番ですね";
      else if (h >= 17 && h < 19) greet = "夕暮れの締めくくり";
      else if (h >= 19 && h < 23) greet = "今日の振り返り";
      else                         greet = "深夜の馬好きへ";
      if (greeting) greeting.textContent = greet;
    }

    function applyDate() {
      if (!dateEl) return;
      const d = new Date();
      const days = ["日", "月", "火", "水", "木", "金", "土"];
      dateEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 (${days[d.getDay()]})`;
    }

    let qIdx = Math.floor(Math.random() * QUOTES.length);
    function applyQuote() {
      const q = QUOTES[qIdx % QUOTES.length];
      if (!qText || !qBy) return;
      const blockquote = qText.closest(".hero-quote");
      if (blockquote && !prefersReduceMotion) {
        blockquote.classList.add("is-changing");
        setTimeout(() => {
          qText.textContent = q.text;
          qBy.textContent   = q.by;
          blockquote.classList.remove("is-changing");
        }, 500);
      } else {
        qText.textContent = q.text;
        qBy.textContent   = q.by;
      }
    }

    applyTimeOfDay();
    applyGreeting();
    applyDate();
    applyQuote();

    // 8 秒ごとに名言ローテーション
    if (!prefersReduceMotion) {
      setInterval(() => { qIdx++; applyQuote(); }, 8000);
    }
    // 5 分ごとに時間帯チェック (時間帯境目を超えても自動切替)
    setInterval(() => {
      applyTimeOfDay();
      applyGreeting();
      applyDate();
    }, 5 * 60 * 1000);
  }

  // ───────────────────────────────────────────────────────────
  //  init
  // ───────────────────────────────────────────────────────────
  function init() {
    try { setupHeroStage(); }    catch (e) { console.warn("[decorations] hero failed", e); }
    try { mount(); }              catch (e) { console.warn("[decorations] mount failed", e); }
    try { insertChapters(); }     catch (e) { console.warn("[decorations] chapters failed", e); }
    try { renderDailyHeadline(); }catch (e) { console.warn("[decorations] headline failed", e); }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // テスト用 export
  if (typeof window !== "undefined") {
    window.kbDecorations = { LEGENDS, QUOTES, init };
  }
})();
