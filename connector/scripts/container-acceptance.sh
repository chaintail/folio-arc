#!/usr/bin/env bash
set -euo pipefail
acceptance_status=0
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json,pathlib
bindings=pathlib.Path('.runtime/as-state/interaction-bindings.json')
if bindings.exists() and json.loads(bindings.read_text()):
 raise SystemExit('Acceptance requires fresh local state. Run ./scripts/reset-local.sh, then ./scripts/prepare-runtime.sh and docker compose up -d --wait as mcp core tls-fixture. Teardown alone preserves bind-mounted state.')
PY
curl --ipv4 --noproxy '*' --fail --silent --show-error --max-time 10 http://localhost:38312/.well-known/openid-configuration >/dev/null
curl --ipv4 --noproxy '*' --fail --silent --show-error --max-time 10 http://localhost:38313/.well-known/oauth-protected-resource/mcp >/dev/null
docker compose --profile test build test-runner
docker compose run --rm test-runner main || acceptance_status=$?
docker compose run --rm test-runner restart-before
docker compose restart as mcp core
docker compose up -d --wait as mcp core tls-fixture
docker compose run --rm test-runner restart-after
docker compose stop as
docker compose run --rm --no-deps as rotate.mjs
docker compose up -d --wait as
docker compose run --rm test-runner rotation-after
python3 - <<'PY'
import json,pathlib
rows=[]
for name in ['main','restart','rotation']:rows+=json.loads(pathlib.Path(f'evidence/dispositions-{name}.json').read_text())['results']
pathlib.Path('evidence/dispositions.json').write_text(json.dumps({'results':rows},indent=2)+'\n')
print({s:sum(r['status']==s for r in rows) for s in ['PASS','FAIL','UNVERIFIED']})
PY

exit "$acceptance_status"
