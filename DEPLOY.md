# Deploying Phone Remote to AWS

## ✅ Current deployment (2026-11-18, Docker)

| Resource | Value |
|---|---|
| Region | ap-south-1 (Mumbai) |
| EC2 instance | `i-0a24a69528842b8ca` (t3.medium, Ubuntu 24.04, 40 GB disk, 2 GB swap) from AMI `phone-remote-ami-native` |
| Elastic IP | 65.1.96.152 (`eipalloc-036395a673be2841e`) |
| Public URL | **https://65-1-96-152.sslip.io** |
| TLS | Let's Encrypt, host certbot in **webroot** mode (`/var/www/certbot`, mounted into the nginx container); deploy hook reloads `phone-remote-nginx`. One cert covers **both** `65-1-96-152.sslip.io` and `turn.65-1-96-152.sslip.io` |
| Port 443 | nginx **SNI router** (`nginx/stream.conf`): `turn.<domain>` → TURN over TLS → coturn; everything else → website (internal `127.0.0.1:8443`, real client IP via PROXY protocol) |
| Security group | `sg-072b858b2f5b6e632` — 22/80/443 tcp, 3478 tcp+udp, 49160-49200 udp (TURN relay). 22 is open to all on purpose (key-only SSH) |
| SSH key | `ssh -i ~/.ssh/face-attendance.pem ubuntu@65.1.96.152` |
| Database | SQLite, bind-mounted `~/phone-remote/server/data` → container |
| Process | **Docker Compose** — `phone-remote-nginx`, `phone-remote-app-blue` / `phone-remote-app-green` (blue-green pair, only the live one runs; also serves MCP at `/mcp`), `phone-remote-turn` (coturn, host network) + one-shot `phone-remote-turn-init` (creates the TURN secret in volume `turn-secret` on first run). `restart: unless-stopped`. PM2 and host nginx are disabled. |
| TURN | coturn 4.7.0 on 3478 udp/tcp **and TLS on 443** (`turns:turn.<domain>:443`, via nginx). Relay ports 49160-49200 udp, relays only on the instance's private IP (`relay-ip`, `external-ip=public/private`, own IP allowed as peer so relay↔relay works). Public/private IP auto-detected (override `TURN_EXTERNAL_IP` / `TURN_PRIVATE_IP`). App signs 24 h credentials (`server/src/services/turn.js`, `TURN_TLS_HOST`); private/loopback peers denied. |
| WebRTC | Screen + camera stream WebRTC-first (direct → relay UDP/TCP → relay TLS 443), WebRTC-only (`JPEG_FALLBACK=false`). ICE restart on network switch (flags: `ICE_RESTART` in `client/src/hooks/useRtcStream.js`, `ICE_RESTART_HINT` in `server/src/services/signaling.js`) |
| APK download | `https://65-1-96-152.sslip.io/phone-remote.apk` served from **`~/phone-remote/downloads/`** (mounted read-only, not in the image) |
| Images | Docker Hub `oumgupta/phone-remote-{app,nginx}:latest` |
| Build toolchain | Flutter 3.44.6 + Android SDK 36 + NDK 28.2 on-instance (`~/flutter`, `~/android-sdk`) |

**Bring everything up (server, MCP, nginx, TURN):** `cd ~/phone-remote && sudo docker compose up -d --build`

**Redeploy = push to `main`.** CI/CD is automatic
(`.github/workflows/deploy.yml`):

1. **CI** (GitHub runner): builds the React client, syntax-checks the server,
   validates `docker-compose.yml`. A failure stops here; production is untouched.
2. **Deploy**: SSHes to the EC2 with a key that can only run
   `~/bin/phone-remote-deploy` (forced command in `authorized_keys`), which runs
   [`deploy/deploy.sh`](deploy/deploy.sh) from `origin/main`:
   fast-forward → build the new app image **while the live colour keeps
   serving** → start the other colour (`app-blue` ↔ `app-green`) and
   health-check it → point nginx at it with a graceful reload
   (`.deploy/app-upstream.conf`) → public health check → stop the old colour →
   push images to Docker Hub. Any failure before the old colour stops rolls
   back with **no downtime** (nginx is pointed back; the old one never stopped).
   Only the parts whose files changed are touched: `client/` `server/`
   `Dockerfile` → app, `nginx/` → nginx, `docker-compose.yml` → everything.

Docs-only (`*.md`) and Android-only (`flutter_app/**`) pushes skip the deploy.
Re-run by hand: GitHub → Actions → *CI / Deploy* → *Run workflow*, or on the
server `~/phone-remote/deploy/deploy.sh` (`FORCE=1` redeploys everything,
`FORCE=app` / `FORCE=nginx` just that part, even with no new commit). Secrets: `EC2_HOST`, `EC2_SSH_KEY`, `EC2_KNOWN_HOSTS`.

