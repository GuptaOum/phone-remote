# Phone Remote

Remote control your Android phone from any browser — screen mirroring, touch control, camera, file manager, location tracking.

---

## Setup

### 1. Server (PC)
```bash
cd server
npm install
npm start
```
Browser UI at `http://localhost:3000`. For remote access, set `NGROK_TOKEN=your_token` in `server/.env`.

### 2. Phone app
Install `flutter_app/build/app/outputs/flutter-apk/app-release.apk` on your Android phone.

### 3. Connect
- Open the browser UI → copy the server URL
- Open the app → enter the URL or scan QR code
- Grant permissions when prompted (see below)

---

## Permissions required

| Permission | What it enables | How to grant |
|---|---|---|
| **Screen Recording** | Screen mirroring | System dialog — tap Allow when browser clicks Start Stream |
| **Accessibility Service** | Touch control, typing, keys | Settings → Accessibility → Installed Services → plusU → Enable |
| **Camera** | Camera streaming | Auto-prompted when you start camera |
| **Location** | GPS tracking in browser | Auto-prompted on first connect |
| **Storage** | Phone file manager | Auto-prompted when browsing phone files |

---

## Features

### Screen Mirroring
- Binary WebSocket frames `[0x01][JPEG]` — no base64, zero-copy relay
- 12fps cap with queue-size drop guard — no latency snowball on slow tunnels
- Persistent: survives app close and swipe-to-dismiss
- MediaProjection token reused — permission dialog only once per server URL session
- Browser controls Start/Stop — phone has no Stop button

### Touch Control (no root)
- Tap, swipe, scroll, back, home, recents, volume
- Keyboard typing via hidden textarea (no Chrome find-bar interference)
- Uses Android Accessibility API — `RemoteAccessibilityService.kt`

### Camera Streaming
- Front / Back / Flip / Stop controls in browser
- Binary WebSocket frames `[0x02][JPEG]`
- 12fps cap, queue-size drop guard (same as screen mirror)
- Does NOT auto-start on connect

### Screenshot (one-shot)
- Uses `AccessibilityService.takeScreenshot()` — API 30+, Android 11+
- Binary frame `[0x03][JPEG]` — browser auto-downloads
- Works even when app is fully closed
- No file saved to phone — pure RAM → wire

### File Manager
- **PC Files** tab: browse server filesystem, upload/download/delete via HTTP REST
- **Phone Files** tab: browse Android storage, download to PC (chunked base64 via WebSocket), upload from PC, delete
- Phone file operations work even when Flutter app is closed (handled in Kotlin)

### Location Tracking
- GPS + Network provider, updates every 15s / 10m movement
- Last known location cached — browser gets it instantly on connect/refresh
- Shown on Leaflet map in browser

### Ring Phone
- Plays alarm ringtone at max volume (bypasses silent/DND)
- Works when app is closed

### Flash Blink
- Blinks torch N times (2×, 3×, 4× — picker in browser)
- Works when app is closed

---

## Architecture

```
Browser (vanilla JS, separate pages per route)
    │  WebSocket (binary frames + JSON)
    ▼
Server — Node.js + Express + WebSocket (signaling.js)
    │  WebSocket (binary frames + JSON)
    ▼
Phone — Flutter + Kotlin Android

Phone internals:
├── ConnectionForegroundService.kt  — owns WebSocket, routes all messages
├── ScreenCaptureService.kt         — MediaProjection capture loop (JPEG frames)
├── RemoteAccessibilityService.kt   — gesture/text injection via Accessibility API
├── CameraForegroundService.kt      — camera2 API, JPEG frames
├── MainActivity.kt                 — permission dialogs (screen recording)
└── Dart layer (thin wrappers, mostly bypassed by Kotlin services)
    ├── signaling_service.dart
    ├── screen_stream_service.dart
    └── touch_service.dart
```

### Binary frame protocol (WebSocket)

