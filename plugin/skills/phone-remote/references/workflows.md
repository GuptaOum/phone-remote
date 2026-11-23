# Recipes

Each recipe assumes you already have `deviceId` from `list_devices`.
Coordinates shown are typical for a 1080x2412 phone; always prefer the x/y that
`get_ui_tree` returns over the numbers here.

## Open a folder or file

```
open_file(path="Download")                 # folder → system Files app
open_file(path="DCIM/Camera/IMG_1.jpg")    # file → its default viewer
open_file(path="...jpg", package="<gallery package>")   # force an app
```
The gallery package differs by brand: find it with `list_apps(filter="gallery")`
(see the table in [deep-links.md](deep-links.md)).

## Set a PC image as wallpaper

1. `send_local_file(name="wall.jpg", folder="Pictures")`, then POST the bytes
   to the returned `upload_url`.
2. `open_file(path="Pictures/wall.jpg", package="<gallery package>")`.
3. Open the gallery's menu (More / ⋮), `get_ui_tree(filter:"wallpaper")`, tap
   it. Some galleries call it "Set as" or "Use as" → Wallpaper.
4. Tap Apply if shown, then pick Home, Lock, or both
   (`get_ui_tree(filter:"lock")`).
5. `press_key("home", screenshot:true)` to confirm.
Use `list_files(path=...)` first if you don't know the exact name. To just
tell the user what's in a folder, `list_files` alone is enough; no need to open
anything on screen.

## Send a WhatsApp message

1. `open_url("https://wa.me/<countrycode><number>?text=<url-encoded text>")`
   (no `+`, no spaces). For a saved contact with no number: `open_app("WhatsApp")`,
   tap the search icon, `type_text(name, method:"paste")`, `wait_for(text=name)`,
   tap the row.
2. `wait_for(app="com.whatsapp")`, then `get_ui_tree(filter:"send")`.
3. If you didn't pre-fill text: tap the message box (`filter:"message"`),
   `type_text(text, method:"paste")`.
4. Confirm with the user if the wording or recipient came from you, then tap
   Send (`desc:"Send"`).
5. `get_ui_tree(filter:"<first words of message>")` to confirm it's in the chat.

Same pattern for WhatsApp Business (`com.whatsapp.w4b`), SMS (`sms:` link) and
email (`mailto:` link). Never send without the user's go-ahead.

**Several messages to the same chat (cheap path).** Do steps 1-2 once, and
read the message box and Send positions once with
`get_ui_tree(filter:"Message")` and `filter:"send"`. For each further
message, with the chat still open and the keyboard up, reuse those
coordinates: tap the box, `type_text(text, method:"paste")`, tap Send, then
one `get_ui_tree(filter:"<first words>")` to confirm. That is 4 calls per
message instead of 6, and never read the whole chat (a full tree returns
every message on screen). Read positions again only if the keyboard closed
or the app changed. When the user gives the text as "<text> to <name>", the
text is what to send.

## Send a file from the PC to someone on WhatsApp

1. Put the file on the phone: `send_local_file(name, folder:"Download")` →
   send the file's raw bytes in an HTTP POST to the returned `upload_url`
   (any HTTP client works; the link is single-use and expires in 10 minutes).
   Small files can go inline with `send_file(data_base64=...)` (≤ 18 MB).
2. Open the chat (recipe above).
3. Tap Attach (`desc:"Attach"`) → Document.
4. Stay inside WhatsApp's own file list. Tap its Search icon,
   `type_text(<part of file name>, method:"paste")`, tap the matching row.
   **Do not tap "Browse other docs"**: that opens the system picker
   (`com.google.android.documentsui`), which ignores automated taps.
5. Tap Send on the preview, then confirm the file name appears in the chat.

For photos use Attach → Gallery instead of Document.

## Get a file from the phone to the PC

1. Find the file: `list_files(path="Download", filter:"<part of the name>")`,
   or `sort:"newest"` for something just downloaded (also `DCIM/Camera`,
   `Pictures/Screenshots`, `Documents`, `WhatsApp/Media/...` under
   `Android/media/com.whatsapp/`). Its full path is the folder + `/` + name.
2. `get_file(path="/storage/emulated/0/...")` → one-time `download_url`.
3. Save the `download_url` response to the local path with any HTTP client
   (it is a plain file download, nothing to run). Without one,
   give the user the link. Max 100 MB.

