#!/usr/bin/env bash
set -euo pipefail
[[ -f /var/lib/loop-app/bootstrap-complete ]] && exit 0
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git python3 xz-utils build-essential rsync ffmpeg debian-keyring debian-archive-keyring apt-transport-https
id loopapp >/dev/null 2>&1 || useradd --create-home --shell /bin/bash loopapp
install -d -o loopapp -g loopapp /opt/loop-app /opt/loop-app-staging /var/lib/loop-app
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg --yes
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
builddir=$(mktemp -d)
cd "$builddir"
curl -fsS https://nodejs.org/dist/v22.23.0/node-v22.23.0-linux-x64.tar.xz -o node.tar.xz
curl -fsS https://nodejs.org/dist/v22.23.0/SHASUMS256.txt -o SHASUMS256.txt
sed 's/node-v22.23.0-linux-x64.tar.xz/node.tar.xz/' SHASUMS256.txt | awk '$2 == "node.tar.xz"' | sha256sum --check
tar -xJf node.tar.xz --strip-components=1 -C /usr/local
npm install --global pnpm@10
rm -rf "$builddir"
install -d -m 700 -o loopapp -g loopapp /home/loopapp/.ssh
test -f /home/loopapp/.ssh/worker_ed25519 || sudo -u loopapp ssh-keygen -q -t ed25519 -N '' -f /home/loopapp/.ssh/worker_ed25519 -C loop-app-worker
cat > /etc/systemd/system/loop-app.service <<'SERVICE'
[Unit]
Description=Loop interview backend
After=network-online.target
Wants=network-online.target
[Service]
User=loopapp
Group=loopapp
WorkingDirectory=/opt/loop-app
EnvironmentFile=/etc/loop-app.env
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node --import tsx server/index.ts
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
UMask=0077
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
touch /var/lib/loop-app/bootstrap-complete
