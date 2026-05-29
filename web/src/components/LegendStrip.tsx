import { GallopHorse } from "./icons/GallopHorse";

/**
 * LegendStrip — 名馬列伝。歴史的な名馬の名前・年・一行エピソード・主な勲章
 * （G1勝ち鞍など）が右から左へゆっくり流れる帯。写真は使わずテキスト+馬アイコン。
 * 見るたびに「競馬っていいな」とテンションが上がる装飾。
 */

type Legend = { name: string; year: string; tale: string; honor: string };

const LEGENDS: Legend[] = [
  { name: "シンザン", year: "1964", tale: "戦後初の五冠・最強の祖", honor: "五冠" },
  { name: "ハイセイコー", year: "1973", tale: "競馬ブームを呼んだ怪物", honor: "国民的アイドル" },
  { name: "シンボリルドルフ", year: "1984", tale: "無敗の三冠・皇帝", honor: "G1 7勝" },
  { name: "オグリキャップ", year: "1990", tale: "芦毛の怪物・伝説の引退レース", honor: "G1 4勝" },
  { name: "メジロマックイーン", year: "1991", tale: "長距離に君臨した白い貴公子", honor: "G1 4勝" },
  { name: "トウカイテイオー", year: "1993", tale: "奇跡の復活・有馬を制す", honor: "G1 4勝" },
  { name: "ナリタブライアン", year: "1994", tale: "シャドーロールの怪物・三冠", honor: "G1 5勝" },
  { name: "タイキシャトル", year: "1998", tale: "世界を驚かせた最強短距離馬", honor: "G1 5勝" },
  { name: "サイレンススズカ", year: "1998", tale: "誰も追いつけない逃亡者", honor: "G1 1勝" },
  { name: "エルコンドルパサー", year: "1999", tale: "凱旋門賞2着・海を越えた名馬", honor: "G1 3勝" },
  { name: "スペシャルウィーク", year: "1999", tale: "武豊に初ダービーをもたらした", honor: "G1 4勝" },
  { name: "テイエムオペラオー", year: "2000", tale: "世紀末覇王・年間無敗", honor: "G1 7勝" },
  { name: "ディープインパクト", year: "2005", tale: "空を飛ぶ・無敗の三冠", honor: "G1 7勝" },
  { name: "ウオッカ", year: "2007", tale: "64年ぶり牝馬のダービー制覇", honor: "G1 7勝" },
  { name: "ダイワスカーレット", year: "2008", tale: "ウオッカと死闘・無敗の二冠牝馬", honor: "G1 4勝" },
  { name: "ブエナビスタ", year: "2010", tale: "府中の女王・善戦の名牝", honor: "G1 6勝" },
  { name: "オルフェーヴル", year: "2011", tale: "金色の暴君・三冠馬", honor: "G1 6勝" },
  { name: "ジェンティルドンナ", year: "2012", tale: "牝馬三冠・ジャパンC連覇", honor: "G1 7勝" },
  { name: "ロードカナロア", year: "2013", tale: "香港も制した最強スプリンター", honor: "G1 6勝" },
  { name: "ゴールドシップ", year: "2015", tale: "愛された変幻自在の個性派", honor: "G1 6勝" },
  { name: "モーリス", year: "2016", tale: "マイルから中距離まで席巻", honor: "G1 6勝" },
  { name: "キタサンブラック", year: "2017", tale: "みんなに愛された春の王者", honor: "G1 7勝" },
  { name: "アーモンドアイ", year: "2020", tale: "芝GI 9勝・歴代最強牝馬", honor: "G1 9勝" },
  { name: "コントレイル", year: "2020", tale: "無敗の三冠・父子無敗制覇", honor: "G1 5勝" },
  { name: "クロノジェネシス", year: "2021", tale: "グランプリ3連覇の女傑", honor: "G1 5勝" },
  { name: "イクイノックス", year: "2023", tale: "世界ランキング1位の怪物", honor: "G1 6勝" },
  { name: "リバティアイランド", year: "2023", tale: "圧巻の牝馬三冠", honor: "G1 4勝" },
  { name: "ドウデュース", year: "2024", tale: "武豊と掴んだ夢・有馬制覇", honor: "G1 5勝" },
];

function Crown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 18" className={className} aria-hidden="true" fill="currentColor">
      <path d="M2 15h20l1-9-6 4-5-8-5 8-6-4z" />
      <rect x="2" y="15" width="20" height="2.6" rx="1" />
    </svg>
  );
}

function LegendItem({ l }: { l: Legend }) {
  return (
    <span className="legend-item">
      <GallopHorse className="legend-horse" />
      <span className="legend-name">{l.name}</span>
      <span className="legend-year">{l.year}</span>
      <span className="legend-honor">
        <Crown className="legend-crown" />
        {l.honor}
      </span>
      <span className="legend-tale">{l.tale}</span>
      <span className="legend-sep">·</span>
    </span>
  );
}

export function LegendStrip() {
  return (
    <div className="legend-strip" aria-label="名馬列伝">
      <span className="legend-badge">名馬列伝</span>
      <div className="legend-track">
        {/* 同じ列を2回並べて途切れずループ */}
        <div className="legend-flow">
          {LEGENDS.map((l) => (
            <LegendItem key={`a-${l.name}`} l={l} />
          ))}
          {LEGENDS.map((l) => (
            <LegendItem key={`b-${l.name}`} l={l} />
          ))}
        </div>
      </div>
    </div>
  );
}