| Prefix byte | Content |
|---|---|
| `0x01` | Screen mirror frame (JPEG) |
| `0x02` | Camera frame (JPEG) |
| `0x03` | Screenshot result (JPEG, one-shot download) |

---

## Screen recording permission — how it works

**MediaProjection API** requires a system permission dialog. The full flow:

```
Browser clicks "Start Stream"
        ↓
ConnectionForegroundService receives stream_start
        ↓
    [Has projection token?]
        ├── YES → startScreenStreaming() → binary frames → browser
        └── NO  → showProjectionPromptNotification()
                        ↓
                  Full-screen intent notification (PRIORITY_MAX + CATEGORY_CALL)
                  + Updates persistent foreground notification to "Tap to allow ▶"
                  + Tries direct startActivity (works if screen is on)
                        ↓
                  User taps notification / app comes to front
                        ↓
                  MainActivity.requestProjectionPermission()
                        ↓
                  Android system dialog: "Allow to record screen?"
                        ↓
                  User taps Allow → onActivityResult
                        ↓
                  ScreenCaptureService.start() → projection token saved
                  ConnectionForegroundService.startScreenStreaming()
                        ↓
                  Binary frames → browser (streaming starts)
```

The permission dialog is accessible from any state:

| App state | Mechanism |
|---|---|
| App open (any screen) | Dialog appears immediately |
| App in background | Full-screen intent auto-pops app to front |
| App closed (service running) | Full-screen intent relaunches app |
| Screen off | Lock screen notification → tap → dialog |
| POST_NOTIFICATIONS denied | Always-visible foreground notification shows "Tap to allow ▶" |

---

## Touch control — how it works

```
Browser click/drag/key
        ↓
WebSocket {type:"control", action:"tap", x:0.5, y:0.3}  (normalized 0–1 coords)
        ↓
ConnectionForegroundService.handleControl()
        ↓
RemoteAccessibilityService.tap(x * screenW, y * screenH)
        ↓
AccessibilityService.dispatchGesture(GestureDescription)
        ↓
Real touch event injected into Android input stack
```

No root. No ADB. Official Android Accessibility API.

---

## Key files

| File | Purpose |
|---|---|
| `flutter_app/android/.../ConnectionForegroundService.kt` | WebSocket owner, routes all messages, handles control/camera/files/screenshot/ring/flash |
| `flutter_app/android/.../ScreenCaptureService.kt` | MediaProjection capture loop, JPEG frames |
| `flutter_app/android/.../RemoteAccessibilityService.kt` | Gesture + text injection |
| `flutter_app/android/.../CameraForegroundService.kt` | Camera2 capture |
| `flutter_app/android/.../MainActivity.kt` | Permission dialogs only (screen recording) |
| `flutter_app/lib/screens/home_screen.dart` | Main Flutter UI |
| `server/src/services/signaling.js` | WebSocket relay, all message routing |
| `server/public/mirror.html` | Screen mirror browser UI |
| `server/public/camera.html` | Camera browser UI |
| `server/public/files.html` | File manager browser UI |
| `server/public/location.html` | Location/GPS browser UI |

---

## SaaS plan (agreed, not yet built)

Target: AirDroid-like multi-user platform at `phoneremote.com`

**Infrastructure:** EC2 t3.micro + Elastic IP + RDS PostgreSQL + Route 53 + ACM SSL (~$26/mo, AWS credits)

**Build order:**
1. Auth API (`POST /api/register`, `POST /api/login` → JWT)
2. `signaling.js` routing by `accountId` (replace single-slot with per-account maps)
3. Flutter login screen (replace server URL entry)
4. Browser login + phone picker dashboard

**Zero changes needed to:** all Kotlin services, WebSocket protocol, streaming logic, permissions.

---

## Known bugs

- **Phone file upload stuck for files > 64KB** — browser awaits `pf_upload_ok` per chunk but phone only sends it on the final chunk. Fix: phone should send `pf_upload_chunk_ack` after each non-final chunk, or browser should send all chunks then wait for final ok.
