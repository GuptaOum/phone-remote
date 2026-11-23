# 📱 PHONE REMOTE — MCP NAVIGATION & DEEP LINK MASTER DIRECTORY
> **Document Purpose**: Authoritative reference manual for AI Agents controlling Android devices via the **phone-remote** Model Context Protocol (MCP) server. Contains exhaustive catalogs of deep links (`open_url`), application packages (`open_app`), in-app navigation maps, and standardized MCP tool execution sequences.

---

## ⚡ 1. The Phone Remote MCP Toolset (31 Standard Tools)

Every action performed on the phone MUST use one of these standard MCP tools. Never resort to non-MCP workarounds or ad-hoc scripts.

| Tool Name | Key Arguments | Return Value | Best Practice / Agent Usage |
| :--- | :--- | :--- | :--- |
| **`list_devices`** | None | JSON array of paired devices | Call first to verify device ID and `online: true`. |
| **`get_device_status`** | `deviceId` | Battery %, screen state, network, accessibility | Quick health check before long workflows. |
| **`get_foreground_app`** | `deviceId` | Current foreground package name | Verify if target app is currently on screen. |
| **`get_ui_tree`** | `deviceId`, `filter` (optional), `all` (bool) | Normalized tree nodes with center `(x, y)` | **Primary Perception Tool**. Always prefer over screenshot. Use `filter` to find target buttons instantly in ~50ms. |
| **`wait_for`** | `deviceId`, `text`, `id`, `app`, `gone`, `timeout` | Matched node or timeout error | **Primary Sync Tool**. Wait reactively for a screen/button to appear without static sleep loops. |
| **`list_apps`** | `deviceId`, `filter` (optional) | Array of installed apps + packages | Find installed apps and package identifiers. |
| **`take_screenshot`** | `deviceId`, `hd` (bool) | JPEG image (~700 tokens; `hd` ~1,500) | Use ONLY when visual verification (photo/media rendering) is strictly required. `hd:true` only for small print. |
| **`tap`** | `deviceId`, `x`, `y` | Tap confirmation | Normalized coordinates `(0.0 – 1.0)`. Always obtain coordinates from `get_ui_tree`. |
| **`long_press`** | `deviceId`, `x`, `y`, `ms=700` | Gesture confirmation | For context menus, multi-select, or message actions. |
| **`swipe`** | `deviceId`, `x1`, `y1`, `x2`, `y2`, `ms=300` | Gesture confirmation | For swiping carousels, notification shade, or custom drag gestures. |
| **`scroll`** | `deviceId`, `direction` (`up`/`down`/`left`/`right`), `amount=0.6` | Scroll confirmation | For scrolling through feeds, contact lists, and settings. |
| **`type_text`** | `deviceId`, `text`, `method` (`"set"` or `"paste"`), `replace` (bool), `submit` (bool) | Text injection status | Use `method="paste"` for WhatsApp and fields with existing hints. Use `submit=true` for search execution. Text is inserted at the cursor; pass `replace=true` to overwrite everything in the box (see Rule 7). |
| **`press_key`** | `deviceId`, `key` (`"back"`, `"home"`, `"recents"`, `"lock"`) | Key event status | Dismiss keyboard/modals (`"back"`), return to launcher (`"home"`). |
| **`open_app`** | `deviceId`, `package`, `name` | Launch status | Instant direct launch by package name in 1 single tool call. |
| **`open_settings`** | `deviceId`, `page`, `package` (for app pages) | Open status | Jump straight to a Settings page (wifi, bluetooth, app_info, storage, accessibility...). Prefer over `android.settings.*` URLs. |
| **`open_file`** | `deviceId`, `path`, `package` (optional) | Open status | Open a file in its default app, or a folder in the system Files app. |
| **`find_unused_apps`** | `deviceId`, `days=30`, `minSizeMB` | Unused apps, biggest first | Best candidates for freeing storage. Read-only. |
| **`clear_app_storage`** | `deviceId`, `package`, `what` (`cache`/`data`/`both`) | Size before/after | Cache is harmless; data wipes the app. Only for the app the user named. |
| **`uninstall_app`** | `deviceId`, `package`, `confirm=true` | Uninstall status | PERMANENT. Only when the user explicitly asked for that app. |
| **`collect_list`** | `deviceId`, `fromTop=true`, `maxScrolls=60`, `amount=0.4`, `descriptions`, `keepRepeated` | Numbered rows, one per list item | Scrolls a list to the end, stitches the screens, removes bars (including a title bar that only shows after scrolling) and repeated labels. Replaces manual scroll + get_ui_tree loops. Text only. Built for speed: one call runs at most ~45 s; if the header says the end was not reached, call again with `fromTop:false` to read the rest. A few rows can repeat (where screens did not line up, and at the seam between calls), so drop duplicates yourself. |
| **`open_app_drawer`**| `deviceId` | Drawer status | Opens launcher app drawer (fallback only). |
| **`open_url`** | `deviceId`, `url` | Intent dispatch status | **Fastest Navigation Method**. Bypasses multiple UI steps via Android Deep Links. |
| **`wait`** | `deviceId`, `seconds=1.5` | Sleep status | Use sparingly for animations where `wait_for` cannot match a specific node. |
| **`ring`** | `deviceId` | Ring status | Rings device at maximum volume (find my phone). |
| **`flash_light`** | `deviceId`, `count=3` | Strobe status | Blinks rear camera LED flashlight. |
| **`read_notifications`**| `deviceId`, `filter`, `limit=20` | Notification items | Instant retrieval of incoming OTPs, 2FA codes, and status bar alerts. |
| **`get_clipboard`** | `deviceId` | `{kind, text}` | What the user last copied. Needs the phone unlocked; briefly brings an invisible Phone Remote screen forward. Only when the user refers to something they copied. |
| **`set_clipboard`** | `deviceId`, `text` | Copy status | Puts text on the phone's clipboard, ready to paste. Works in the background, no text box needed. Replaces the current clip. |
| **`set_volume`** | `deviceId`, `level` (0-100, optional), `stream` (`media`/`ring`/`alarm`, default `media`) | `media volume set to 33% (step 5 of 15)` | Sets the volume to an exact percent, or only reads it when `level` is left out. The reply is the real level, so never screenshot to check. |
| **`list_files`** | `deviceId`, `path`, `filter`, `sort` (`name`/`newest`/`largest`), `limit` (60), `offset` | Header + `name \| size \| modified` rows | Explore `/storage/emulated/0`. To find a file, use `filter` or `sort` instead of listing everything. If the reply says "N more", tell the user, and page with `offset` only when they want the whole folder. |
| **`get_file`** | `deviceId`, `path` | Download URL & metadata | Retrieve a file from phone shared storage to PC. |
| **`delete_file`** | `deviceId`, `path` | "Deleted … Verified gone." or an error | PERMANENTLY delete one file (no recycle bin; folders refused). Only for a file the user asked to delete, after any copy has reached the PC. |
| **`send_file`** | `deviceId`, `name`, `data_base64`, `folder` | Save confirmation | Send file (<= 18 MB) directly to phone Download directory. |
| **`send_local_file`**| `deviceId`, `name`, `folder` | Upload URL | Upload larger files (> 18 MB up to 100 MB) via streaming HTTP PUT. |
| **`send_url`** | `deviceId`, `url`, `name`, `folder` | Download status | Instructs phone companion service to download remote URL. |
| **`get_location`** | `deviceId` | GPS coordinates & accuracy | Real-time device latitude, longitude, and altitude. |