**Downtime:** none for page loads, REST and MCP calls. When the old app stops
it closes its WebSockets (code 1012); phones and browsers reconnect to the new
one within a second or two, and live streams recover via ICE restart (that
state lives in process memory and can't be handed over). An `nginx/` change
recreates nginx (~1 s). Use `deploy/deploy.sh`, not a bare `docker compose up`,
which would start both colours. Which colour is live: `cat ~/phone-remote/.deploy/app-upstream.conf`.
`~/phone-remote` is a git checkout; `server/.env`, `server/data/`, `downloads/`
and build output are gitignored, so deploys never touch them.

**Build, check and publish the APK on EC2:**

```bash
ssh -i ~/.ssh/face-attendance.pem ubuntu@65.1.96.152 "cd ~/phone-remote && git pull -q --ff-only && flutter_app/tool/build_release_apk.sh"
scp -i ~/.ssh/face-attendance.pem ubuntu@65.1.96.152:~/phone-remote/downloads/phone-remote.apk .
```

`tool/verify_release_apk.sh` must print **PASS** — it fails if R8 stripped the
libwebrtc / jni_zero classes (that crashes the app the moment WebRTC starts;
keep rules in `flutter_app/android/app/proguard-rules.pro`). Publishing is just
the `cp` into `downloads/` — no image rebuild needed.

**Debug WebRTC on a USB-connected phone:** `adb logcat -s PhoneRemote` prints
`rtc screen: <fps> <size> <kbps> limit=… path=<local>→<remote> rtt=…` every 5 s
(`host`/`srflx`/`prflx` = direct, `relay` = through coturn). The server logs
`🔗 WebRTC <kind> connected|failed → JPEG` and `🔁 … recovering`.

**Push images:** included in the redeploy command above (the ubuntu user is logged in to Docker Hub).

If you later buy a real domain: Route 53 A-records for **both** `yourdomain.com`
and `turn.yourdomain.com` → 65.1.96.152, then
`sudo certbot certonly --webroot -w /var/www/certbot --cert-name yourdomain.com -d yourdomain.com -d turn.yourdomain.com`,
set `DOMAIN=yourdomain.com` for docker compose (nginx + `TURN_TLS_HOST` follow it),
change `PUBLIC_URL` in `server/.env`, and change `kDefaultServerUrl` to
`https://yourdomain.com` (rebuild the APK). The sslip.io setup can be dropped
once a real domain is live.

---

The sections below are the from-scratch guide.

Goal: `https://yourdomain.com` — any user creates an account in the browser,
signs in with the same account in the Android app, and controls their phones
from anywhere. One server hosts all accounts (fully isolated per user).

```
Phone (Android app) ──wss──►  EC2 (nginx → Node.js :3000)  ◄──wss── Browser
                                    │
                              RDS PostgreSQL (users + devices)
```

Estimated cost: ~$26/mo (t3.micro + Elastic IP + RDS t4g.micro + Route 53).

---

## 1. RDS PostgreSQL

1. RDS → Create database → PostgreSQL → **db.t4g.micro**,  20 GB gp3.
2. Same VPC as the EC2 instance you'll create; Public access **No**.
3. Create a database named `phoneremote`, note the master user/password.
4. Security group: allow inbound `5432` **only from the EC2 security group**.

## 2. EC2

1. Launch **t3.micro**, Ubuntu 24.04 LTS.
2. Security group inbound: `22` (your IP only), `80`, `443`. Port 3000 stays closed — nginx fronts it.
3. Allocate an **Elastic IP** and associate it with the instance.

```bash
# On the instance
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

git clone <your-repo> phone-remote
cd phone-remote/server
npm install --omit=dev

cp .env.example .env && nano .env
#   JWT_SECRET   → node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   DATABASE_URL → postgres://USER:PASSWORD@<rds-endpoint>:5432/phoneremote

pm2 start ecosystem.config.js
pm2 save && pm2 startup   # run the printed command → survives reboots
```

Tables are created automatically on first start.

## 3. Domain + DNS (Route 53)

1. Register / import your domain in Route 53.
2. Create an **A record** → your Elastic IP.

## 4. HTTPS (nginx + Let's Encrypt)

> Note: ACM certificates only attach to load balancers/CloudFront, not to a
> bare EC2 instance — for a single instance, Let's Encrypt is the free path.
> (Swap in an ALB + ACM later if you outgrow one box.)

`/etc/nginx/sites-available/phoneremote`:

```nginx
server {
    server_name yourdomain.com;
    listen 80;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        # WebSocket upgrade — required for streaming/control
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;   # long-lived WS connections
        proxy_send_timeout 1h;
        client_max_body_size 4096m;  # large file uploads
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/phoneremote /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com   # auto-configures 443 + renewal
```

## 5. Point the app at production

In `flutter_app/lib/screens/login_screen.dart` set:

```dart
const String kDefaultServerUrl = 'https://yourdomain.com';
```

This hides the server-URL field entirely — users just sign in.
Rebuild the APK: `flutter build apk --release`.

## 6. Verify

1. `https://yourdomain.com` → login page. Create an account.
2. Dashboard shows "No phones linked yet".
3. Install the APK, sign in with the same account → phone appears ONLINE on the dashboard.
4. Click it → screen mirror, camera, files, location all work per-device.
5. Second account sees none of it (isolation is enforced server-side on every message).

## Scaling notes

- One t3.micro handles hundreds of concurrent WebSocket connections; screen
  streaming bandwidth (~0.5–1 Mbps per active mirror) is the real ceiling.
- **Do not enable PM2 cluster mode** — live connections are held in process
  memory. To scale horizontally: Redis pub/sub between instances, or sticky
  sessions per account, then multiple instances behind an ALB.
- Upgrade path: t3.small → t3.medium; RDS stays tiny (auth-only workload).
- WebRTC (Coturn on EC2) remains the long-term fix for streaming latency —
  stubs already exist in the app.

## Security checklist

- [ ] Strong random `JWT_SECRET` set (48+ bytes)
- [ ] RDS not publicly accessible; SG locked to EC2 SG
- [ ] Port 3000 closed externally (only nginx reaches it)
- [ ] SSH restricted to your IP
- [ ] `certbot renew --dry-run` passes
- [ ] `.env` never committed to git
