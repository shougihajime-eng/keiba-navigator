"use strict";
const { readAllRaces } = require("../lib/jv_cache");
const { buildConclusion } = require("../lib/conclusion");

module.exports = (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const races = readAllRaces();
  if (!races.length) {
    return res.status(503).json({
      ok: false, status: "unavailable", races: [],
      reason: "出走馬データはまだ取得していません。JRA-VAN（有料）の接続設定後に表示されます。",
    });
  }
  // 各レースに簡易結論を付与(verdict / topGrade / topPick のみ。詳細は /api/conclusion を別途叩く想定)
  const summaries = races.map(race => {
    const c = buildConclusion(race);
    return {
      raceName: race.race_name || null,
      raceId:   race.race_id   || null,
      course:   race.course    || null,
      venue:    race.venue     || null,
      isDummy:  !!race.is_dummy || /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(race.source || ""),
      verdict:  c.verdict,
      topGrade: c.topGrade,
      topPick: c.picks?.[0] ? {
        number: c.picks[0].number,
        name: c.picks[0].name,
        odds: c.picks[0].odds,
        ev: c.picks[0].ev,
        grade: c.picks[0].grade,
      } : null,
      confidence: c.confidence,
      hasOverpop: (c.overpopular || []).length > 0,
      hasUnderval: (c.undervalued || []).length > 0,
    };
  });
  return res.status(200).json({
    ok: true,
    fetchedAt: new Date().toISOString(),
    raceCount: summaries.length,
    races: summaries,
  });
};