---

## 🚀 2. Deep Links & Intent URL Catalog (`open_url`)

`open_url` is the fastest method to navigate on Android. It dispatches an `ACTION_VIEW` intent directly to the Android OS, bypassing manual navigation menus entirely.

### 💬 Messaging & Social Deep Links

#### WhatsApp & WhatsApp Business
* **Direct Chat by Phone Number (with pre-filled message)**:
  `open_url(deviceId, url="https://wa.me/<phone_with_country_code>?text=<encoded_text>")`
  *Example*: `https://wa.me/919876543210?text=Hello%20Yash`
* **Direct Chat (Custom URL scheme)**:
  `open_url(deviceId, url="whatsapp://send?phone=<phone_with_country_code>&text=<encoded_text>")`
* **WhatsApp Settings**:
  `open_url(deviceId, url="whatsapp://settings")`

#### Telegram
* **Direct User or Channel Chat**:
  `open_url(deviceId, url="tg://resolve?domain=<username>")`
  *Example*: `tg://resolve?domain=telegram`
* **Direct User Chat by Phone**:
  `open_url(deviceId, url="https://t.me/+<phone_number>")`
* **Share Message / Link**:
  `open_url(deviceId, url="tg://msg?text=<text>&to=<username_or_phone>")`
* **Open Telegram Channel / Group Post**:
  `open_url(deviceId, url="https://t.me/<channel>/<post_id>")`

