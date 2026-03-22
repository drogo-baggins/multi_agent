#!/bin/bash

# SearXNG Container Stop Script
# Stops and removes the SearXNG container.
# Supports both Podman and Docker.
#
# Usage:
#   ./scripts/searxng-stop.sh           # stop and remove
#   ./scripts/searxng-stop.sh --keep    # stop only (don't remove)

set -euo pipefail

SEARXNG_CONTAINER="searxng"

KEEP=false
if [[ "${1:-}" == "--keep" ]]; then
    KEEP=true
fi

detect_runtime() {
    if command -v podman &>/dev/null; then
        echo "podman"
    elif command -v docker &>/dev/null; then
        echo "docker"
    else
        echo ""
    fi
}

RUNTIME=$(detect_runtime)

if [[ -z "$RUNTIME" ]]; then
    echo "X podman も docker もインストールされていません"
    exit 1
fi

echo "SearXNG 停止スクリプト (runtime: ${RUNTIME})"
echo "========================================================"

container_exists() {
    $RUNTIME ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${SEARXNG_CONTAINER}$"
}

container_running() {
    $RUNTIME ps --format '{{.Names}}' 2>/dev/null | grep -q "^${SEARXNG_CONTAINER}$"
}

if ! container_exists; then
    echo "SearXNG コンテナは存在しません"
    exit 0
fi

if container_running; then
    echo "コンテナを停止中..."
    $RUNTIME stop "${SEARXNG_CONTAINER}"
    echo "[OK] 停止完了"
else
    echo "コンテナは既に停止しています"
fi

if [[ "$KEEP" == "false" ]]; then
    echo "コンテナを削除中..."
    $RUNTIME rm "${SEARXNG_CONTAINER}"
    echo "[OK] 削除完了"
else
    echo "--keep が指定されたため、コンテナは保持されます"
    echo "  再起動: ${RUNTIME} start ${SEARXNG_CONTAINER}"
fi

echo ""
echo "========================================================"
echo "[OK] 完了"
