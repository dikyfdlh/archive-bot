# Panduan Deploy: VPS Ubuntu + Caddy

Target: 1 VPS Ubuntu 22.04/24.04 dengan domain HTTPS publik. Caddy dipakai sebagai reverse proxy karena otomatis urus Let's Encrypt — kalau kamu lebih suka nginx, contoh nginx ada di bagian bawah.

## Ringkasan urutan

1. Siapkan domain dan A record ke IP VPS.
2. Pasang Node.js 22 dan Caddy di VPS.
3. Buat user sistem `archivebot` dan deploy kode.
4. Isi `.env` (atau pakai panel `/admin`).
5. Aktifkan service systemd.
6. Pasang reverse proxy Caddy.
7. Daftarkan webhook di Meta Developers.
8. Share folder Drive ke service account.

## 1. Prasyarat di VPS

```bash
# Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy (apt repo resmi)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 2. User dan direktori

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin archivebot
sudo mkdir -p /opt/archive-manager-bot
sudo chown archivebot:archivebot /opt/archive-manager-bot
```

## 3. Deploy kode

Dari mesin lokal (Windows / WSL / mana saja):

```bash
# Contoh dengan rsync. Atau pakai scp / git pull dari VPS.
rsync -av --exclude node_modules --exclude .env --exclude data \
  ./ user@vps:/tmp/archive-bot/

ssh user@vps 'sudo rsync -av --delete /tmp/archive-bot/ /opt/archive-manager-bot/ \
  && sudo chown -R archivebot:archivebot /opt/archive-manager-bot'
```

Project ini zero-dependency, jadi tidak perlu `npm install`. Cukup pastikan `node --version` >= 22.

## 4. Isi .env

Cara cepat: salin `.env.example` lalu edit dengan editor favoritmu.

```bash
sudo -u archivebot cp /opt/archive-manager-bot/.env.example /opt/archive-manager-bot/.env
sudo -u archivebot nano /opt/archive-manager-bot/.env
sudo chmod 600 /opt/archive-manager-bot/.env
```

Atau pakai panel `/admin` setelah service jalan (akses dari laptop via SSH tunnel sampai `ADMIN_TOKEN` terisi):

```bash
ssh -L 3000:127.0.0.1:3000 user@vps
# Buka http://localhost:3000/admin di browser laptop
```

Field minimum yang harus terisi: `PUBLIC_BASE_URL`, `ADMIN_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `AUTHORIZED_WA_NUMBERS`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`.

## 5. systemd service

Buat file `/etc/systemd/system/archive-bot.service`:

```ini
[Unit]
Description=Archive Manager Bot (WhatsApp -> Google Drive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=archivebot
Group=archivebot
WorkingDirectory=/opt/archive-manager-bot
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/opt/archive-manager-bot/data /opt/archive-manager-bot/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=archive-bot

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now archive-bot
sudo systemctl status archive-bot --no-pager
journalctl -u archive-bot -f
```

Cek bot listen di port 3000:

```bash
curl -s http://127.0.0.1:3000/health | jq
curl -s http://127.0.0.1:3000/webhook/health | jq
```

`/webhook/health` baru balas `200` jika `missingConfig` kosong. Pakai endpoint ini untuk healthcheck deploy.

## 6. Caddy reverse proxy

Isi `/etc/caddy/Caddyfile`:

```caddy
arsip.domain-kamu.com {
    encode zstd gzip

    # Batasi body upload sesuai WEBHOOK_MAX_BODY_BYTES + sedikit margin
    request_body {
        max_size 12MB
    }

    # Webhook tidak perlu di-cache
    @webhook path /webhook* /api/admin/* /admin
    header @webhook Cache-Control "no-store"

    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-For {remote_host}
    }
}
```

Reload:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy akan otomatis ambil sertifikat Let's Encrypt. Cek dari laptop:

```bash
curl -s https://arsip.domain-kamu.com/health | jq
```

## 7. Daftarkan webhook di Meta

1. Meta Developers → app kamu → WhatsApp → Configuration → Webhook.
2. Callback URL: `https://arsip.domain-kamu.com/webhook`
3. Verify token: nilai `WHATSAPP_VERIFY_TOKEN` di `.env`.
4. Klik **Verify and save**. Meta akan kirim GET ke endpoint; cek log bot:

   ```bash
   journalctl -u archive-bot -f
   ```