## Delete a file on the phone

"Move these videos to my PC, then delete them from the phone":
1. `list_files(path, sort:"newest")` to get the exact names, then `get_file`
   for each and save it on the PC. Check the saved size matches `bytes`.
2. Only then `delete_file(path)` for each. It lists the folder again and says
   "Verified gone". It is permanent, so delete only the files the user named.
3. A WhatsApp media file stays in the chat as "Download"; mention it.

## List or find files

"What's in my Download folder", "find the PDF I downloaded yesterday":
1. Searching for one file: `list_files(path, filter:"<word>")`, or
   `sort:"newest"` / `sort:"largest"` with a small `limit`. Cheaper and
   faster than listing the whole folder.
2. Listing a folder: `list_files(path)` shows the first 60 entries. If it
   says "(N more ...)", tell the user how many there are in total and offer
   the rest; fetch more with `offset:60`, `offset:120`... only if they want
   everything.
3. For a big folder, summarise (counts by type, newest few, largest few)
   rather than pasting every row.

## Download something from the web onto the phone

`send_url(url, name?, folder?)`. The server fetches it, so it works even if the
phone has no browser session. Then `open_file` if the user wants to see it.

## Read an OTP / 2FA code

1. `read_notifications(filter:"code")` or filter by app name / sender.
2. If nothing yet, `wait(seconds:5)` and retry a couple of times.
3. If it errors about permission, the user must grant Notification access once:
   `open_settings(page:"notifications")` and tell them which toggle.
Report the code only to the user, or type it only where the user asked.

## Use what the user copied on the phone

"I copied a link, open it on my PC", "summarise what I copied", "save this
address":
1. `get_clipboard`. It returns `{kind, text}` (`kind` is `text` or `uri`).
   The phone must be unlocked; Android may briefly show "Phone Remote pasted
   from your clipboard", which is expected.
2. Act on the text: open the link (`open_url` on the phone, or use it on the
   PC), summarise it, or paste it where the user wants (`type_text`).
The clipboard can hold passwords or codes: read it only when asked and don't
repeat secrets back unless the user wants them.

## Make text ready to paste on the phone

"Copy this to my phone", "put this address on my phone's clipboard":
1. `set_clipboard(text)`. It works in the background, even with no text box
   open, and leaves the screen as it is.
2. Tell the user it's ready to paste (long-press any text box → Paste).
It replaces what was on the clipboard. To fill one specific field instead,
tap it and use `type_text`.

## Change a setting

`open_settings(page=...)` with one of:
- Apps: settings, apps, all_apps, installed_apps, default_apps, home_app,
  app_info*, app_notifications*, overlay*, install_unknown_apps*,
  modify_system_settings*, all_files_access*, alarms_reminders*,
  open_by_default*, app_language*
- Battery: battery (usage by app), battery_saver, battery_optimization
- Notifications & permissions: notifications, do_not_disturb,
  notification_access, usage_access, accessibility, security, privacy,
  location, accounts
- Connections: wifi, bluetooth, mobile_data, data_usage, network_operator,
  airplane_mode, hotspot, vpn, nfc, cast, connected_devices
- Display & sound: display, dark_mode, night_light, sound
- System: storage, date_time, language, keyboard, captions, print,
  developer, about_phone

(*needs `package`.) A page the phone lacks opens main Settings instead
(the reply says `fallback`); then tap through from there.
Then `get_ui_tree(filter:"<toggle label>")`, tap the switch, and re-read the
tree to confirm the `K` (checked) flag flipped.

## Free up storage

1. `find_unused_apps(days:30, minSizeMB:100)`: biggest unused apps first.
   Or `list_apps(sizes:true, minSizeMB:200, system:false)` for the biggest
   user-installed apps.
2. Show the user the list with sizes and last-used dates. Let them choose.
3. For chosen apps:
   - `clear_app_storage(package, what:"cache")`: safe, no confirmation needed
     beyond the user's request.
   - `clear_app_storage(package, what:"data")`: logs them out and wipes the
     app's data. Confirm per app.
   - `uninstall_app(package)`: permanent. Confirm per app.
4. Report before/after sizes from the tool results.

## Find a lost phone

