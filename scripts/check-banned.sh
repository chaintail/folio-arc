#!/usr/bin/env bash
# Scan publishable files. Private-host exemptions are limited to the two exact
# connector/compose.yml port lines below: loopback bind, not an internal host.
# Protocol names are allowed only in two exact provenance headers and the
# README roadmap line. Destination-account identifiers/derivations are retained.
set -euo pipefail
export LC_ALL=C

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
pattern='claude\.do|preview\.tryfolio|mcp\.tryfolio|ops\.tryfolio|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|127\.0\.0\.1|liam''@|chaintail\.xyz|trycloud''flare|\bcm[a-z0-9]{20,}\b|io\.tryfolio\.android|apps/''android|EJCo''Sv6h|GCM94''uAP|5G2''Wvh'
protocol_pattern='[Kk][Aa][Mm][Ii][Nn][Oo]|[Kk][Ss][Ww][Aa][Pp]|[Xx][Ss][Tt][Oo][Cc][Kk][Ss]'
derivation_header='// stand-in for the monorepo module assembly/ka''mino; identical signature'
batching_header='// stand-in for the monorepo module protocol-ka''mino/rpc-multi-accounts; identical signature'
roadmap='Roadmap: pending xSto''cks on Arc.'
loopback='127.0.0.'1
as_binding="    ports: ['${loopback}:38312:38312']"
mcp_binding="    ports: ['${loopback}:38313:38313']"
if (( $# == 0 )); then
  set -- "$repo_root"
fi

file_list="$(mktemp)"
matches="$(mktemp)"
trap 'rm -f -- "$file_list" "$matches"' EXIT
for target in "$@"; do
  if [[ ! -e "$target" ]]; then
    printf 'ERROR: path does not exist: %s\n' "$target" >&2
    exit 2
  fi
  find "$target" \( -name .git -o -type d -name node_modules \) -prune -o -type f -print0 >> "$file_list"
done

failed=0
while IFS= read -r -d '' file; do
  absolute="$(realpath -- "$file")"
  if grep -nI -E -- "$pattern|$protocol_pattern" "$file" > "$matches"; then
    while IFS= read -r match; do
      line_number="${match%%:*}"
      line="${match#*:}"
      if [[ "$absolute" == "$repo_root/connector/compose.yml" ]] &&
         [[ "$line" == "$as_binding" || "$line" == "$mcp_binding" ]]; then
        continue
      fi
      if [[ "$absolute" == "$repo_root/bridge/src/shims/obligation.ts" && "$line_number" == 1 && "$line" == "$derivation_header" ]] ||
         [[ "$absolute" == "$repo_root/bridge/src/shims/multi-account.ts" && "$line_number" == 1 && "$line" == "$batching_header" ]] ||
         [[ "$absolute" == "$repo_root/README.md" && "$line" == "$roadmap" ]]; then
        continue
      fi
      printf '%s:%s:%s\n' "${absolute#"$repo_root/"}" "$line_number" "$line"
      failed=1
    done < "$matches"
  else
    status=$?
    if (( status != 1 )); then
      printf 'ERROR: could not scan %s\n' "$file" >&2
      exit 2
    fi
  fi
done < "$file_list"

if (( failed )); then
  printf 'FAIL: banned strings found.\n'
  exit 1
fi
printf 'PASS: banned-string scan clean.\n'
