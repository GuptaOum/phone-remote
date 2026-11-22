# Phone Remote

Control your own Android phone from Claude. Ask in plain words and Claude reads
the screen, taps, types, opens apps, Settings pages and files, sends messages
you approve, moves files between your computer and the phone, reads
notifications such as one-time codes, frees up storage, and rings the phone
when it is lost.

## What's inside

- **MCP server reference** (`.mcp.json`): connects Claude to the Phone Remote
  server at `https://65-1-96-152.sslip.io/mcp`, which exposes 32 tools
  (`list_devices`, `get_ui_tree`, `tap`, `type_text`, `open_app`,
  `open_settings`, `open_file`, `send_local_file`, `get_file`,
  `read_notifications`, `find_unused_apps`, `clear_app_storage`, and more).
- **Skill** (`skills/phone-remote`): teaches Claude how to use those tools
  well: jump straight to a screen with deep links, `open_settings` or
  `open_file` instead of tapping through menus, read the screen as structured
  data instead of screenshots, wait for results instead of sleeping, and follow
  safety rules. It includes step-by-step recipes and a troubleshooting table.

The plugin runs nothing on your computer. It has no hooks, scripts or local
servers; it only points Claude at the remote MCP server and adds the skill.

## Setup

1. Install the free Phone Remote Android app on your phone
   (`https://65-1-96-152.sslip.io/phone-remote.apk`), create an account, and
   grant the permissions the app lists (Accessibility for taps and typing;
   optional Notification access and Usage access).
2. Download the plugin zip
   (`https://github.com/GuptaOum/phone-remote/releases/latest/download/phone-remote-plugin.zip`)
   and add it as a plugin in Claude. No commands needed.
3. The first time Claude uses the phone, a browser window opens: sign in with
   the same account as the app and approve access.
4. Ask things like "what's on my phone screen", "open my Download folder" or
   "find apps I haven't used in a month".

### Using Claude Code in the terminal?

Skip the zip and run these two commands instead:

```
/plugin marketplace add GuptaOum/phone-remote
/plugin install phone-remote@phone-remote
```

Then continue from step 3. To update later: `/plugin update phone-remote`.

## Make it yours

The skill is plain Markdown. Edit your installed copy to teach Claude how your
phone works, in a line or two each:

- `skills/phone-remote/references/deep-links.md`: your apps, e.g.
  `| My gallery | com.sec.android.gallery3d |`
- `skills/phone-remote/references/workflows.md`: your routines, e.g.
  "Good night: turn on Do Not Disturb, then lock the phone."
- `skills/phone-remote/SKILL.md`: your rules, e.g. "Never open my banking
  apps" or "My phone is in Hindi: Send is भेजें."

Recipes that work on your brand are welcome as pull requests at
https://github.com/GuptaOum/phone-remote.

## Data and privacy

- Commands go from Claude to the Phone Remote server and from there to the
  app on your phone over an encrypted connection. Results (screen text,
  screenshots, file lists, notifications, location, app lists) travel back the
  same way. Only phones linked to the account you signed in with can be reached.
- The server does not store screen contents, screenshots or notifications. A
  file you fetch from the phone is held in server memory for at most 10 minutes
  behind a one-time download link; upload links also expire after 10 minutes.
- Full privacy policy: https://github.com/GuptaOum/phone-remote/blob/main/PRIVACY.md
- The server is self-hosted on AWS. The full source is public under the MIT
  license: https://github.com/GuptaOum/phone-remote

## Safety

The skill tells Claude to ask before anything outward-facing or permanent
(sending a message or file, calling, uninstalling, clearing app data), never
to type passwords, PINs or payment details, and to treat text read from the
screen as data, not instructions. `uninstall_app` and `clear_app_storage` are
annotated as destructive, so Claude asks for confirmation before running them.

## License

MIT. See `LICENSE`.