5. Subscribe field `messages` (dan opsional `message_template_status_update` kalau dipakai).
6. Test kirim pesan ke nomor bot. Cek log harus muncul `Webhook received` dan `Archived ok` saat kirim file.

## 8. Setup Google Drive (service account)

1. https://console.cloud.google.com → buat project baru.
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **IAM & Admin → Service Accounts → Create service account**. Beri nama `archive-bot-sa`.
4. Klik service account → **Keys → Add key → Create new key → JSON**. File JSON terdownload.
5. Buka file JSON, ambil field `client_email` (untuk `GOOGLE_SERVICE_ACCOUNT_EMAIL`) dan `private_key` (untuk `GOOGLE_PRIVATE_KEY`).
6. Buat folder di Google Drive (akun pribadi atau Workspace), klik kanan **Share** → tempel `client_email` → role **Editor**.
7. Ambil folder ID dari URL: `drive.google.com/drive/folders/<FOLDER_ID>`.
8. Kosongkan `GOOGLE_DRIVE_IMPERSONATE_USER` kecuali kamu pakai Google Workspace dengan domain-wide delegation aktif.

## Rotasi credential

Karena `.env` lama sudah pernah ter-expose:

```bash
# WhatsApp
# Meta Developers -> WhatsApp -> System Users -> Generate new token (revoke yang lama)
# Meta Developers -> Settings -> Basic -> Reset App Secret

# Google
# Console -> IAM -> service account -> Keys -> Add key baru, Delete key lama
```

Setelah dapat nilai baru, edit `.env` (atau pakai `/admin`) lalu:

```bash
sudo systemctl restart archive-bot
```

## Verifikasi end-to-end

1. Kirim pesan `help` ke nomor bot dari nomor yang terdaftar di `AUTHORIZED_WA_NUMBERS` → harus balas menu bantuan.
2. Kirim sebuah PDF → harus balas `Berhasil diarsipkan: ARS-...` dan file muncul di folder Drive.
3. Kirim `list` → harus balas daftar arsip terbaru.
4. Kirim `ambil ARS-...` → harus balas file PDF atau link Drive.
5. Kirim `share ARS-...` → harus balas URL Drive yang bisa diakses anyone-with-link.

## Troubleshooting cepat

| Gejala | Sumber paling umum |
|--------|---------------------|
| `401 Invalid signature` di log | `WHATSAPP_APP_SECRET` salah / belum diset |
| Webhook verification gagal di Meta | `WHATSAPP_VERIFY_TOKEN` di `.env` beda dengan yang ditulis di Meta |
| Bot diam saat kirim file | Nomor pengirim tidak ada di `AUTHORIZED_WA_NUMBERS` |
| `unauthorized_client` dari Google | `GOOGLE_DRIVE_IMPERSONATE_USER` terisi padahal bukan Workspace DWD |
| `invalid_grant` dari Google | `GOOGLE_SERVICE_ACCOUNT_EMAIL` salah atau bukan email service account |
| `404` saat kirim balasan WA | `WHATSAPP_PHONE_NUMBER_ID` masih berisi nomor HP, bukan Phone Number ID |
| Upload Drive `404 File not found` | Folder Drive belum di-share ke email service account |

## Update deploy berikutnya

```bash
# Dari laptop
rsync -av --exclude node_modules --exclude .env --exclude data \
  ./ user@vps:/tmp/archive-bot/

ssh user@vps '
  sudo rsync -av --delete --exclude .env --exclude data /tmp/archive-bot/ /opt/archive-manager-bot/ \
  && sudo chown -R archivebot:archivebot /opt/archive-manager-bot \
  && sudo systemctl restart archive-bot
'
```

## Alternatif: nginx (kalau tidak mau pakai Caddy)

```nginx
server {
    listen 443 ssl http2;
    server_name arsip.domain-kamu.com;

    ssl_certificate     /etc/letsencrypt/live/arsip.domain-kamu.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arsip.domain-kamu.com/privkey.pem;

    client_max_body_size 12m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

server {
    listen 80;
    server_name arsip.domain-kamu.com;
    return 301 https://$host$request_uri;
}
```

Sertifikat pakai certbot:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d arsip.domain-kamu.com
```
