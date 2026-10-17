#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f ../.world/ports.yml ]]; then echo 'Resolve this worktree allocation with port-for before starting Compose'; exit 1; fi
listeners=$(ss -H -ltn '( sport = 38312 or sport = 38313 )') || { echo 'Cannot verify port availability'; exit 1; }
if [[ -n "$listeners" ]]; then echo 'Reserved ports occupied; inspect task ownership'; exit 1; fi
docker compose version
