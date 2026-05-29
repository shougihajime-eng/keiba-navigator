import { GallopHorse } from "./icons/GallopHorse";

/**
 * LegendStrip — 名馬列伝。歴史的な名馬の名前と一行エピソード（事実）が
 * 右から左へゆっくり流れる帯。写真は使わずテキスト+馬アイコンで構成。
 * 見るたびに「競馬っていいな」とテンションが上がる装飾。
 */

type Legend = { name: string; year: string; tale: string };

const LEGENDS: Legend[] = [
  { name: "シンザン", year: "1964", tale: "戦後初の五冠・最強の祖" },
  { name: "ハイセイコー", year: "1973", tale: "競馬ブームを呼んだ怪物" },
  { name: "シンボリルドルフ", year: "1984", tale: "無敗の三冠・皇帝" },
  { name: "オグリキャップ", year: "1990", tale: "芦毛の怪物・伝説の引退レース" },
  { name: "メジロマックイーン", year: "1991", tale: "長距離に君臨した白い貴公子" },
  { name: "トウカイテイオー", year: "1993", tale: "奇跡の復活・有馬を制す" },
  { name: "ナリタブライアン", year: "1994", tale: "シャドーロールの怪物・三冠" },
  { name: "サイレンススズカ", year: "1998", tale: "誰も追いつけない逃亡者" },
  { name: "テイエムオペラオー", year: "2000", tale: "世紀末覇王・年間無敗" },
  { name: "ディープインパクト", year: "2005", tale: "空を飛ぶ・無敗の三冠" },
  { name: "ウオッカ", year: "2007", tale: "64年ぶり牝馬のダービー制覇" },
  { name: "オルフェーヴル", year: "2011", tale: "金色の暴君・三冠馬" },
  { name: "ジェンティルドンナ", year: "2012", tale: "牝馬三冠・ジャパンC連覇" },
  { name: "ゴールドシップ", year: "2015", tale: "愛された変幻自在の個性派" },
  { name: "キタサンブラック", year: "2017", tale: "みんなに愛された春の王者" },
  { name: "アーモンドアイ", year: "2020", tale: "芝GI 9勝・歴代最強牝馬" },
  { name: "コントレイル", year: "2020", tale: "無敗の三冠・父子無敗制覇" },
  { name: "イクイノックス", year: "2023", tale: "世界ランキング1位の怪物" },
];

function LegendItem({ l }: { l: Legend }) {
  return (
    <span className="legend-item">
      <GallopHorse className="legend-horse" />
      <span className="legend-name">{l.name}</span>
      <span className="legend-year">{l.year}</span>
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
