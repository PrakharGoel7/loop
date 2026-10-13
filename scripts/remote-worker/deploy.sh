#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Explicit allowlist: app credentials, study data and the local dependency tree
# never cross this boundary. Install native Linux dependencies on the worker.
rsync -az \
  --include='/package.json' --include='/pnpm-lock.yaml' \
  --include='/pnpm-workspace.yaml' --include='/index.html' \
  --include='/tsconfig*.json' --include='/vite.config.ts' \
  --include='/src/***' --include='/public/***' \
  --include='/server/***' --include='/shared/***' \
  --exclude='*' ./ loop-worker:/opt/loop-worker/
ssh loop-worker 'cd /opt/loop-worker && pnpm install --frozen-lockfile'
