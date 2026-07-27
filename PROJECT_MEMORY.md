---
name: phone-remote-unified
description: "Unified memory for Phone Remote — project state, SaaS deployment, MCP layer, file transfer, WebSocket internals, and related side projects (Spaceborn website, university auth question)"
metadata:
  node_type: memory
  type: project
---

Consolidated from the Claude memory store for this project (multiple separate files) into one, so the repo itself carries full context independent of any local Claude memory cache.

---

# Part 1 — Project Overview

A Flutter Android app + Node.js server + browser UI for remotely controlling an Android phone wirelessly (screen mirror, touch control, camera, file manager). Goal: evolve into a full AirDroid-like multi-user SaaS.

## Stack (current)
- **Phone:** Flutter (Dart) + Kotlin native Android code
- **Server:** Node.js + Express + WebSocket (runs on user's PC, and deployed on EC2 for the SaaS version)
- **Browser:** Separate HTML pages per route (vanilla JS, no React/SPA)
- **Tunnel:** ngrok (local dev) — replaced by EC2 + Elastic IP for the SaaS version

## User profile
- Building a personal AirDroid-like remote phone control system, evolving into a multi-user SaaS product
- Has a Realme phone (RMX3151, Android 13, 1080x2412 resolution) — device ADB ID may change if USB reconnected
- Comfortable with giving high-level goals and letting Claude implement; wants production-quality code, not prototypes

---

# Part 2 — SaaS Migration + AWS Deployment (DONE, 2026-07-10)

The multi-user migration is BUILT and DEPLOYED. MCP layer was intentionally deferred at this point (done later — see Part 3).

## Live AWS deployment
- Region **ap-south-1**, EC2 **i-0ec6440e1d7bd748c** (t3.micro, Ubuntu 24.04), Elastic IP **http://3.6.239.48**
- SSH: `ssh -i ~/.ssh/phone-remote.pem ubuntu@3.6.239.48` (SG sg-0291d93d24ad4f7c6: 22 from home IP only, 80/443 public)
- nginx :80 → node :3000 (WS upgrade on), PM2 app `phone-remote` fork mode initially, **later migrated to Docker Compose** (see Part 4)
- **SQLite, not RDS** — user chose to skip RDS ($15/mo saved); db.js auto-selects: DATABASE_URL set → pg, empty → better-sqlite3 at server/data/phoneremote.db
- Redeploy: tar server/ (exclude node_modules/data/logs/.env) → scp → tar x → npm install → pm2 restart (superseded by Docker workflow below)

## Architecture (verified by 23-test e2e suite, passed locally AND against AWS)
- **Auth**: POST /api/register|login (bcryptjs+JWT 30d), GET /api/devices (live online status), DELETE /api/devices/:id. JWT_SECRET in server/.env (random 48B on EC2)
- **signaling.js**: accounts Map<userId, {phones: Map<deviceId,ws>, browsers: Set, lastLocation: Map}>. WS must auth {type:'auth', token} first. Browser registers with deviceId (watchId); all relays (incl. binary frames) scoped account+device.
- **Files API**: per-user dirs ROOT/<userId>/, requireAuth on all routes, token via Bearer header or ?token= (for `<a download>`)
- **Browser**: /login, /dashboard (device cards, online badges, 5s poll), ws.js guard redirects to /login (no token) or /dashboard (no device); nav links carry ?device=
- **Flutter**: login_screen.dart (kDefaultServerUrl hides the URL field), auth_service.dart (session in SharedPreferences: jwt/server_url/email + stable device_id). Kotlin ConnectionForegroundService sends auth {token, deviceId}, register {deviceId, deviceName}; auth_error → stops reconnecting; logout clears Kotlin prefs so START_STICKY can't reconnect.

## Device revocation (2026-07-10)
- Dashboard ✕ remove sets `devices.revoked_at` (row kept, hidden from listDevices) + kicks live socket with `device_removed`
- Phone register gate: token `iat*1000 < revoked_at` → rejected; fresh login (new iat) re-adds and clears revoked_at

## Ops notes
- SSH SG rule pinned to home IP which ROTATES (ISP) — on `ssh timeout`, update sg-0291d93d24ad4f7c6 port-22 rule to current checkip.amazonaws.com
- APK build pipeline on EC2: t3.medium + 8GB swap, 30GB disk, Flutter 3.44.6 + SDK36 + NDK 28.2; `build-apk.sh`/`build-apk.ps1` in repo root = package local source → scp → build → download to Downloads (local = source of truth, overwrites EC2 flutter_app)

---

# Part 3 — MCP Layer (built, tested, deployed across 2026-07-11 through 2026-07-16)

Remote MCP connector with OAuth 2.1/PKCE letting Claude (or any MCP client) control linked phones. Chose **remote connector on EC2** over local stdio server — endpoint lives on the same Node process as everything else.

## Endpoints (all on https://3-6-239-48.sslip.io)
- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` — RFC 8414/9728 discovery
- `POST /oauth/register` — RFC 7591 dynamic client registration (in-memory, no persistence — server restart means reconnecting the connector once)
- `GET /oauth/authorize` → consent screen, reuses `/login` (`?next=` support)
- `POST /oauth/authorize` — JSON API, issues auth code (PKCE S256 required)
- `POST /oauth/token` — exchanges code+verifier for access_token (same JWT signing as the app, `MCP_TOKEN_TTL` 90d default)
- `POST /mcp` — Streamable HTTP transport, single-JSON-response mode, JSON-RPC 2.0

## All 27 tools (final state) — verified live end-to-end
list_devices, get_device_status, get_location, take_screenshot, tap, long_press, swipe, scroll, type_text (+ `method:"paste"`), press_key, open_app, open_app_drawer, open_url, wait, wait_for, ring, flash_light, list_files, list_apps, get_file, send_file, send_local_file, send_url, get_foreground_app, get_ui_tree (+ `filter` param), read_notifications, get_device_status warnings.

## Key implementation trick — zero APK changes for the initial 10 tools
signaling.js bridges stateless HTTP tool calls onto the phone's existing persistent WebSocket, all in-process:
- `sendToPhone` — fire-and-forget control commands (ring/flash etc.)
- `requestFromPhone` — correlates by `id` field for request/response tools
- `captureScreenshot` — virtual watcher trick: registers a fake object in `a.browsers` with matching `watchId` whose `.send()` resolves a promise instead of touching a real socket — no Kotlin change required.

## File-send tools (3 ways, all confined to /storage/emulated/0/<folder>, 18MB cap)
- `send_file(name, data_base64, folder?)` — inline base64, token-heavy, only for tiny files.
- `send_local_file(name, folder?)` — one-time upload_url (24-byte token, 10min TTL, single-use); client streams raw bytes via `curl --data-binary`. Needs a shell.
- `send_url(url, name?, folder?)` — EC2 server downloads a public URL itself and pushes to phone. Cheapest — zero bytes through the model, works from claude.ai web too.
  - **SSRF-guarded**: custom socket `lookup` validates the actual connect IP (defeats DNS rebinding); IP-literal hosts checked explicitly via `net.isIP()` (they bypass Node's lookup callback — a real bug caught in testing: 127.0.0.1/169.254.169.254 slipped through until this explicit check was added). Blocks loopback/private/link-local/CGNAT/reserved v4+v6+IPv4-mapped, non-http schemes, re-validates every redirect hop, 18MB/20s caps. Verified against the LIVE EC2 instance (where 169.254.169.254 is actually routable) — confirmed blocked.
- `get_file` — pulls a phone file the same way via `signaling.downloadFromPhone` → one-time download URL.

## ROOT-CAUSE BUG (2026-07-15, commit `ad8689b`) — the big one
**A phone sends TWO register messages over ONE socket.** The Kotlin background service registers first (agent=service, caps, true 1080×2412 bounds), then the Flutter UI registers again over the SAME connection with no agent/caps and its own wrong 2280 height (nav-bar excluded). `ws.caps = ...` on the second register WIPED the first → every cap tool said "build too old" one second after advertising all caps, and tap coordinates were skewed.
- **Fix: register MERGES — later messages may add info, never remove it.**
- Debugging lesson: theorized wrong 4× before instrumenting the actual Set identity/contents; that's what cracked it. Instrument the exact line, don't infer.

## Confirmed actions (roadmap #2) — the false-success bug class is gone
Root cause: `handleControl` bailed silently when accessibility was off, `dispatchGesture` had no callback, and `editFocusedText` silently no-op'd with no focused field — three independent silent no-ops all reported as success.
- `dispatchGestureWithResult()` wraps dispatchGesture with a real `GestureResultCallback`; `control_ack {id, action, ok, error}` sent back to server; capability negotiation (`caps` array on register) lets old APKs fall back to fire-and-forget with an honest "cannot confirm" tag.

## Situational awareness (roadmap #3)
`get_device_status` (battery/screen/accessibility/foreground app/network/androidSdk/warnings), `get_foreground_app`, `get_ui_tree` (flattened accessibility tree, `filter` param does ON-PHONE substring filtering so a busy screen doesn't ship every node), `wait_for` (server-side poll loop, conditions text|id|app + gone:true), `read_notifications` (separate `NotificationListenerService.kt`, needs its own Settings grant — proven the accessibility tools can navigate to and grant OS-level permission screens themselves, not just in-app UI).

## Tier-3: paste-typing (fixes the long-standing WhatsApp bug)
`type_text` gains `method:"paste"` — puts text on the clipboard then fires `ACTION_PASTE` on the focused node (ACTION_SET_TEXT is advisory; WhatsApp ignores it). Not the default since it clobbers the clipboard.

**Deliberately NOT built, with reasons given to the user:**
- `read_clipboard` — Android 10+ restricts getPrimaryClip to the focused app or default IME; an AccessibilityService is not exempt. Needs a custom IME.
- `unlock`/keyguard — impossible without storing the user's PIN (a credential) or device-admin.
- Custom IME — the proper long-term fix for text input generally, separate project.

## Phone-side storage guard (v1.2.0)
`ConnectionForegroundService.confinedFile()` canonicalizes every `pf_*` path and rejects anything outside `/storage/emulated/0`; refuses to delete the base root. Also applied to MCP `list_files` server-side.

## Fidelity roadmap sequencing (agreed, mostly executed)
1. Connection reliability (Doze/battery-optimization killing the foreground service) — biggest observed pain point
2. Confirmed actions (done, see above)
3. Situational awareness (done, see above)
4. Streaming/latency via WebRTC — explicitly deferred, separate project (Coturn setup etc.)

## Known limitations (v1, acceptable tradeoffs)
- OAuth clients/codes are in-memory only — EC2 restart invalidates in-flight connections
- No refresh token; 90-day access token, re-auth needed after expiry

---

# Part 4 — Dockerized EC2 Server (2026-07-16, commit `4232700`)

Migrated from bare PM2 to Docker Compose — verified live, zero downtime beyond a planned restart.

- `docker-compose.yml` at repo root, `server/Dockerfile` (multi-stage), `server/.dockerignore`.
- **Critical gotcha caught before cutover (would have been silent data loss):** `files.js`'s `ROOT_DIR = process.env.FILE_DIR || os.homedir()+'/PhoneRemote'` — inside a container with no FILE_DIR set, resolves to `/root/PhoneRemote`, ephemeral, vanishes on every rebuild, silently destroying every account's file storage. Fixed: `FILE_DIR=/app/filestore` set explicitly, bind-mounted to the EXISTING host dir `/home/ubuntu/PhoneRemote` (no data migration needed).
- Container binds to `127.0.0.1:3000:3000` — the exact address nginx already proxies to, so zero nginx/certbot changes needed for cutover.
- Disk was at 85% before starting — cleared `~/.gradle` cache (4.9GB, safe/reclaimable) rather than resizing the EBS volume (declined handling AWS credentials directly per policy).
- PM2 process fully `pm2 delete`'d; Docker daemon `systemctl enabled`, container `restart: unless-stopped` — survives EC2 reboots.
- Rebuild/redeploy recipe: edit code → `scp` changed files → `cd ~/phone-remote && sudo docker compose up -d --build`.

## Free MCP self-test page (2026-07-16, commit `c5be293`)
Built `/mcp-test.html` — reuses the dashboard's JWT login, POSTs directly to `/mcp` with plain JSON-RPC (no LLM involved, genuinely free). Runs read-only checks plus ONE safe control action (press_key "home"). **Deliberately scoped to read-only + one safe action**, not all 27 tools — side-effectful tools (send_url/ring/open_url/WhatsApp sends) would be obnoxious to trigger casually. Result: 8/8 passed, confirmed by user.

**Note on a security-conscious moment:** while building this, minting a JWT server-side to test-login a browser without asking for the user's password was STOPPED mid-attempt by the user ("what the heck are you trying to do tell me i would do it") when a guessed DB table name didn't exist and further poking at the live DB schema was about to happen. Correct call — should have asked before exploring the live database schema.

---

# Part 5 — File Transfer System (reference)

Two completely separate transfer systems live under the Files tab in `server/public/files.html`.

## System 1 — PC Files (Browser ↔ Node.js server via HTTP)
Plain REST, no WebSocket. `GET/POST/DELETE /api/files*`. Storage root `BASE_DIR = $FILE_DIR || ~/PhoneRemote`. Path traversal blocked by `safe()`.

## System 2 — Phone Files (Browser ↔ Phone via WebSocket relay)
All data travels as JSON over WebSocket through `signaling.js`. The Kotlin service handles all `pf_*` messages directly in `handlePhoneFiles()` on a background thread — **works even when the Flutter app is fully closed**.

- Download (phone→browser): phone reads file into memory, splits into 64KB base64 chunks, sends without waiting per-chunk; server relays + acks each chunk; browser must decode base64 PER-CHUNK (concatenating base64 strings corrupts at `=` padding boundaries).
- Upload (browser→phone): **FIXED (verified 2026-07-12)** — Kotlin sends `pf_upload_chunk_ack` after each non-final chunk, uploads of any size work. Race to know: Kotlin handles `pf_upload_start` and `pf_upload_chunk` on separate threads — a sender firing the first chunk immediately after start can beat registration → `signaling.uploadToPhone()` (used by MCP `send_file`) sleeps 250ms after start for this reason.
- **Phone socket pool (2026-07-13):** the app UI and the Kotlin service each hold a live WS registering the same deviceId — server used to mutual-kick, killing transfers mid-flight. Now `acct.phonePool` keeps ALL live sockets, first live one is primary, primary-close promotes another seamlessly.
- `pf_upload_cancel` message + Kotlin 60s idle-TTL sweep as fallback.

---

# Part 6 — OkHttp WebSocket Internals (reference, used in frame-drop logic)

`queueSize()` measures bytes stuck inside OkHttp's writeQueue waiting for the OS TCP socket to accept them via a blocking `write()` syscall — an indirect signal of wire congestion (bytes piling up because the kernel's TCP buffer is full), not a direct latency measurement.

```kotlin
if ((ws?.queueSize() ?: 1L) > 0L) return@startCamera   // wire busy → drop frame
```

Dropped frames are never touched by OkHttp/network — result: never more than 1 frame in-flight, browser always sees the newest frame. Same pattern applied to screen mirror and camera streaming.

---

# Part 7 — Reference notes

**"Yash bro" WhatsApp contact:** phone number **+91 9569940885** — used via `open_url` with a `wa.me` deep link (`https://wa.me/919569940885?text=<urlencoded>`) to open WhatsApp directly into his chat with the message pre-filled, then confirm via `get_ui_tree` + `tap` on Send. When the user says "send message to yash bro," use this number directly.

**wa.me deep link format:** `https://wa.me/<countrycode><number>?text=<url-encoded text>` — an `https` scheme (not `whatsapp://`), resolves via WhatsApp's own registered intent-filter. Contact lookup by NAME is impossible (no contact-lookup tool) — always need the phone number with country code first.

**Binary WebSocket frame protocol:**
| Prefix byte | Meaning |
|---|---|
| `0x01` | Screen mirror frame (JPEG) |
| `0x02` | Camera frame (JPEG) |
| `0x03` | Screenshot result (JPEG, one-shot download) |

---

# Part 8 — Adjacent projects touched during this work

## Spaceborn website fork (E:\spacebornwebsite)
User contributes to `Spaceborn-Beyond-Autonomous/Spaceborn-main-website` via fork (origin = GuptaOum fork, upstream = org repo). Next.js 16.

- **PR #4 (merged):** `POST /api/certificates`, `GET /api/certificates/[id]`, `/verify/[id]` page. Manager's certificate generator script updated to sync rows to the website via `SPACEBORN_API_URL`/`SPACEBORN_API_KEY`. QR codes point to `spaceborn.in/verify/<cert_id>`.
- **PR #5 (open at time of writing):** migrated storage from local JSON to Postgres (`lib/db.ts` shared pg Pool, `db/schema.sql` with `ENABLE ROW LEVEL SECURITY` — blocks Supabase's auto-generated public REST/anon-key API; the app's own DATABASE_URL connection bypasses RLS as table owner regardless). Real DB: user's own Supabase project, free tier.
- Both PRs merged/opened with **zero Claude/Anthropic references** — user explicitly asked to strip all AI-authorship traces from commit messages and PR bodies.

## University auth question (parked, not yet explored)
User wants to explore in a future conversation how university-style websites with student/admin/teacher logins isolate user types and services per role — no specific university was named yet. Default to explaining the general multi-role auth pattern (roles/permissions tables, middleware route guarding, RLS-style row isolation — same RLS concept as the Spaceborn website work above) if no example is given when this resumes.
