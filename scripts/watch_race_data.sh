#!/bin/bash
# 5/23 朝の watcher: JRA-VAN が当日の出走馬・オッズを配信した瞬間に取り込み・予測・push
# 10 分ごとに aggregate を試行。レコードが取れて、しかも「??」パディングでなくなった瞬間に完全処理。

set +e
cd "/c/Users/shoug/競馬"

LOG="/c/Users/shoug/競馬/logs/watch_race_data_$(date +%Y-%m-%d).log"
TS() { date "+%Y-%m-%d %H:%M:%S"; }
echo "[$(TS)] watcher start" >> "$LOG"

# 今日のレースの 1 つを基準ファイルとして「??」パディングが解けたか判定
SAMPLE="/c/Users/shoug/競馬/data/jv_cache/races/202605230401070100.json"

is_real_data() {
  # 馬名 1 頭目に「???」が入ってなければ実データ
  python -c "
import json, sys, os
try:
    d = json.load(open('$SAMPLE', encoding='utf-8'))
    horses = d.get('horses', [])
    if not horses:
        sys.exit(2)
    name = (horses[0].get('name') or '')
    if '?' in name or len(name.strip()) == 0:
        sys.exit(2)
    sys.exit(0)
except Exception as e:
    sys.exit(3)
"
  return $?
}

# 既に取れてたら何もせず終了
if is_real_data; then
  echo "[$(TS)] already have real data; exit" >> "$LOG"
  exit 0
fi

ATTEMPT=0
MAX_ATTEMPTS=24   # 10 min x 24 = 4 hours

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT+1))
  echo "[$(TS)] attempt #${ATTEMPT}" >> "$LOG"

  # 1. JV-Link aggregate (option=2 今週+前週・強制再取得モード)
  # option=1 は「差分のみ」で既取得分はスキップしてしまうため、JRA-VAN サーバの
  # 同一ファイルが「中身だけ更新」されたケースを拾えない。option=2 で毎回全件再取得。
  py -3.12-32 jv_bridge/jv_fetch.py aggregate --dataspec RACE --fromtime 20260520000000 --option 2 >> "$LOG" 2>&1 || true

  # 2. build_all で raw → JSON 展開
  py -3.12-32 jv_bridge/build_all.py >> "$LOG" 2>&1 || true

  # 3. 実データ判定
  if is_real_data; then
    echo "[$(TS)] REAL DATA arrived. Running predictions..." >> "$LOG"

    # 4. 特徴量再集計
    py -3.12-32 jv_bridge/aggregate_features.py >> "$LOG" 2>&1
    py -3.12-32 jv_bridge/aggregate_features_v2.py >> "$LOG" 2>&1

    # 5. 予測再実行
    py -3.12-64 jv_bridge/predict_lightgbm.py --all-races >> "$LOG" 2>&1

    # 6. 推奨集約
    py -3.12-32 jv_bridge/aggregate_recommendations.py >> "$LOG" 2>&1

    # 7. precompute predictions.json
    node scripts/precompute_predictions.js >> "$LOG" 2>&1 || true

    # 8. git commit + push
    git add data/jv_cache/ >> "$LOG" 2>&1
    git commit -m "auto(race-day): 5/23 出走馬・オッズデータを反映 (attempt #${ATTEMPT})" >> "$LOG" 2>&1
    git push origin main >> "$LOG" 2>&1

    echo "[$(TS)] success on attempt #${ATTEMPT}" >> "$LOG"
    echo "WATCHER_SUCCESS_ATTEMPT_${ATTEMPT}"
    exit 0
  else
    echo "[$(TS)] still pending; sleeping 10 min" >> "$LOG"
  fi

  sleep 600  # 10 分待つ
done

echo "[$(TS)] watcher timeout after ${MAX_ATTEMPTS} attempts" >> "$LOG"
echo "WATCHER_TIMEOUT"
exit 1
