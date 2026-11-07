#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/upstream/packages/opencode"
# 격리된 홈을 사용해 기존 DB/설정과 섞이지 않게 한다
export HOME="${CROAKCODE_TEST_HOME:-/tmp/croakcode-phase1-home}"
mkdir -p "$HOME"
export CROAKCODE_DB="croakcode.db"
export CROAKCODE_CONFIG_CONTENT='{"$schema":"https://croakcode.ai/config.json"}'
PORT="${CROAKCODE_TEST_PORT:-4319}"
LOG=/tmp/croakcode-serve.log

bun run --conditions=browser src/index.ts serve --port "$PORT" >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true' EXIT

READY=0
for _ in $(seq 1 120); do
  if curl -sf "http://127.0.0.1:$PORT/global/health" >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "FAIL: server exited early"; cat "$LOG"; exit 1; fi
  sleep 0.5
done
[[ "$READY" -eq 1 ]] || { echo "FAIL: server did not become healthy"; cat "$LOG"; exit 1; }

curl -sf "http://127.0.0.1:$PORT/session" -X POST -H 'content-type: application/json' \
  -d '{"title":"phase1-smoke"}' >/tmp/croakcode-session.json \
  || { echo "FAIL: session create"; cat "$LOG"; exit 1; }

SID="$(node -e 'const j=require("/tmp/croakcode-session.json"); if(!j.id) process.exit(2); process.stdout.write(j.id)')" \
  || { echo "FAIL: no session id in response"; cat /tmp/croakcode-session.json; exit 1; }
echo "session id: $SID"

# 서버를 정상 종료시키고 WAL을 체크포인트해, 뒤따르는 sqlite 테스트가 확정된 상태를 읽도록 한다.
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
DB="$HOME/.local/share/croakcode/croakcode.db"
if [[ -f "$DB" ]]; then
  sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
fi
echo "PASS: headless server up + session created"
