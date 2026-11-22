# Phone Remote

**Give your AI agent a real Android phone.**

Phone Remote lets AI agents like Claude, Cursor, Codex and Antigravity see and
use your Android phone: read the screen, tap, type, open apps, read OTPs,
find your phone and move files between phone and computer. You can also watch
and control the phone yourself from a web dashboard, with live screen and
camera.

No root needed. Install the app once, and it keeps working in the background,
even with the app closed.

**Free and open source (MIT).** Use the hosted server, or run your own.

## Demo

One prompt to the agent, and it sets the phone's wallpaper on its own.
Laptop on the left, phone on the right:

> `C:\Users\hp\Desktop\phoneimg.jpg set this image as phone wallpaper for both homescreen and lockscreen`

https://github.com/user-attachments/assets/2f5ebf74-f221-4b2c-9a6e-888cfde5c90a

---

## Contents

- [What you can ask it](#what-you-can-ask-it)
- [Automate it: scheduled workflows and your own agents](#automate-it-scheduled-workflows-and-your-own-agents)
- [Features](#features)
- [Use it with your AI agent](#use-it-with-your-ai-agent)
- [The Android app](#the-android-app)
- [Works while the phone is locked?](#works-while-the-phone-is-locked)
- [Privacy and safety](#privacy-and-safety)

---

## What you can ask it

Talk to your agent in plain words. These all work today.

**Everyday**

- *"How's my phone? Battery, storage, anything wrong?"*
- *"Which app is draining my battery?"*
- *"Where is my phone?"* and then *"Make it ring."*
- *"Read my notifications and tell me what's important."*
- *"Did an OTP come in? Read it to me."*

**Clipboard between phone and AI**

Copy something on your phone and the AI can read it; ask the AI and it puts
text on your phone, ready to paste anywhere.

- *"I just copied a link on my phone, open it on my PC."*
- *"Summarise what I copied."* / *"Translate what I copied into Hindi."*
- *"Copy this address to my phone so I can paste it in Maps."*
- *"Put my Wi-Fi network name on my phone's clipboard."*

Reading needs the phone unlocked; for a split second Android shows Phone
Remote in front and may say it pasted from your clipboard. Setting works in
the background with nothing changing on screen. The AI only sees the item
you copied last, never a history, and reads it only when you ask.

**Files between phone and computer**

- *"List the PDFs in my Download folder."*
- *"Get me medical.pdf from my phone."*
- *"Put C:\Users\me\Desktop\photo.jpg on my phone."*
- *"Download this link straight to my phone."*
- *"Set this picture as my wallpaper."*

**Cleaning up**

- *"Find apps I haven't used in 3 months."*
- *"Which apps take the most storage?"*
- *"Clear the cache of this app."* (the agent asks before deleting anything)

**Using the phone for you**

- *"Open WhatsApp, find Mom, and type 'on my way', but don't send it."*
- *"Turn on dark mode."* / *"Turn on my hotspot."*
- *"Open YouTube and search for lo-fi music."*
- *"Take a screenshot and tell me what's on screen."*

**Chained tasks**

- **Morning check:** *"Check my battery, read my notifications, and tell me if any new file landed in Downloads."*
- **Phone to PC:** *"Find my latest screenshot on the phone and save it to my PC."*
- **Copied link to notes:** *"Read what I copied on my phone, summarise the page, and put the summary back on my phone's clipboard."*
- **Settings tour:** *"Open each settings page and tell me what's turned on."*
- **App report:** *"Open my battery usage and tell me the top 3 apps."*

---

## Automate it: scheduled workflows and your own agents

Because Phone Remote is a standard MCP server, anything that can use MCP tools
can use your phone. That means you can build **your own workflows and agents**
on top of it, and have them run **on a schedule** without you typing anything.

With **Claude's scheduled tasks** (`/schedule` in Claude Code, or scheduled
tasks in the Claude app), write a workflow once in plain words, pick a time,
and Claude runs it for you:

| Schedule | Workflow |
|---|---|
| Every morning, 8:00 | *"Check my phone's battery and storage, summarize overnight notifications, and list any OTPs or missed calls."* |
| Every night, 23:00 | *"If the battery is below 30%, remind me to charge it. Turn on Do Not Disturb."* |
| Every Sunday | *"Find apps I haven't opened in 60 days and list them with their size, so I can decide what to uninstall."* |
| Every Friday | *"Copy this week's new photos and PDFs from my phone to my PC."* |
| Every hour | *"Read my notifications. If anything mentions 'urgent' or comes from my boss, tell me right away."* |
| Once, at 18:00 | *"Ring my phone so I remember to leave."* |

You can also make **your own agents** that use the phone as one of their tools:

- **A personal assistant agent** that reads your messages and notifications and drafts replies for you to approve.
- **A phone health agent** that watches battery, storage and unused apps, and reports problems.
- **A file sync agent** that moves files between your phone and computer on its own.
- **An app tester agent** that opens your Android app, taps through its screens and reports what broke.

**Tip:** teach your agent your own recipes by editing the
[phone-remote skill](plugin/skills/phone-remote). It's plain Markdown:

```
## Good night
1. open_settings(page="do_not_disturb"), turn it on.
2. press_key("lock").
```

Then just say *"run my good night routine"*, or schedule it.

---

## Features

- **33 tools for AI agents.** Tap, swipe, type, read the screen, read or set what is copied, open apps and links, jump straight to 50 Android settings pages, read notifications and OTPs, find and clean up apps, ring and flashlight, location, and file transfer both ways.
- **Live screen and camera** in the browser, with touch control. Fast and smooth, up to 60 fps.
- **File manager** in the browser: browse the phone, drag and drop to upload, download.
- **Works anywhere.** Phone and computer don't need to be on the same Wi-Fi, and the stream keeps going when the phone switches from Wi-Fi to mobile data.
- **Runs in the background.** Close the app and everything keeps working.
- **Safe by default.** Agents only see the phones of the account that approved them, and risky actions (uninstall, clear data) are marked so your agent asks first.

---

## Use it with your AI agent

**Using Claude? The easy way:** install the app (step 1 below), download
[`phone-remote-plugin.zip`](https://github.com/GuptaOum/phone-remote/releases/latest/download/phone-remote-plugin.zip),
add it as a plugin in Claude, and sign in when the browser opens. That's it:
the plugin brings the MCP server and the skill together. In the Claude Code
terminal, run `/plugin marketplace add GuptaOum/phone-remote` and then
`/plugin install phone-remote@phone-remote` instead of using the zip. For any
other agent, follow the steps below.

Three steps, free:

1. **Get the app.** Install the Android app on your phone:
   `https://65-1-96-152.sslip.io/phone-remote.apk`. Create an account in the
   app and grant the permissions it lists.
2. **Add the MCP server to your agent** with the snippet for your tool below,
   using `https://65-1-96-152.sslip.io/mcp`.
3. **Sign in once.** On first use a browser window opens: sign in with the same
   account, check the **Signed in as** line, and click **Approve**. Then ask
   your agent things like *"take a screenshot of my phone"*.

No API key to copy: agents only need the URL.

### The skill (recommended for every agent)

The MCP server gives an agent the tools. The **`phone-remote` skill** in
[`plugin/skills/phone-remote`](plugin/skills/phone-remote) teaches it to use
them well: faster shortcuts, reading the screen instead of guessing, and safety
rules like asking before sending anything. One command installs it into
whichever agents you have:

```bash
npx skills add GuptaOum/phone-remote
```

### Make it yours

The skill is plain Markdown, so you can teach your agent how *your* phone works:

- **Your phone's apps** go in `references/deep-links.md`.
- **Your own recipes** go in `references/workflows.md`.
- **Your rules** go in `SKILL.md`, for example *"Never open my banking apps."*

Found a recipe that works on your brand (Samsung, Vivo, Xiaomi...)? Open a
pull request so other people can use it too.

### Connect the MCP server

**Claude Code:**

```
/plugin marketplace add GuptaOum/phone-remote
/plugin install phone-remote@phone-remote
```

Then run `/mcp`, pick `plugin:phone-remote:phone-remote` and choose
*Authenticate*.

**claude.ai, Claude Desktop, Claude mobile:** *Settings → Connectors → Add
custom connector*, URL `https://65-1-96-152.sslip.io/mcp`.

**OpenAI Codex:**

```bash
codex mcp add phone-remote --url https://65-1-96-152.sslip.io/mcp
codex mcp login phone-remote
```

**Google Antigravity:** add to `mcp_config.json`:

```json
{
  "mcpServers": {
    "phone-remote": { "serverUrl": "https://65-1-96-152.sslip.io/mcp" }
  }
}
```

**Cursor:** one click:
[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=phone-remote&config=eyJ1cmwiOiJodHRwczovLzY1LTEtOTYtMTUyLnNzbGlwLmlvL21jcCJ9)

**VS Code (Copilot agent mode):** `.vscode/mcp.json`:

```json
{
  "servers": {
    "phone-remote": { "type": "http", "url": "https://65-1-96-152.sslip.io/mcp" }
  }
}
```

**Any other MCP client:** point it at `https://65-1-96-152.sslip.io/mcp`.

---

## The Android app

Download [`phone-remote.apk`](https://65-1-96-152.sslip.io/phone-remote.apk),
install it, sign in, and grant:

| Permission | Used for |
|---|---|
| Screen capture (asked on first stream) | Screen mirroring |
| Accessibility service | Tapping, swiping, typing, reading the screen |
| Notification access | Reading notifications and OTPs |
| Camera, location, storage | Camera stream, location, files |
| Battery: unrestricted | Keeps it running in the background |

---

## Works while the phone is locked?

| Works when locked | Needs the phone unlocked |
|---|---|
| Files: list, download, upload | Tapping, swiping, typing |
| Reading notifications and OTPs | Opening apps and settings |
| Location, battery and status | Reading the screen, screenshots |
| Ring and flashlight | Live screen mirror |
| | Reading what you copied |

Nothing can get past your PIN or fingerprint.

---

## Privacy and safety

Your Phone Remote account can read your files, notifications and location,
even when the phone is locked. So:

1. Use a **strong, unique password** for your account.
2. Only connect AI tools you trust, and remove the ones you don't use.
3. Lost your phone or PC? **Remove the device** from the dashboard to cut it off immediately.

The skill tells agents to ask before sending messages or deleting anything. See the
[privacy policy](PRIVACY.md).

---

## For developers

Want to host your own server or see how it works inside? Architecture,
self-hosting, configuration and troubleshooting are in
[docs/TECHNICAL.md](docs/TECHNICAL.md).

## License

[MIT](LICENSE): free to use, modify and self-host.
