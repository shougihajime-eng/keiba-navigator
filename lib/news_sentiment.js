"use strict";

// ニュース感情解析: 競馬ニュースのヘッドラインから
//   - 馬名/騎手/調教師の言及検出
//   - 簡易キーワード辞書による sentiment (好材料/不安要素)
// を抽出し、出走馬カードに「⚠ 不安」「★ 好調」バッジを付ける。
//
// LLM は使わない: 完全オフライン辞書ベース。誤検知より見落としを許容する設計。

const POSITIVE_KW = [
  "好調", "絶好調", "復活", "勝利", "圧勝", "完勝", "連勝", "好走", "上昇",
  "万全", "順調", "好仕上がり", "好気配", "ベスト", "前進", "覚醒",
  "G1制覇", "重賞制覇", "リーディング", "好騎乗", "好調教",
];

const NEGATIVE_KW = [
  "故障", "骨折", "屈腱炎", "蹄", "跛行", "回避", "出走取消", "競走中止", "落馬",
  "感冒", "発熱", "脚部不安", "不安", "心配", "懸念", "停止", "騎乗停止",
  "減量", "斤量過多", "敗退", "惨敗", "大敗", "凡走", "失格", "降着",
  "引退", "繁殖", "重い馬場が苦手", "距離不安",
];

const NEUTRAL_KW = [
  "出走予定", "予想", "オッズ", "枠順", "発表",
];

function classifyHeadline(title) {
  if (!title) return { score: 0, tags: [] };
  const s = String(title);
  let score = 0;
  const tags = [];
  for (const k of POSITIVE_KW) {
    if (s.includes(k)) { score += 1; tags.push("+" + k); }
  }
  for (const k of NEGATIVE_KW) {
    if (s.includes(k)) { score -= 1.2; tags.push("-" + k); }
  }
  for (const k of NEUTRAL_KW) {
    if (s.includes(k)) tags.push("=" + k);
  }
  return { score, tags };
}

// 馬名・騎手名・調教師名の正規化 (カタカナひらがな統一、空白除去)
function normalizeName(n) {
  if (!n) return "";
  return String(n)
    .replace(/[\s　]+/g, "")
    .replace(/[ぁ-ん]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .toUpperCase();
}

// 名前マッチング: title に target が含まれているか (部分一致 OK)
// short_match: 4文字以上の name のみマッチ判定 (誤検知低減)
function nameMatches(title, target, opt = {}) {
  if (!title || !target) return false;
  const t = normalizeName(target);
  if (!opt.allowShort && t.length < 3) return false;
  const n = normalizeName(title);
  return n.includes(t);
}

// race の出走馬から、ニュース items に対する関連度を計算
// 出力: { byHorseNumber: { 5: { score: -1.2, items: [{title,url,score,tags}] }, ... }, raceLevel: ... }
function annotateRaceWithNews(race, newsItems) {
  const out = { byHorseNumber: {}, raceLevel: { score: 0, items: [] } };
  if (!race || !Array.isArray(race.horses) || !Array.isArray(newsItems)) return out;

  for (const item of newsItems) {
    const title = item?.title || "";
    const cls = classifyHeadline(title);
    if (cls.score === 0) continue;

    // 各馬について判定
    for (const h of race.horses) {
      const matchedBy = [];
      if (h.name && nameMatches(title, h.name)) matchedBy.push("horse:" + h.name);
      if (h.jockey && nameMatches(title, h.jockey, { allowShort: true })) matchedBy.push("jockey:" + h.jockey);
      if (h.trainer && nameMatches(title, h.trainer, { allowShort: true })) matchedBy.push("trainer:" + h.trainer);
      if (!matchedBy.length) continue;

      const slot = out.byHorseNumber[h.number] || { score: 0, items: [] };
      slot.score += cls.score;
      slot.items.push({
        title, url: item.link || null, score: cls.score, tags: cls.tags,
        matchedBy,
      });
      out.byHorseNumber[h.number] = slot;
    }
    // 競馬場・グレード・レース名のマッチング
    if (race.race_name && nameMatches(title, race.race_name)) {
      out.raceLevel.score += cls.score;
      out.raceLevel.items.push({ title, url: item.link || null, score: cls.score, tags: cls.tags });
    }
  }
  return out;
}

// バッジ生成: score >= 0.8 → ★ / score <= -0.8 → ⚠
function badge(slot) {
  if (!slot) return null;
  if (slot.score >= 0.8) return { type: "good", label: "好材料", sym: "★", score: slot.score };
  if (slot.score <= -0.8) return { type: "warn", label: "不安要素", sym: "⚠", score: slot.score };
  return null;
}

module.exports = {
  classifyHeadline,
  annotateRaceWithNews,
  badge,
  normalizeName,
  nameMatches,
  POSITIVE_KW, NEGATIVE_KW,
};