#### Instagram
* **Open User Profile**:
  `open_url(deviceId, url="instagram://user?username=<username>")`
* **Open Direct Message (DM)**:
  `open_url(deviceId, url="https://ig.me/m/<username>")`
* **Open Reel or Post**:
  `open_url(deviceId, url="https://www.instagram.com/p/<post_id>/")`

#### Twitter / X
* **Open User Profile**:
  `open_url(deviceId, url="twitter://user?screen_name=<username>")`
* **Compose Tweet**:
  `open_url(deviceId, url="twitter://post?message=<encoded_text>")`

---

### 🗺️ Navigation & Location Deep Links (Google Maps)

* **Direct Turn-by-Turn Navigation**:
  `open_url(deviceId, url="google.navigation:q=<destination_address_or_lat,lng>&mode=d")`
  *Example*: `google.navigation:q=Connaught+Place,+New+Delhi&mode=d` (modes: `d`=driving, `w`=walking, `b`=bicycling)
* **Search Nearby Places**:
  `open_url(deviceId, url="geo:0,0?q=<search_query>")`
  *Example*: `geo:0,0?q=Coffee+shops+near+me`
  *Example*: `geo:0,0?q=Hospitals`
* **Pin Exact GPS Location**:
  `open_url(deviceId, url="geo:<latitude>,<longitude>?z=16")`
  *Example*: `geo:28.6139,77.2090?z=17`

---

### 📞 Telephony, SMS & Email Deep Links

* **Open Dialer with Pre-filled Number**:
  `open_url(deviceId, url="tel:<phone_number>")`
  *Example*: `tel:+919876543210`
* **Compose SMS**:
  `open_url(deviceId, url="sms:<phone_number>?body=<encoded_text>")`
  *Example*: `sms:+919876543210?body=Here%20is%20the%20report`
* **Compose Email (Gmail / Default Mail Client)**:
  `open_url(deviceId, url="mailto:<email_address>?subject=<encoded_subject>&body=<encoded_body>")`
  *Example*: `mailto:manager@company.com?subject=Meeting%20Minutes&body=Please%20find%20attached`

---

### 🎥 Media & Streaming Deep Links

* **YouTube — Open Video Directly**:
  `open_url(deviceId, url="vnd.youtube:<video_id>")`
  *Example*: `vnd.youtube:dQw4w9WgXcQ`
* **YouTube — Search Query**:
  `open_url(deviceId, url="https://www.youtube.com/results?search_query=<query>")`
* **Spotify — Play Track / Artist / Playlist**:
  `open_url(deviceId, url="spotify:track:<track_id>")`
  `open_url(deviceId, url="spotify:artist:<artist_id>")`
  `open_url(deviceId, url="spotify:search:<search_query>")`

---

### ⚙️ Android System Settings Instant Jump Links

Never navigate manually through Settings menus. Jump directly to any Android system configuration screen:

