"use strict";
//
// race_id.js — レース ID の形式判定と正規化
// 用途:
//   結果照合・履歴検索・通知メッセージ生成で「これは本物のJRAレース ID か、
//   それとも手動入力ローカル ID か」を正しく区別する。
//
// サポートする形式:
//   1) "YYYYMMDDJJKKHHRRRRR" 18 桁 ─ 公式 JRA レース ID
//        年(4) + 月日(4) + 場(2) + 開催回(2) + 日次(2) + R(2) + ハイフン無し
//   2) "manual_<unix_ms>"  ─ 手動入力レース (lib/manual_race.js が振る)
//   3) "demo_*" / "dummy_*" / "test_*"  ─ 仮データ (UI に「仮」マークを出す用)
//   4) その他  ─ 不正値として扱う
//

const JRA_18DIGIT = /^[0-9]{18}$/;
// manual_<unix_ms> または manual_<unix_ms>_<3桁ランダム> (同時送信衝突対策)
const MANUAL      = /^manual_\d+(?:_\d+)?$/;
const DEMO        = /^(?:demo|dummy|test)_/i;

const JYO_NAMES = {
  "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京",
  "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉",
};

function kind(id) {
  if (typeof id !== "string" || !id) return "unknown";
  if (JRA_18DIGIT.test(id)) return "jra";
  if (MANUAL.test(id))      return "manual";
  if (DEMO.test(id))        return "demo";
  return "unknown";
}

function isJraRaceId(id)   { return kind(id) === "jra"; }
function isManualRaceId(id){ return kind(id) === "manual"; }
function isDemoRaceId(id)  { return kind(id) === "demo"; }
function isFinalizableRaceId(id) { return kind(id) === "jra"; }
                           // manual / demo は結果データが無いので照合不可

// JRA 18 桁 ID をパースしてメタ情報を返す。形式不一致なら null。
//   "2026050305020111" → { year: 2026, month: 5, day: 3, jyoCode: "05", jyoName: "東京", kaiji: 2, nichiji: 1, raceNum: 11 }
function parseJraRaceId(id) {
  if (!isJraRaceId(id)) return null;
  return {
    year:     Number(id.slice(0, 4)),
    month:    Number(id.slice(4, 6)),
    day:      Number(id.slice(6, 8)),
    jyoCode:  id.slice(8, 10),
    jyoName:  JYO_NAMES[id.slice(8, 10)] || null,
    kaiji:    Number(id.slice(10, 12)),
    nichiji:  Number(id.slice(12, 14)),
    raceNum:  Number(id.slice(14, 16)),
    // 末尾 2 桁は予備 (00 が一般的)
    suffix:   id.slice(16, 18),
  };
}

// 18 桁 JRA ID を組み立てる
function buildJraRaceId({ year, month, day, jyoCode, kaiji, nichiji, raceNum }) {
  const pad = (n, w) => String(n).padStart(w, "0");
  const id = `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}${jyoCode}${pad(kaiji, 2)}${pad(nichiji, 2)}${pad(raceNum, 2)}00`;
  return isJraRaceId(id) ? id : null;
}

// UI 表示用のラベル ("東京 11R 2026/05/03")
function labelOf(id) {
  const p = parseJraRaceId(id);
  if (!p) return id || "";
  return `${p.jyoName || p.jyoCode} ${p.raceNum}R ${p.year}/${String(p.month).padStart(2,"0")}/${String(p.day).padStart(2,"0")}`;
}

const _exports = {
  kind, isJraRaceId, isManualRaceId, isDemoRaceId, isFinalizableRaceId,
  parseJraRaceId, buildJraRaceId, labelOf,
  JYO_NAMES,
};

if (typeof module !== "undefined" && module.exports) module.exports = _exports;
if (typeof window !== "undefined") window.RaceId = _exports;
