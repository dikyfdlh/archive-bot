#!/usr/bin/env bash
# Archive Manager Bot - First-time VPS setup (Ubuntu 22.04/24.04)
# Run as a sudo-capable user. Idempotent: re-running tidak merusak state.
#
# Usage:
#   sudo bash install.sh arsip.domain-kamu.com
#
# Argumen:
#   $1 = domain HTTPS publik (wajib). Caddy akan auto-issue Let's Encrypt cert.

set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash install.sh <domain>"
  echo "Contoh: sudo bash install.sh arsip.domain-kamu.com"
  exit 1
fi

REPO_URL="https://github.com/dikyfdlh/archive-bot.git"
APP_USER="archivebot"
APP_DIR="/opt/archive-manager-bot"
SERVICE_FILE="/etc/systemd/system/archive-bot.service"
CADDYFILE="/etc/caddy/Caddyfile"

echo "==> Domain: $DOMAIN"
echo "==> Repo:   $REPO_URL"
echo "==> App:    $APP_DIR"

# 1. System packages
echo "==> [1/7] Update apt & install base packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg git rsync ufw

# 2. Node.js 22 (NodeSource)
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  echo "==> [2/7] Install Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "==> [2/7] Node $(node --version) sudah terpasang, skip"
fi

# 3. Caddy
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> [3/7] Install Caddy"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
else
  echo "==> [3/7] Caddy sudah terpasang, skip"
fi

# 4. App user + clone
echo "==> [4/7] Pastikan user $APP_USER ada"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "==> Clone repo ke $APP_DIR"
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  echo "==> Repo sudah ada, pull terbaru"
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
fi

install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"

# 5. .env bootstrap
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> [5/7] Bootstrap .env dari .env.example"
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i "s|PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=\"https://${DOMAIN}\"|" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    -> EDIT $APP_DIR/.env DULU sebelum bot berguna."
else
  echo "==> [5/7] $APP_DIR/.env sudah ada, dipertahankan"
fi

# 6. systemd
echo "==> [6/7] Tulis systemd unit"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Archive Manager Bot (WhatsApp -> Google Drive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$APP_DIR/data $APP_DIR/.env

StandardOutput=journal
StandardError=journal
SyslogIdentifier=archive-bot

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable archive-bot
systemctl restart archive-bot
sleep 1
systemctl is-active --quiet archive-bot && echo "    -> archive-bot aktif" || (echo "    -> archive-bot GAGAL start, cek: journalctl -u archive-bot -n 50" && exit 1)

# 7. Caddyfile
echo "==> [7/7] Tulis Caddyfile untuk $DOMAIN"
cat > "$CADDYFILE" <<EOF
{
  email admin@${DOMAIN#*.}
}

${DOMAIN} {
    encode zstd gzip
    request_body { max_size 12MB }

    @nocache path /webhook* /api/admin/* /admin
    header @nocache Cache-Control "no-store"

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-For {remote_host}
    }
}
EOF

caddy fmt --overwrite "$CADDYFILE" >/dev/null
systemctl reload caddy
sleep 1
systemctl is-active --quiet caddy && echo "    -> Caddy aktif" || (echo "    -> Caddy GAGAL reload" && exit 1)

# Firewall
echo "==> Konfig UFW (allow 22, 80, 443)"
ufw --force enable >/dev/null 2>&1 || true
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80,443/tcp >/dev/null 2>&1 || true

cat <<MSG

============================================================
 Setup selesai.

 Berikutnya:
   1. Edit kredensial: sudo -u $APP_USER nano $APP_DIR/.env
      (atau buka panel admin via SSH tunnel ke localhost:3000/admin)
   2. Restart:        sudo systemctl restart archive-bot
   3. Cek webhook health:
        curl -s https://${DOMAIN}/webhook/health | head -c 400; echo
   4. Daftarkan webhook di Meta Developers:
        Callback URL: https://${DOMAIN}/webhook
        Verify token: nilai WHATSAPP_VERIFY_TOKEN di .env
   5. Update kode kemudian: sudo bash $APP_DIR/scripts/deploy.sh

 Logs:    journalctl -u archive-bot -f
 Caddy:   journalctl -u caddy -f
============================================================
MSG
