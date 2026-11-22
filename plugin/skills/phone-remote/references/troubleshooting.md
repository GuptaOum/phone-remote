# Troubleshooting

Start every diagnosis with `get_device_status`.

| Symptom | Likely cause | Fix |
|---|---|---|
| `list_devices` shows `online:false` | App killed, phone off, or no network | Ask the user to open Phone Remote on the phone. Nothing else will work until it's online. |
| Taps/typing report success but nothing happens | Screen off or locked, or Accessibility service off | `get_device_status`. Screen locked → ask the user to unlock (never type their PIN). Accessibility off → `open_settings(page:"accessibility")` and ask them to re-enable Phone Remote. |
| `get_ui_tree` returns almost nothing | Screen is a game/video/canvas, or a secure window | Use `take_screenshot` and tap by estimated position. Retry once with `all:true` before giving up on the tree. |
| Tree is from the wrong app | Something popped over the target (dialog, keyboard, update prompt) | `get_foreground_app`; dismiss with `press_key("back")`, then re-read. |
| Text typed but field still empty | App ignores the direct-set method | Retry `type_text` with `method:"paste"`. |
| Pasted text added to the old text instead of replacing it (or a number jumped to the app's maximum) | `paste` inserts at the cursor; the box wasn't empty | `long_press` the text to select it (for a sentence, then tap Select all, found by screenshot), paste again, and read the box with `get_ui_tree`. See workflows.md "Replace the text in a box". |
| Taps ignored only in a file/document picker | System picker (`com.google.android.documentsui`) filters synthetic touches | Use the app's own in-app file list (WhatsApp → Document → its Search), or `open_file` for viewing. Ask the user to tap if there's no alternative. |
| `open_app(name)` opens the wrong app | Partial name matched something else | `list_apps(filter=name)` and pass the exact `package`. |
| Deep link opens browser instead of app | App not installed or link not claimed | `list_apps` to check it's installed; fall back to `open_app` + in-app navigation. |
| `wait_for` times out | Label differs from what you expected | `get_ui_tree` with no filter once to see the real labels, then retry with the right text. |
| `read_notifications` errors | Notification access not granted | `open_settings(page:"notifications")`; the user enables Phone Remote under Device & app notifications. |
| `clear_app_storage` stops midway | Vendor popup or button label differs (realme/ColorOS, MIUI) | Read the tree, finish the last step by hand (tap Clear / OK), re-run to see the new size. |
| A tap on a button the tree shows does nothing | A popup, tip or banner covers it (common on web pages like Google My Activity; the tree may not include the overlay) | One `take_screenshot` to see what's on top, dismiss it (its Dismiss/close button, or `press_key("back")`), then continue with `get_ui_tree`. |
| Tree coordinates have x above 1.0 | The page is still sliding in | Re-read the tree a moment later before tapping. |
| `take_screenshot` errors "too soon" | Capture is throttled | Use `get_ui_tree` instead, or wait ~1 s. |

## Rules of thumb

- Two failed attempts at the same tap → stop and look (`get_ui_tree` without
  filter, or one screenshot). Don't keep hammering coordinates.
- Screenshots are for diagnosing, not for every step: after one screenshot,
  go back to `get_ui_tree`.
- Never loop more than ~8 scrolls hunting for something; ask the user.
- If the phone shows a permission prompt you didn't expect, tell the user what
  it asks for instead of tapping Allow on your own.