| Setting Category | Intent Action URI (`open_url`) |
| :--- | :--- |
| **Main System Settings** | `android.settings.SETTINGS` |
| **Wi-Fi Settings** | `android.settings.WIFI_SETTINGS` |
| **Bluetooth Settings** | `android.settings.BLUETOOTH_SETTINGS` |
| **GPS / Location Services** | `android.settings.LOCATION_SOURCE_SETTINGS` |
| **Installed Applications List** | `android.settings.APPLICATION_SETTINGS` |
| **Specific App Info / Permissions** | `android.settings.APPLICATION_DETAILS_SETTINGS?package=<package_name>` |
| **Display / Brightness / Sleep** | `android.settings.DISPLAY_SETTINGS` |
| **Sound & Vibration** | `android.settings.SOUND_SETTINGS` |
| **Battery & Power Saver** | `android.settings.BATTERY_SAVER_SETTINGS` |
| **Storage & Memory** | `android.settings.INTERNAL_STORAGE_SETTINGS` |
| **Date & Time Settings** | `android.settings.DATE_SETTINGS` |
| **Accessibility Services** | `android.settings.ACCESSIBILITY_SETTINGS` |
| **Airplane Mode Settings** | `android.settings.AIRPLANE_MODE_SETTINGS` |
| **Security & Lock Screen** | `android.settings.SECURITY_SETTINGS` |
| **Developer Options** | `android.settings.APPLICATION_DEVELOPMENT_SETTINGS` |

---

### 🛒 App Stores & Browser Deep Links

* **Google Play Store App Page**:
  `open_url(deviceId, url="market://details?id=<package_name>")`
* **Google Play Store Search**:
  `open_url(deviceId, url="market://search?q=<query>")`
* **Default Web Browser (Chrome)**:
  `open_url(deviceId, url="https://<website_url>")`

---

## 📦 3. Android Application Package Registry (`open_app`)

To open an application directly, always use `open_app(deviceId, package="<package_id>")`. This requires 0 UI discovery steps.

### Communication & Messaging
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **WhatsApp** | `com.whatsapp` | Standard messaging |
| **WhatsApp Business** | `com.whatsapp.w4b` | Business messaging |
| **Telegram** | `org.telegram.messenger` | Cloud messaging |
| **Google Messages** | `com.google.android.apps.messaging` | SMS / RCS |
| **Phone Dialer** | `com.google.android.dialer` (or `com.android.dialer`) | Voice calls |
| **Gmail** | `com.google.android.gm` | Email |
| **Discord** | `com.discord` | Communities / Voice |
| **Slack** | `com.Slack` | Team chat |

### Google Ecosystem
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Google Chrome** | `com.android.chrome` | Web browsing |
| **Google Maps** | `com.google.android.apps.maps` | Navigation / Maps |
| **YouTube** | `com.google.android.youtube` | Video streaming |
| **Google Drive** | `com.google.android.apps.docs` | Cloud file management |
| **Google Photos** | `com.google.android.apps.photos` | Photo / Video library |
| **Google Play Store**| `com.android.vending` | App installer |
| **Files by Google** | `com.google.android.apps.nbu.files` | File manager |
| **Google Calendar** | `com.google.android.calendar` | Events & schedule |
| **Google Keep** | `com.google.android.keep` | Notes & checklists |
| **Calculator** | `com.google.android.calculator` | Math calculations |
| **Clock / Alarms** | `com.google.android.deskclock` | Timer / Alarm |
| **Contacts** | `com.google.android.contacts` | Address book |

### Social Media & Content
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Instagram** | `com.instagram.android` | Photos / Reels / Stories |
| **Twitter / X** | `com.twitter.android` | Microblogging / News |
| **LinkedIn** | `com.linkedin.android` | Professional network |
| **Reddit** | `com.reddit.frontpage` | Community forums |
| **Facebook** | `com.facebook.katana` | Social network |
| **Snapchat** | `com.snapchat.android` | Ephemeral media |
| **Pinterest** | `com.pinterest` | Visual discovery |

