#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "${PUBLIC_MODE:-0}" == 0 ]] || { echo 'Public mode reset prohibited'; exit 1; }
[[ ! -f .env ]] || { echo 'Explicit .env exists; review before local reset'; exit 1; }
docker compose down
python3 - <<'PY'
import pathlib
for name in ['as-state','core-state','runner']:
 for p in (pathlib.Path('.runtime')/name).glob('*'):
  if p.is_file():p.unlink()
PY