`ring` (full volume, works in silent mode), `flash_light(count:10)`,
`get_location` (last cached fix, may be minutes old; give the user a
`https://maps.google.com/?q=<lat>,<lng>` link).

## Set the volume to a level

`set_volume(level: N)` sets media volume to N percent (0 mutes) and replies
with the level it really ended on, e.g. "media volume set to 33% (step 5 of
15)". `set_volume()` with no level just reads it. Never screenshot to check:
Android's slider shows for a moment and is gone, so the reply is the only
reading. "Raise by 30%" means read first, then set current + 30.
`stream:"ring"` or `"alarm"` change those instead (ring can be refused under
Do Not Disturb).

Fallback for a phone app too old to have `set_volume` (the tool says so):
`press_key("volume_up" | "volume_down")` moves one step per call and has no
repeat option, and the level can't be read back. So always start from zero:
1. Send 16 `press_key("volume_down")` calls in one parallel batch (media volume
   has 15 steps, so this reaches 0 from anywhere).
2. Send `round(0.15 * N)` `press_key("volume_up")` calls in one parallel batch
   (30% is 5, 50% is 8, 100% is 15).
3. No screenshot. Say the level is approximate.

## Search inside any app

Tap the search icon (`get_ui_tree(filter:"search")`), `type_text(query,
submit:true)`, `wait_for(text=<expected result>)`. Many apps also accept a
search deep link (YouTube, Play Store, Maps); see deep-links.md.

## Replace the text in a box

"Change the amount to 500", "set the frequency to 12345", "rewrite this
message": the box already holds text, and `type_text` normally inserts at
the cursor, so the old text stays.

**Use `replace:true`** (one call, works for words, numbers and sentences):
1. Tap the box.
2. `type_text(new text, replace:true)`. If the box doesn't change (the app
   ignores direct text), `type_text(new text, method:"paste", replace:true)`:
   it selects all the text and pastes over it.
3. `get_ui_tree(filter:"EditText")`: the box must read exactly the new text.
   Confirm (✓, Done, Save) if the app needs it, and read it again.

**Fallback for older phone app builds** (type_text says it can't replace):
1. Tap the box, then `long_press` on its text. This selects one word (or the
   whole number).
2. One word or number: go to step 4.
3. A sentence or several words: tap **Select all** in the Cut / Copy / Paste /
   Select all menu. It is a floating window that `get_ui_tree` doesn't
   include, so `take_screenshot` once to find it (usually top right, just
   above the text).
4. `type_text(new text, method:"paste")`. The paste replaces the selection.
5. `get_ui_tree(filter:"EditText")`: the box must read exactly the new text.
   Then confirm (✓, Done, Save) if the app needs it, and read it again.
Tested on the phone: a number in Frequency Generator (4 calls, no screenshot)
and a full sentence in Google Translate.
Avoid clearing with backspace and then pasting: some apps put a default back
into an empty box (Frequency Generator adds "1"), and the paste then joins it.

## Read a whole list

"List every song in my playlist", "all my contacts", "every result":
1. Open the list (`open_app`, `open_url`, then `wait_for` something in it).
2. `collect_list(deviceId)`. It scrolls to the top, goes to the end, and
   returns one numbered row per item (a row's texts joined with ` | `).
3. Read the header it prints: whether the end was reached and which labels
   it removed. One call stops after about 45 seconds so the result reaches
   you in time; if the end was not reached, call
   `collect_list(deviceId, fromTop:false)` to read the rest, and repeat until
   it says "Reached the end of the list". A 200-row list started from the
   bottom takes two calls.
4. Join the calls' rows and drop duplicates yourself: a few rows repeat where
   two screens did not line up and at the seam between calls. That is
   expected; don't re-run to get a perfect list. Only if rows look missing,
   call again with `amount:0.3`.
5. Present or save the rows (a table, a CSV file). The count shown by the
   app (e.g. "193 tracks") can be a little higher than the rows you get when
   the app hides unavailable items.
On a feed that refreshes when you pull down (YouTube Home), pass
`fromTop:false` so it doesn't reload.

## Scroll to find something

`get_ui_tree(filter=X)`; if empty, `scroll(direction:"down")` and repeat.
Stop after ~8 scrolls or when two consecutive trees are identical (end of list).
To find an item in a very long list, `collect_list` and search the rows.
