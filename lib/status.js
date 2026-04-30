"use strict";
const { listJvCache, readJvStatus } = require("./jv_cache");

function buildStatus() {
  const jv = readJvStatus();
  const jvOk = jv && jv.state === "ready";
  return {
    fetchedAt: new Date().toISOString(),
    sources: [
      {
        id: "race", label: "出走馬・オッズ・馬体重・騎手・調教師・過去成績・血統",
        status: jvOk ? "available" : "unavailable",
        source: jvOk ? "JV-Link" : null,
        reason: jvOk ? null : "JRA-VAN（有料）の接続設定がまだのため、本格的な競馬データは未取得です。",
        lastBridgeUpdate: jv ? jv.updatedAt : null,
      },
      {
        id: "going", label: "馬場状態（パンパン/重 等）",
        status: jvOk ? "available" : "unavailable",
        reason: jvOk ? null : "競馬場が当日発表する情報のため、JRA-VAN接続後に取得します。天気からの推測は行いません。",
      },
      { id: "weather", label: "天気（参考値）", status: "available", source: "気象庁 forecast API（無料・公開）" },
      { id: "news",    label: "関連ニュース",   status: "available", source: "Google News RSS（無料・公開）" },
    ],
    jvBridge: jv,
    cacheFiles: listJvCache(),
  };
}

module.exports = { buildStatus };
