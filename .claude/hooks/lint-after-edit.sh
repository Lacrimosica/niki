#!/bin/sh
# PostToolUse hook: lint a client TypeScript file right after Claude edits it.
# ESLint errors are returned to Claude (exit 2) so they are fixed in the same
# turn, instead of surfacing later at commit time. Other files are ignored.

file=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))')

case "$file" in
  */client/src/*.ts|*/client/src/*.tsx) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0
client_dir=$(dirname "$(dirname "$file")")
cd "$client_dir" || exit 0

if ! output=$(npx --no-install eslint "$file" 2>&1); then
  printf 'ESLint errors in %s. Fix them before continuing (see CLAUDE.md, "Lint Rules"):\n%s\n' "$file" "$output" >&2
  exit 2
fi
exit 0
