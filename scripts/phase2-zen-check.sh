#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

# Phase 2 zen removal targets the distributable CORE only. Phase 4 product
# packages (app/desktop/docs/stats/enterprise/github/infra/sdks) are rebuilt by
# croakcode later and are out of scope here (see rebrand-check PHASE4_PREFIXES).
CORE_DIRS=(opencode core ui sdk plugin script)

# pat 매치를 코어 패키지에서 찾는다. 'baseten'이 같은 줄에 있어도 'opencode'
# 토큰이 그 줄에 있으면 위반으로 잡는다(마스킹 방지).
check_absent() {
  local pat="$1" desc="$2"
  local hits=""
  for d in "${CORE_DIRS[@]}"; do
    local part
    part=$(grep -rn -E "$pat" "upstream/packages/$d" \
             --include='*.ts' --include='*.tsx' 2>/dev/null \
           | grep -v node_modules \
           | grep -E "$pat" || true)
    [[ -n "$part" ]] && hits+="$part"$'\n'
  done
  if [[ -n "$hits" ]]; then
    echo "FAIL: $desc still present"
    echo "$hits" | head -5
    fail=1
  fi
}

check_absent 'ProviderID\.opencode' 'ProviderID.opencode'
check_absent 'ProviderV2\.ID\.opencode' 'ProviderV2.ID.opencode'
check_absent 'GO_UPSELL' 'GO upsell'
check_absent '\bopencode-go\b' 'opencode-go tier string'

[[ -f upstream/packages/core/src/plugin/provider/opencode.ts ]] && { echo "FAIL: zen plugin file still exists"; fail=1; }
[[ -f upstream/packages/core/test/plugin/provider-opencode.test.ts ]] && { echo "FAIL: zen plugin test still exists"; fail=1; }

[[ "$fail" -eq 0 ]] && echo "PASS: zen/console provider fully removed"
exit "$fail"
