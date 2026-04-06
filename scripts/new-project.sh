#!/usr/bin/env bash
# new-project.sh — Reset investigation project artifacts for a fresh run.
# Run with: npm run new-project
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Resetting investigation project artifacts..."

# Blank out the agent system prompt extensions
: > "$ROOT/agents/worker/APPEND_SYSTEM.md"
: > "$ROOT/agents/manager/APPEND_SYSTEM.md"

# Remove worker changelog
: > "$ROOT/agents/worker/changelog.md"

# Remove worker backups
rm -rf "$ROOT/agents/worker/backups"

# Remove runtime loop state
find "$ROOT" -name "loop-state.json" -delete 2>/dev/null || true

# Clear workspace artifacts (logs, output, task plan)
rm -rf "$ROOT/workspace/logs"
rm -rf "$ROOT/workspace/output"
rm -f "$ROOT/workspace/task-plan.md"
mkdir -p "$ROOT/workspace/logs" "$ROOT/workspace/output"

echo "Done. Ready for a new investigation project."
