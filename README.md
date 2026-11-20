# Phone Remote

**An MCP server that gives AI agents a real Android phone, plus a live browser dashboard to watch and take over.**

Phone Remote is a self-hosted, multi-user platform that lets AI agents (Claude,
Cursor, Antigravity, …) see and operate Android phones through the Model
Context Protocol (MCP): read the screen, tap, type, open apps, read OTPs and
move files. The same phones are available to people in a web dashboard that
streams the screen and camera over WebRTC and accepts touch input back.

It runs without root: a native Android companion app does the capture and input
work, and everything keeps running in the background after the app is closed.

**Free and open source (MIT).** Use the hosted server, or run your own from this
repository. See [Use it with your AI agent](#use-it-with-your-ai-agent).

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [How streaming works](#how-streaming-works)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Quick start (local development)](#quick-start-local-development)
- [Production deployment](#production-deployment)
- [Configuration](#configuration)
- [The Android app](#the-android-app)
- [AI agents (MCP)](#ai-agents-mcp)
  - [Use it with your AI agent](#use-it-with-your-ai-agent)
- [Security](#security)
- [Diagnostics and troubleshooting](#diagnostics-and-troubleshooting)
- [Further documentation](#further-documentation)

---

## Features

**AI agent control (MCP)**

- **31 tools.** Gestures, a structured UI tree with normalized coordinates, waiting for screen states, apps (open, list with sizes, find unused, uninstall, clear cache/data), deep links, direct Settings pages, opening files and folders, notifications/OTPs, hardware, and file transfer.
- **One modern endpoint.** Streamable HTTP at `/mcp` with OAuth 2.1 + PKCE and dynamic client registration: paste the URL, sign in, approve. A plain `Authorization: Bearer` token works too.
- **Agent-friendly metadata.** Every tool has a title and MCP annotations (13 read-only, 2 destructive: `uninstall_app`, `clear_app_storage`), so clients can auto-approve safe calls and ask before risky ones. Connecting agents also receive short usage instructions.
- **Per-account isolation.** An agent only ever sees the phones of the account that approved it, and the approval page shows which account that is.

**Web dashboard (React)**

- **Live screen mirror with touch control.** Tap, swipe, scroll, type, use system keys. The phone frame follows the phone's orientation, so landscape videos and games fill the view.
- **Live camera.** Front or back camera, also over WebRTC.
- **File manager.** Browse the phone's storage, upload with drag and drop, and download. Your place survives a page refresh.
- **Location**, **ring** (even on silent), **flashlight blink**, **screenshots**.
- **Multi-account, multi-device.** Each user sees only their own phones, with live online status.

**Streaming**

- **WebRTC only.** Hardware H.264/VP8 encoding at up to 60 fps, typically 3–5× less data than frame-by-frame images.
- **Works across networks.** A direct peer-to-peer path when possible; otherwise a built-in TURN relay over UDP, TCP, or TLS on port 443, which gets through firewalls that only allow HTTPS.
- **Survives network switches.** Moving between Wi-Fi and mobile data repairs the same call (ICE restart), measured at 1–6 s, with automatic fallbacks so it never stays stuck.
- **Low latency.** Real-time encoding that keeps the frame rate and lowers resolution under tight bandwidth, and no playback buffering.

**Operations**

- **One command to deploy.** `docker compose up -d --build` starts the web app and MCP server, nginx and the TURN relay.
- **Free HTTPS.** Let's Encrypt certificates with automatic renewal.

---

## Architecture

```mermaid
flowchart LR
    subgraph Users
        Browser["Web browser<br/>(React dashboard)"]
        Agent["AI agent<br/>(Claude / Cursor / Antigravity)"]
    end

    subgraph Server["Server — Docker Compose"]
        Nginx["nginx :443<br/>SNI router + TLS"]
        App["app — Node.js :3000<br/>MCP /mcp · REST · WebSocket signalling<br/>serves the React build"]
        TURN["coturn<br/>TURN :3478 + TLS via :443"]
        DB[("SQLite / PostgreSQL<br/>users · devices")]
    end

    subgraph Phone["Android phone"]
        Svc["Companion app<br/>Kotlin foreground services"]
    end

    Browser -- "HTTPS + WebSocket" --> Nginx
    Agent -- "MCP (Streamable HTTP + OAuth)" --> Nginx
    Nginx --> App
    Nginx -- "turn.&lt;domain&gt;" --> TURN
    App <--> DB
    Svc <-- "WebSocket (control, files, signalling)" --> Nginx

    Svc == "WebRTC video: direct P2P" ==> Browser
    Svc -. "or relayed when direct is blocked" .-> TURN
    TURN -. relay .-> Browser
```

- **Control plane.** The phone holds a persistent secure WebSocket to the server. Every command (touch, keys, files, MCP tool calls) and all WebRTC signalling goes through it, scoped to the authenticated account and device.
- **Media plane.** Screen and camera video go **directly from phone to browser** over WebRTC. Only when no direct path exists does the video pass through the server's TURN relay.
- **Background operation.** Capture, input injection, the socket and WebRTC all live in native Kotlin foreground services, so streaming continues with the app UI closed.

---

## How streaming works

1. You click **Start Streaming** or **Front/Back camera**. The browser sends a WebRTC offer through the server, and the phone answers.
2. The phone's capture (MediaProjection for the screen, Camera2 for the camera) is routed straight into a hardware video encoder.
3. WebRTC tries every phone↔browser address pair and uses the best one that works:

   | Order | Path | Typical latency | Used when |
   |---|---|---|---|
   | 1 | Direct, same network | ~5 ms | Phone and browser on the same Wi-Fi |
   | 2 | Direct over the internet (STUN / IPv6) | 20–60 ms | Most home and mobile networks |
   | 3 | TURN relay, UDP/TCP 3478 | +50–100 ms | Strict NAT / carrier-grade NAT |
   | 4 | TURN relay, TLS on 443 | +50–100 ms | Networks that only allow HTTPS |

4. **When the network changes** (for example Wi-Fi → mobile data), the phone reconnects instantly and the browser **ICE-restarts** the same call onto the new path. If that can't complete, it falls back to a fresh call, with a 20 s safety deadline and page watchdogs, so the stream always comes back on its own.

> The legacy JPEG-over-WebSocket streaming path still exists in the code but is
> switched off (`JPEG_FALLBACK = false`). Screenshots for AI agents are
> unaffected.

---

## Tech stack

| Layer | Technology |
|---|---|
| Android app | Flutter (UI) + **Kotlin** foreground services, libwebrtc (`io.github.webrtc-sdk:android`), MediaProjection, Camera2, AccessibilityService, NotificationListenerService, OkHttp |
| Web client | React 19, Vite, Context API, `lucide-react` |
| Server + MCP | Node.js 22, Express, `ws`, JWT (bcryptjs), `@modelcontextprotocol/sdk` (Streamable HTTP), `sharp` |
| Media relay | coturn 4.7 (TURN REST API, short-lived HMAC credentials) |
| Data | SQLite (default) or PostgreSQL (`DATABASE_URL`) |
| Infrastructure | Docker Compose, nginx (stream SNI router + TLS), Let's Encrypt, AWS EC2 |

---

## Repository layout

```
.
├── client/                 React web dashboard (Vite)
│   └── src/
│       ├── context/        Auth + device/WebSocket state (DeviceContext)
│       ├── hooks/          useRtcStream — WebRTC client, ICE restart, recovery
│       └── pages/          Dashboard, Mirror, Camera, Files, Location, MCP test
├── server/                 Node.js backend
│   ├── src/
│   │   ├── routes/         mcp (28 tools, Streamable HTTP), oauth, auth, files
│   │   └── services/       signaling (WebSocket hub), turn, db, oauthStore
│   └── public/             OAuth consent page
├── flutter_app/            Android companion app
│   ├── lib/                Flutter UI (login, home, files)
│   ├── android/app/src/main/kotlin/com/phoneremote/
│   │                       Native services: connection, screen/camera capture,
│   │                       WebRTC, accessibility input, notifications
│   └── pubspec.yaml
├── nginx/                  nginx image: SNI router (stream.conf) + site (default.conf)
├── docker-compose.yml      nginx · app · coturn (+ turn-init)
├── DEPLOY.md               Production deployment runbook
└── MCP_PHONE_NAVIGATION.md Playbook for AI agents (deep links, app navigation)
```

---

## Quick start (local development)

**Prerequisites:** Node.js 22+, Flutter 3.44+ with Android SDK 36 / NDK 28.2, and an Android phone running Android 7.0 or later.

```bash
# 1. Server
cd server
cp .env.example .env          # set JWT_SECRET (see Configuration)
npm install
npm run dev                   # http://localhost:3000
```

```bash
# 2. Web client (proxies /api, /ws and /mcp to :3000)
cd client
npm install
npm run dev                   # http://localhost:5173
```

```bash
# 3. Android app — point it at your server and run on a USB-connected phone
cd flutter_app
flutter run
```

Create an account in the browser, sign in with the same account on the phone,
and grant the permissions the app asks for. The phone then appears on the
dashboard.

> Without a TURN server, WebRTC still works when the phone and browser can reach
> each other directly (for example on the same Wi-Fi).

---

## Production deployment

The whole stack is defined in `docker-compose.yml`:

```bash
cd ~/phone-remote
sudo docker compose up -d --build
```

| Service | Role |
|---|---|
| `nginx` | Public `:80/:443`. Routes TLS by hostname: `turn.<domain>` → TURN, everything else → the site |
| `app` | Node.js server: MCP endpoint, REST, WebSocket signalling, and the built React client |
| `coturn` | TURN relay (host networking, relay ports 49160–49200/udp) |
| `turn-init` | One-shot job that generates the TURN shared secret on first run |

**Firewall:** open 80/tcp, 443/tcp, 3478/tcp+udp and 49160–49200/udp.

**Certificates:** one Let's Encrypt certificate must cover both `<domain>` and `turn.<domain>`.

The complete runbook — certificates, redeploys, building and publishing the
APK, image publishing and moving to your own domain — is in
**[DEPLOY.md](DEPLOY.md)**.

---

## Configuration

**`server/.env`**

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | Secret used to sign login tokens. Generate a long random value. |
| `PUBLIC_URL` | yes (prod) | Public base URL, for example `https://example.com`. Used for OAuth metadata and TURN hostnames. |
| `PORT` | no | HTTP port, default `3000`. |
| `TOKEN_TTL` | no | Login token lifetime, default `30d`. |
| `DATABASE_URL` | no | PostgreSQL connection string. Empty means SQLite in `server/data/`. |
| `FILE_DIR` | no | Root folder for per-account file storage. |

**Set by `docker-compose.yml` (override from the shell or a root `.env`)**

| Variable | Description |
|---|---|
| `DOMAIN` | Public hostname. The app and the TURN-over-TLS hostname follow it. The domain is written directly into `nginx/default.conf` and `nginx/stream.conf`: edit it there too when you change domains. |
| `TURN_EXTERNAL_IP` / `TURN_PRIVATE_IP` | Override coturn's auto-detected public and private addresses. |
| `TURN_TLS_HOST` | Hostname for `turns:` on 443, default `turn.${DOMAIN}`. |
| `TURN_SECRET_FILE` | Shared TURN secret, generated automatically by `turn-init`. |
| `DOWNLOADS_DIR` | Mounted folder served at the site root (for example `/phone-remote.apk`). |

**Feature switches**

| Switch | Where | Default |
|---|---|---|
| `ICE_RESTART` | `client/src/hooks/useRtcStream.js` | `true`: repair calls across network switches |
| `ICE_RESTART_HINT` | `server/src/services/signaling.js` | `true`: tell browsers to repair when the phone reconnects |
| `JPEG_FALLBACK` | `useRtcStream.js` + `ConnectionForegroundService.kt` | `false`: WebRTC-only streaming |

---

## The Android app

**Install.** Download `/phone-remote.apk` from your server, install it, sign in, and grant:

| Permission | Used for |
|---|---|
| Screen capture (asked on first stream) | Screen mirroring |
| Accessibility service | Touch, swipe, typing, system keys, UI tree |
| Notification access | `read_notifications` (OTPs, messages) |
| Camera, location, storage | Camera stream, location, file manager |
| Battery: unrestricted | Keeps the background service alive on aggressive OEMs |

**Build a release APK:**

```bash
cd flutter_app
flutter build apk --release --target-platform android-arm64
```

libwebrtc ships no shrinker rules. If R8 strips its Java classes, the app
crashes the moment WebRTC starts. `android/app/proguard-rules.pro` keeps them:
leave those rules in place.

---

## AI agents (MCP)

One endpoint, `https://<domain>/mcp`, using the current MCP transport
(Streamable HTTP). All coordinates are normalized from `0.0` to `1.0` (a
fraction of the screen width and height), not pixels.

### Use it with your AI agent

**Using Claude? The easy way:** install the app (step 1 below), download
[`phone-remote-plugin.zip`](https://github.com/GuptaOum/phone-remote/releases/latest/download/phone-remote-plugin.zip),
add it as a plugin in Claude, and sign in when the browser opens. That's it:
the plugin brings the MCP server and the skill together. In the Claude Code
terminal, run `/plugin marketplace add GuptaOum/phone-remote` and then
`/plugin install phone-remote@phone-remote` instead of using the zip. For any
other agent, follow the steps below.

Three steps, free:

1. **Get the app.** Install the Android app on your phone:
   `https://65-1-96-152.sslip.io/phone-remote.apk` (hosted server), or the
   `/phone-remote.apk` of your own server. Create an account in the app and grant
   the permissions it lists.
2. **Add the MCP server to your agent** with the snippet for your tool below.
   Use `https://65-1-96-152.sslip.io/mcp`, or `https://<your-domain>/mcp` if you
   self-host.
3. **Sign in once.** On first use a browser window opens: sign in with the same
   account, check the **Signed in as** line, and click **Approve**. Then ask
   your agent things like *"take a screenshot of my phone"* or *"find apps I
   haven't used in a month"*.

No API key to copy: the server supports OAuth 2.1 discovery
(`/.well-known/oauth-protected-resource`) with dynamic client registration and
PKCE, so agents only need the URL.

#### The skill (recommended for every agent)

The MCP server gives an agent the tools. The **`phone-remote` skill** in
[`plugin/skills/phone-remote`](plugin/skills/phone-remote) teaches it to use
them well: jump with deep links, `open_settings` and `open_file` instead of
tapping through menus, read the screen with `get_ui_tree`, wait with
`wait_for`, follow the safety rules (ask before sending, never type PINs), plus
step-by-step recipes and a troubleshooting table. It uses the open Agent
Skills `SKILL.md` format, so the same folder works in Claude Code, Codex,
Cursor, Antigravity and other agents. One command installs it into whichever
agents you have:

```bash
npx skills add GuptaOum/phone-remote
```

(Add `-g` to install it for your user instead of the current project, or
`-a codex` / `-a cursor` / `-a antigravity` / `-a claude-code` to pick agents.)
To install by hand, copy the `plugin/skills/phone-remote` folder into the
agent's skills folder: `.claude/skills/`, `.codex/skills/`, `.cursor/skills/`
or `.agents/skills/` (Antigravity) in a project.

#### Make it yours

The skill is plain Markdown, so you can teach your agent how *your* phone
works by editing your installed copy. Keep each note short; the agent reads it
every time.

- **Your phone's apps** go in `references/deep-links.md`:
  ```
  | My gallery | `com.sec.android.gallery3d` |
  | Office chat | `com.slack` |
  ```
- **Your own recipes** go in `references/workflows.md`:
  ```
  ## Good night
  1. open_settings(page="sound"), turn on Do Not Disturb.
  2. press_key("lock").
  ```
- **Your rules** go in `SKILL.md`:
  ```
  - My phone is in Hindi: match "भेजें" for Send.
  - Never open my banking apps.
  - Save files from the PC to Documents/FromPC, not Download.
  ```

Found a recipe or fix that works on your brand (Samsung, Vivo, Xiaomi...)?
Open a pull request so other people can use it too.

#### Connect the MCP server

**Claude Code:** one command adds both the MCP server and the skill:

```
/plugin marketplace add GuptaOum/phone-remote
/plugin install phone-remote@phone-remote
```

Then run `/mcp`, pick `plugin:phone-remote:phone-remote` and choose
*Authenticate*. (MCP only, without the skill:
`claude mcp add --transport http phone-remote https://65-1-96-152.sslip.io/mcp`.)

**claude.ai, Claude Desktop, Claude mobile:** *Settings → Connectors → Add
custom connector*, URL `https://65-1-96-152.sslip.io/mcp`. Connectors can't
carry skills; the server's built-in instructions cover the basics.

**OpenAI Codex (CLI and IDE extension):**

```bash
codex mcp add phone-remote --url https://65-1-96-152.sslip.io/mcp
codex mcp login phone-remote
```

Or by hand in `~/.codex/config.toml`:

```toml
[mcp_servers.phone-remote]
url = "https://65-1-96-152.sslip.io/mcp"
```

**Google Antigravity:** add to `mcp_config.json` (*Agent panel → … → MCP
Servers → Manage MCP Servers → View raw config*):

```json
{
  "mcpServers": {
    "phone-remote": { "serverUrl": "https://65-1-96-152.sslip.io/mcp" }
  }
}
```

**Cursor:** one click:
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=phone-remote&config=eyJ1cmwiOiJodHRwczovLzY1LTEtOTYtMTUyLnNzbGlwLmlvL21jcCJ9),
or add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "phone-remote": { "url": "https://65-1-96-152.sslip.io/mcp" }
  }
}
```

**VS Code (Copilot agent mode):** `.vscode/mcp.json`:

```json
{
  "servers": {
    "phone-remote": { "type": "http", "url": "https://65-1-96-152.sslip.io/mcp" }
  }
}
```

**Any other MCP client** that speaks Streamable HTTP: point it at the `/mcp`
URL. New tools appear after the client reconnects (for example a new chat, or
reconnecting the connector).

**Clients without OAuth** can send a login token instead (`POST /api/login`
returns one, valid for 30 days):

```json
{
  "mcpServers": {
    "phone-remote": {
      "url": "https://<domain>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

> The legacy SSE transport (`/sse`) was removed: Streamable HTTP replaced it in
> the MCP specification, and every client listed above supports it.

**Tools**

| Group | Tools |
|---|---|
| Device and perception | `list_devices`, `get_device_status`, `get_location`, `get_foreground_app`, `get_ui_tree`, `wait_for`, `take_screenshot` |
| Interaction | `tap`, `long_press`, `swipe`, `scroll`, `type_text`, `press_key`, `wait` |
| Apps and navigation | `open_app`, `open_app_drawer`, `open_url`, `open_settings`, `open_file` |
| App storage | `list_apps` (with sizes), `find_unused_apps`, `clear_app_storage`, `uninstall_app` |
| Hardware and notifications | `ring`, `flash_light`, `read_notifications` |
| Files | `list_files`, `get_file`, `send_local_file`, `send_file`, `send_url` |

`get_ui_tree` returns every visible text, button and input with ready-to-tap
coordinates. Agents should prefer it over screenshots: it's faster, cheaper, and
leaves no room for guessing pixels. For how agents should combine the tools,
see the [phone-remote skill](plugin/skills/phone-remote/SKILL.md); for a longer
catalogue of deep links and packages, see
[MCP_PHONE_NAVIGATION.md](MCP_PHONE_NAVIGATION.md).

---

## Security

See also the [privacy policy](PRIVACY.md).

- **Accounts:** bcrypt-hashed passwords and JWT sessions. Every WebSocket, REST and MCP operation is scoped to the authenticated account and its own devices.
- **Device revocation:** removing a device on the dashboard disconnects it and rejects its old tokens.
- **MCP / OAuth:** PKCE (S256) is required, redirect URIs must match the registered client, and the approval page shows the signed-in account with a *Switch account* link, so a browser logged in to the wrong account can't silently link it.
- **TURN:** credentials are short-lived (24 h, HMAC-signed per user), the relay refuses private and loopback destinations, and wrong credentials get `401`.
- **Transport:** HTTPS/WSS everywhere, and WebRTC media is encrypted end to end (DTLS-SRTP).
- **Files:** one-time signed URLs for downloads and uploads, with per-account storage roots.

---

## Diagnostics and troubleshooting

**WebRTC on the phone** (USB debugging enabled):

```bash
adb logcat -s PhoneRemote
# rtc screen: 60fps 564x1266 1400kbps limit=bandwidth path=host/udp→srflx rtt=0.032
```

`path` shows the route: `host`, `srflx` and `prflx` are direct; `relay` goes through coturn. `limit` shows what is capping quality.

**WebRTC in the browser:** each step is reported to the server log:

```bash
cd ~/phone-remote && docker compose logs app-blue app-green | grep -E "🔗|🧭"
# 🧭 rtc screen ice-restart attempt 1
# 🧭 rtc screen answer
# 🔗 WebRTC screen connected
```

| Symptom | Check |
|---|---|
| App closes the moment streaming starts | R8 keep rules missing: check `android/app/proguard-rules.pro` |
| Stuck on "Connecting video…" | `🧭` trace; TURN ports open; `turn.<domain>` included in the certificate |
| Phone shows offline | App battery set to Unrestricted; the phone's own logs |
| Agent gets `401` | Token expired: sign in again, or re-authorize the connector |

---

## Further documentation

- **[DEPLOY.md](DEPLOY.md):** production runbook (EC2, Docker Compose, TLS, TURN, APK publishing).
- **[MCP_PHONE_NAVIGATION.md](MCP_PHONE_NAVIGATION.md):** playbook for AI agents operating the phone.
- **[PROJECT_MEMORY.md](PROJECT_MEMORY.md):** design history and project notes.

---

## License

[MIT](LICENSE): free to use, modify and self-host.
