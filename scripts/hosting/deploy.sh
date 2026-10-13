#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Validate an isolated candidate before changing the running application's source.
# Credentials and study state never cross the deployment boundary.
ssh loop-app 'mkdir -p /opt/loop-app-staging'
rsync -az --delete \
  --include='/package.json' --include='/pnpm-lock.yaml' --include='/pnpm-workspace.yaml' \
  --include='/index.html' --include='/tsconfig*.json' --include='/vite.config.ts' \
  --include='/src/***' --include='/public/***' --include='/server/***' --include='/shared/***' \
  --include='/knowledge-base/***' \
  --exclude='*' ./ loop-app:/opt/loop-app-staging/
ssh loop-app 'cd /opt/loop-app-staging && pnpm install --frozen-lockfile && pnpm test && pnpm exec tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --esModuleInterop --skipLibCheck server/index.ts && pnpm build'
# Promote the already-built candidate, preserving live credentials and data.
# Refuse promotion while a live study exists; unreadable state also fails closed.
# Service restart is intentionally separate.
ssh loop-app 'node --input-type=module - /opt/loop-app/data/sessions.json' < scripts/hosting/assert-idle.mjs
ssh loop-app 'rsync -a --delete \
  --include="/package.json" --include="/pnpm-lock.yaml" --include="/pnpm-workspace.yaml" \
  --include="/index.html" --include="/tsconfig*.json" --include="/vite.config.ts" \
  --include="/src/***" --include="/public/***" --include="/server/***" --include="/shared/***" \
  --include="/knowledge-base/***" --include="/dist/***" --include="/node_modules/***" \
  --exclude="*" /opt/loop-app-staging/ /opt/loop-app/'
echo 'Candidate verified and promoted without a second build. Restart when no study is active: gcloud compute ssh loop-app --project=tavus-511105 --zone=us-central1-a --tunnel-through-iap --command="sudo systemctl restart loop-app"'
