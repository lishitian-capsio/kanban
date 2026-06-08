#!/usr/bin/env bash
# Sync omp core packages into Kanban src/agent-sdk/
# Usage: scripts/sync-omp-core.sh [OMP_REPO_PATH]
set -euo pipefail

OMP_REPO="${1:-/home/developer/code/oh-my-pi}"
TARGET="src/agent-sdk"

if [ ! -d "$OMP_REPO/packages" ]; then
  echo "ERROR: omp repo not found at $OMP_REPO"
  exit 1
fi

echo "=== Syncing omp core packages ==="
echo "Source: $OMP_REPO/packages"
echo "Target: $TARGET"

# Clean target
rm -rf "$TARGET"
mkdir -p "$TARGET"

# ── 1. Agent package (packages/agent/src → src/agent-sdk/) ──
echo ""
echo "--- Syncing agent package ---"
rsync -av \
  "$OMP_REPO/packages/agent/src/" \
  "$TARGET/"

# ── 2. AI package (packages/ai/src → src/agent-sdk/ai/) ──
echo ""
echo "--- Syncing ai package (excluding cursor, pi-native providers) ---"
rsync -av \
  --exclude='cursor/' \
  --exclude='cursor.ts' \
  --exclude='pi-native-client.ts' \
  --exclude='pi-native-server.ts' \
  "$OMP_REPO/packages/ai/src/" \
  "$TARGET/ai/"

# ── 3. Utils package (packages/utils/src → src/agent-sdk/shared/) ──
echo ""
echo "--- Syncing utils package (excluding ptree, procmgr, glob, dirs, postmortem) ---"
rsync -av \
  --exclude='ptree.ts' \
  --exclude='procmgr.ts' \
  --exclude='glob.ts' \
  --exclude='dirs.ts' \
  --exclude='postmortem.ts' \
  --exclude='cli.ts' \
  "$OMP_REPO/packages/utils/src/" \
  "$TARGET/shared/"

# ── Summary ──
echo ""
echo "=== Sync complete ==="
echo "File counts:"
echo "  agent-sdk root: $(find "$TARGET" -maxdepth 1 -name '*.ts' | wc -l) files"
echo "  agent-sdk/ai:   $(find "$TARGET/ai" -name '*.ts' 2>/dev/null | wc -l) files"
echo "  agent-sdk/shared: $(find "$TARGET/shared" -name '*.ts' 2>/dev/null | wc -l) files"
echo "  Total .ts files: $(find "$TARGET" -name '*.ts' | wc -l)"
echo "  Total files:     $(find "$TARGET" -type f | wc -l)"
