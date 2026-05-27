# Archive Manager Bot

Bot arsip WhatsApp untuk menyimpan file otomatis ke Google Drive dan mengambilnya lagi lewat perintah WhatsApp.

## Fitur

- Terima dokumen, foto, audio, dan video dari WhatsApp Cloud API.
- Upload file ke Google Drive.
- Simpan metadata arsip lokal di `data/archive-index.json`.
- Cari arsip lewat WhatsApp.
- Kirim ulang file dari Google Drive ke WhatsApp.
- Batasi akses berdasarkan nomor WhatsApp.

## Kebutuhan

- Node.js 22 atau lebih baru.
- Akun Meta Developers dengan WhatsApp Cloud API.
- Google Cloud project dengan Google Drive API aktif.
- URL HTTPS publik untuk webhook WhatsApp.

## Setup Cepat

1. Salin konfigurasi:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Isi `.env` dengan token WhatsApp dan credential Google Drive.

3. Jalankan bot:

   ```powershell
   node src/server.js
   ```

   Atau pakai script npm:

   ```powershell
   npm.cmd run dev
   ```

4. Cek health:

   ```text
   http://localhost:3000/health
   ```

5. Buka panel konfigurasi:

   ```text
   http://localhost:3000/admin
   ```

   Jika server dipublikasi ke internet, isi `ADMIN_TOKEN` dulu lalu restart server.

## Panel Admin .env

Panel web tersedia di:

```text
http://localhost:3000/admin
```

Fungsinya:

- Edit konfigurasi server, WhatsApp, Google Drive, dan bot arsip.
- Validasi angka dasar seperti `PORT`, `WEBHOOK_MAX_BODY_BYTES`, dan `MAX_SEND_FILE_BYTES`.
- Menyimpan private key Google dengan format `.env` yang aman.
- Menampilkan konfigurasi wajib yang masih kosong.
- Copy URL webhook berdasarkan `PUBLIC_BASE_URL`.

Proteksi akses:

- Jika `ADMIN_TOKEN` kosong, panel hanya bisa dipakai dari localhost.
- Jika `ADMIN_TOKEN` diisi, browser harus memasukkan token tersebut.
- Setelah menyimpan `.env`, restart server agar konfigurasi aktif.

## Webhook

Endpoint yang tersedia:

```text
GET  /                 Info service
GET  /health           Status bot dan konfigurasi yang belum lengkap
GET  /webhook          Verifikasi webhook dari Meta
POST /webhook          Penerima event WhatsApp asli
POST /webhook/debug    Parser payload untuk testing lokal, tidak mengirim pesan
```

Untuk verifikasi Meta, gunakan callback URL:

```text
https://domain-kamu.com/webhook
```

Isi verify token di Meta sama dengan:

```env
WHATSAPP_VERIFY_TOKEN=archive-manager-verify-token
```

Webhook sudah menangani:

- Verifikasi `hub.challenge` dari Meta.
- Validasi `X-Hub-Signature-256` jika `WHATSAPP_APP_SECRET` diisi.
- Respons cepat `EVENT_RECEIVED` untuk POST `/webhook`.
- Pesan text.
- Media: document, image, audio, video.
- Status delivery/read dari WhatsApp, dicatat ke log.
- Error payload dari WhatsApp, dicatat ke log.
- Deduplikasi message ID agar event retry tidak diproses dua kali.
- Batas body request via `WEBHOOK_MAX_BODY_BYTES`.

Tes parser webhook tanpa mengirim pesan:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/webhook/debug `
  -ContentType "application/json" `
  -InFile .\samples\webhook-text.json
```

## Setup WhatsApp Cloud API

1. Buka Meta Developers, buat app tipe Business.
2. Tambahkan produk WhatsApp.
3. Ambil `Phone Number ID` dan access token, lalu isi:

   ```env
   WHATSAPP_PHONE_NUMBER_ID=
   WHATSAPP_ACCESS_TOKEN=
   ```

4. Isi token verifikasi bebas, misalnya:

   ```env
   WHATSAPP_VERIFY_TOKEN=archive-manager-verify-token
   ```

5. Di dashboard Meta, set webhook callback:

   ```text
   https://domain-kamu.com/webhook
   ```

6. Subscribe field `messages`.

Untuk development lokal, gunakan tunnel HTTPS seperti ngrok atau Cloudflare Tunnel, lalu arahkan callback ke `/webhook`.

## Setup Google Drive

Cara paling rapi untuk bot internal adalah service account:

1. Buka Google Cloud Console.
2. Enable Google Drive API.
3. Buat service account.
4. Buat key JSON.
5. Share folder Google Drive tujuan ke email service account sebagai Editor.
6. Ambil folder ID dari URL Drive:

   ```text
   https://drive.google.com/drive/folders/FOLDER_ID_DI_SINI
   ```

7. Isi `.env`:

   ```env
   GOOGLE_DRIVE_AUTH_MODE=service_account
   GOOGLE_DRIVE_FOLDER_ID=
   GOOGLE_DRIVE_SCOPE=https://www.googleapis.com/auth/drive
   GOOGLE_SERVICE_ACCOUNT_EMAIL=
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

Mode alternatif untuk testing:

```env
GOOGLE_DRIVE_AUTH_MODE=oauth_access_token
GOOGLE_OAUTH_ACCESS_TOKEN=isi_access_token_oauth
```

## Perintah WhatsApp

Kirim file langsung ke nomor bot untuk menyimpan arsip.

Gunakan caption dengan tag:

```text
#invoice #pajak
```

Perintah:

```text
help
cari invoice januari
ambil ARS-20260527-0001
list
tag ARS-20260527-0001 pajak invoice
```

## Catatan Produksi

- Jangan commit file `.env`.
- Isi `AUTHORIZED_WA_NUMBERS` agar bot hanya melayani nomor tertentu.
- Isi `WHATSAPP_APP_SECRET` agar webhook bisa diverifikasi dengan signature Meta.
- Pakai reverse proxy HTTPS atau hosting yang memberi HTTPS publik.
- Untuk penyimpanan serius, pindahkan metadata dari JSON ke PostgreSQL.
- Untuk token WhatsApp produksi, gunakan system user token dari Meta Business.

## Struktur

```text
src/
  server.js                 Webhook server
  commands.js               Parser perintah WhatsApp
  config.js                 Loader .env dan konfigurasi
  services/
    whatsapp.js             WhatsApp Cloud API client
    googleDrive.js          Google Drive API client
    archiveService.js       Logika arsip
  storage/
    archiveStore.js         Metadata arsip JSON
scripts/
  check-syntax.mjs          Pemeriksa syntax JS
data/
  archive-index.json        Dibuat otomatis
```