### Media & Entertainment
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Spotify** | `com.spotify.music` | Music & Podcasts |
| **YouTube Music** | `com.google.android.apps.youtube.music` | Music streaming |
| **Netflix** | `com.netflix.mediaclient` | Movies & Series |
| **Amazon Prime** | `com.amazon.avod.thirdpartyclient` | Video streaming |
| **JioCinema** | `com.jio.media.ondemand` | Video / Sports streaming |
| **Hotstar** | `in.startv.hotstar` | Video streaming |

### Finance & UPI Payments (India)
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Google Pay (GPay)**| `com.google.android.apps.nbu.paisa.user` | UPI payments |
| **PhonePe** | `com.phonepe.app` | UPI & Utility bills |
| **Paytm** | `net.one97.paytm` | Wallet & Payments |
| **BHIM** | `in.org.npci.upiapp` | Standard UPI |

### Shopping, Delivery & Travel
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Amazon Shopping**| `in.amazon.mShop.android.shopping` | E-commerce |
| **Flipkart** | `com.flipkart.android` | E-commerce |
| **Swiggy** | `in.swiggy.android` | Food & Instamart delivery |
| **Zomato** | `com.application.zomato` | Food delivery & Dining |
| **Blinkit** | `com.grofers.customerapp` | Quick commerce |
| **Zepto** | `com.zeptoconsumerapp` | 10-min groceries |
| **Uber** | `com.ubercab` | Ride hailing |
| **Ola** | `com.olacabs.customer` | Cabs & Auto |
| **MakeMyTrip** | `com.makemytrip` | Flights & Hotels |

### OEM & Device System Utilities (Realme / Oppo / Generic)
| App Name | Package Identifier | Direct Action |
| :--- | :--- | :--- |
| **Camera** | `com.android.camera` (or `com.oppo.camera`) | Photo capture |
| **Settings** | `com.android.settings` | Device configuration |
| **Gallery / Photos**| `com.coloros.gallery3d` (or `com.android.gallery3d`) | Device gallery |
| **My Files / File Manager**| `com.coloros.filemanager` | Stock file manager |

---

## 🗺️ 4. In-App Navigation Maps & MCP Fast Paths

### A. WhatsApp & WhatsApp Business Protocol

#### 1. Navigating to a Contact Chat
* **Method 1 (Instant Deep Link — Recommended)**:
  ```python
  open_url(deviceId, url="https://wa.me/<phone_number>")
  ```
* **Method 2 (In-App Search)**:
  1. Open app: `open_app(deviceId, package="com.whatsapp" or "com.whatsapp.w4b")`
  2. Tap top search bar: `tap(deviceId, x=0.74, y=0.065)`
  3. Inject text with paste: `type_text(deviceId, text="Contact Name", method="paste")`
  4. Wait for match: `wait_for(deviceId, text="Contact Name")`
  5. Tap contact row: `tap(deviceId, x=node.x, y=node.y)`

#### 2. Sending a Text Message
1. In chat, tap message field: `tap(deviceId, x=0.40, y=0.91)`
2. Inject message: `type_text(deviceId, text="Message content", method="paste")`
3. Tap Send button:
   - UI Node: `desc: "Send"`, `cls: "android.widget.ImageButton"` at `(x ≈ 0.93, y ≈ 0.91)`
   - Tap Send: `tap(deviceId, x=0.93, y=0.91)`
4. Confirm delivery: `wait_for(deviceId, text="Sent" or "Delivered")`

