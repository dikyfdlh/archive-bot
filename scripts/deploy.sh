#!/usr/bin/env bash
# Archive Manager Bot - Update from GitHub
# Run as sudo. Pulls latest code, restarts service, prints health.
#
# Usage:
#   sudo bash /opt/archive-manager-bot/scripts/deploy.sh
#   sudo bash /opt/archive-manager-bot/scripts/deploy.sh main      # branch lain

set -euo pipefail

APP_USER="archivebot"
APP_DIR="/opt/archive-manager-bot"
BRANCH="${1:-main}"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "ERROR: $APP_DIR belum di-init. Jalankan install.sh dulu."
  exit 1
fi

echo "==> Fetch & checkout origin/$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" fetch --prune origin

BEFORE=$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)
sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$BRANCH"
sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
AFTER=$(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)

echo "==> $BEFORE -> $AFTER"

if [[ "$BEFORE" == "$AFTER" ]]; then
  echo "==> Tidak ada perubahan. Skip restart."
  exit 0
fi

echo "==> Syntax check"
sudo -u "$APP_USER" /usr/bin/node "$APP_DIR/scripts/check-syntax.mjs"

echo "==> Restart archive-bot"
systemctl restart archive-bot
sleep 1

if ! systemctl is-active --quiet archive-bot; then
  echo "FAILED: archive-bot tidak aktif. Rollback ke $BEFORE."
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "$BEFORE"
  systemctl restart archive-bot
  journalctl -u archive-bot -n 30 --no-pager
  exit 1
fi

echo "==> Health check"
curl -s -o /tmp/health.json -w "HTTP %{http_code}\n" http://127.0.0.1:3000/webhook/health
cat /tmp/health.json | head -c 600
echo
echo "==> Deploy OK ($BEFORE -> $AFTER)"
