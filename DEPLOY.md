# Deploying Phone Remote to AWS

## ✅ Current deployment (2026-07-10)

| Resource | Value |
|---|---|
| Region | ap-south-1 (Mumbai) |
| EC2 instance | `i-0ec6440e1d7bd748c` (t3.medium, Ubuntu 24.04, 8GB swap) |
| Elastic IP | 3.6.239.48 |
| Public URL | **https://3-6-239-48.sslip.io** (free wildcard DNS resolving to the Elastic IP — no domain purchase needed) |
| TLS | Let's Encrypt via certbot, auto-renews (expires 2026-10-08, renewed automatically before then) |
| Security group | `sg-0291d93d24ad4f7c6` (22 from home IP — rotates with ISP, update as needed; 80/443 public) |
| SSH key | `~/.ssh/phone-remote.pem` → `ssh -i ~/.ssh/phone-remote.pem ubuntu@3.6.239.48` |
| Database | SQLite on instance (`~/phone-remote/server/data/phoneremote.db`) — no RDS |
| Process | PM2 `phone-remote` (fork, 1 instance, starts on boot) |
| Proxy | nginx :80 → :443 redirect → node :3000, WebSocket upgrade (wss://) enabled |
| Build toolchain | Flutter 3.44.6 + Android SDK 36 + NDK 28.2 installed on-instance (`~/flutter`, `~/android-sdk`) for APK builds |

**Redeploy after code changes** (from repo root on Windows):

```bash
tar --exclude=node_modules --exclude=data --exclude=logs --exclude=.env \
    -czf /c/Users/hp/AppData/Local/Temp/phone-remote-server.tgz server
scp -i ~/.ssh/phone-remote.pem /c/Users/hp/AppData/Local/Temp/phone-remote-server.tgz ubuntu@3.6.239.48:
ssh -i ~/.ssh/phone-remote.pem ubuntu@3.6.239.48 \
    "tar xzf phone-remote-server.tgz -C ~/phone-remote && cd ~/phone-remote/server && npm install --omit=dev && pm2 restart phone-remote"
```

If you later buy a real domain: Route 53 A-record → 3.6.239.48, then
`sudo certbot --nginx -d yourdomain.com` on the instance (section 4 below),
and change `kDefaultServerUrl` to `https://yourdomain.com`. The sslip.io
setup can be dropped once a real domain is live.

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

1. RDS → Create database → PostgreSQL → **db.t4g.micro**, 20 GB gp3.
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
