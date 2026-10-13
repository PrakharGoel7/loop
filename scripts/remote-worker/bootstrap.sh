#!/usr/bin/env bash
set -euo pipefail
# Run as root on the dedicated Debian 12 worker. No application credentials are copied.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git python3 xz-utils build-essential rsync
id loopworker >/dev/null 2>&1 || useradd --create-home --shell /bin/bash loopworker
install -d -o loopworker -g loopworker /opt/loop-worker /var/lib/loop-worker/jobs
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
cd "$workdir"
curl -fsS https://nodejs.org/dist/index.json -o versions.json
node_version=$(python3 -c 'import json; print(next(x["version"] for x in json.load(open("versions.json")) if x["version"].startswith("v22.")))')
archive="node-${node_version}-linux-x64.tar.xz"
curl -fsS "https://nodejs.org/dist/${node_version}/${archive}" -o "$archive"
curl -fsS "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o SHASUMS256.txt
awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum --check
tar -xJf "$archive" --strip-components=1 -C /usr/local
npm install --global pnpm@10 @openai/codex@0.153.4
sudo -u loopworker git config --global user.name 'Loop Worker'
sudo -u loopworker git config --global user.email 'loop-worker@localhost'
node --version
pnpm --version
codex --version
touch /var/lib/loop-worker/bootstrap-complete