#### 3. Sending PC Files via WhatsApp (The Proven Document Workflow)
* **Rule**: Never click "Browse documents" because Android's system `com.google.android.documentsui` blocks synthetic accessibility clicks (`FLAG_FILTER_TOUCHES_WHEN_OBSCURED`). Always stay inside WhatsApp's native internal `Files` Activity.
* **Standard Execution Sequence**:
  1. Transfer file from PC to phone:
     `send_file(deviceId, name="file.png", data_base64="...", folder="Download")`
  2. In target chat, tap attachment paperclip:
     `tap(deviceId, x=0.619, y=0.91)` (`desc: "Attach"`)
  3. In attachment sheet, tap Document:
     `tap(deviceId, x=0.125, y=0.694)` (`desc: "Document"`)
  4. In WhatsApp's internal `Files` list, tap Search icon:
     `tap(deviceId, x=0.80, y=0.085)` (`desc: "Search"`)
  5. Paste search query:
     `type_text(deviceId, text="file", method="paste")`
  6. Tap filtered file row directly under `Recents`:
     `tap(deviceId, x=0.39, y=0.54)`
  7. In WhatsApp's Send confirmation preview, tap Send:
     `tap(deviceId, x=0.911, y=0.552)` (`desc: "Send"`)
  8. Verify sent message in chat with `get_ui_tree(deviceId, filter="file.png")`.

---

### B. Telegram Navigation Protocol

#### 1. Navigating to Chat
* **Instant Jump**: `open_url(deviceId, url="tg://resolve?domain=<username>")`
* **Fallback**: Open `org.telegram.messenger`, tap search (`x ≈ 0.92, y ≈ 0.05`), paste username, tap contact.

#### 2. Sending Files in Telegram
1. Inside chat, tap attachment paperclip: `(x ≈ 0.20, y ≈ 0.96)`.
2. Tap "File" icon.
3. Tap "Internal Storage" or "Downloads".
4. Select target file row.
5. Tap Send button.

---

### C. Phone Storage & Downloads Protocol

All internal storage is located under `/storage/emulated/0/`. The backend automatically aliases short names:
- `"Download"` $\rightarrow$ `/storage/emulated/0/Download`
- `"Documents"` $\rightarrow$ `/storage/emulated/0/Documents`
- `"DCIM/Camera"` $\rightarrow$ `/storage/emulated/0/DCIM/Camera`
- `"Pictures"` $\rightarrow$ `/storage/emulated/0/Pictures`

#### Fast Inspection & Retrieval
1. List files in folder:
   `list_files(deviceId, path="Download")`
2. Download phone file back to PC:
   `get_file(deviceId, path="Download/my_doc.pdf")`
   *Returns a temporary authenticated URL to download the file directly.*

---

## 🎯 5. Golden Rules for AI Agent Execution Speed

1. **Rule 1: MCP-Only Execution**: Always use the registered `phone-remote` MCP tools.
2. **Rule 2: Intent-First Navigation**: Always prefer `open_url` and `open_app` over manual taps and drawer searching.
3. **Rule 3: Tree Perception Over Vision**: Always prefer `get_ui_tree(filter=...)` over `take_screenshot`. Tree inspection takes ~50ms and provides mathematically exact normalized coordinates.
4. **Rule 4: Reactive Synchronization**: Always use `wait_for(text=...)` instead of static `wait(seconds=...)`.
5. **Rule 5: Strict Copy-Paste for Form Fields**: Always pass `method: "paste"` in `type_text` when targeting messaging apps or search bars to prevent text corruption.
6. **Rule 6: System Key Dismissals**: If an unexpected pop-up, keyboard, or overlay appears, dismiss it with `press_key(deviceId, key="back")`.
7. **Rule 7: Replace, Don't Clear**: To change text already in a box (a number, a word, a whole sentence), tap it and call `type_text(new, replace=true)`; if the app ignores it, add `method="paste"` (it selects all, then pastes over it). Don't clear with backspace first: some apps refill an empty box. Check the box with `get_ui_tree(filter="EditText")` before confirming. On an older phone app build without `replace`: `long_press` the text to select it, for a sentence also tap **Select all** (not in `get_ui_tree`; find it with one `take_screenshot`), then paste.

---
*Created for Phone Remote AI Autonomous Control. Document Version 1.0 — October 30, 2026.*
