# Deep links and package names

Use with `open_url(url)`. URL-encode text (`%20` for space). Phone numbers
include the country code, digits only (`919876543210`). If a link opens the
browser instead of the app, the app isn't installed; check `list_apps`.

For Settings pages use `open_settings(page)` instead of `android.settings.*`
URLs, and for files/folders use `open_file(path)`.

## Messaging and social

| Goal | Link |
|---|---|
| WhatsApp chat (+ draft) | `https://wa.me/<number>?text=<text>` |
| Telegram user/channel | `tg://resolve?domain=<username>` |
| Telegram post | `https://t.me/<channel>/<post_id>` |
| Instagram profile | `instagram://user?username=<username>` |
| Instagram DM | `https://ig.me/m/<username>` |
| X profile | `twitter://user?screen_name=<username>` |
| X compose | `twitter://post?message=<text>` |

## Phone, SMS, email

| Goal | Link |
|---|---|
| Dialer pre-filled (doesn't call) | `tel:+<number>` |
| SMS draft | `sms:+<number>?body=<text>` |
| Email draft | `mailto:<addr>?subject=<s>&body=<b>` |

## Maps

| Goal | Link |
|---|---|
| Turn-by-turn navigation | `google.navigation:q=<place or lat,lng>&mode=d` (d drive, w walk, b bike) |
| Search places | `geo:0,0?q=<query>` |
| Drop a pin | `geo:<lat>,<lng>?z=16` |

## Media and stores

| Goal | Link |
|---|---|
| YouTube video | `vnd.youtube:<video_id>` |
| YouTube search | `https://www.youtube.com/results?search_query=<q>` |
| Spotify search | `spotify:search:<q>` |
| Spotify track | `spotify:track:<id>` |
| Play Store app page | `market://details?id=<package>` |
| Play Store search | `market://search?q=<q>` |
| Any website | `https://...` |

## Common packages

When `open_app(name)` is ambiguous, use the package. Confirm with
`list_apps(filter=...)` if unsure; OEMs rename things.

| App | Package |
|---|---|
| WhatsApp / Business | `com.whatsapp` / `com.whatsapp.w4b` |
| Telegram | `org.telegram.messenger` |
| Google Messages | `com.google.android.apps.messaging` |
| Gmail | `com.google.android.gm` |
| Chrome | `com.android.chrome` |
| Maps | `com.google.android.apps.maps` |
| YouTube / YT Music | `com.google.android.youtube` / `com.google.android.apps.youtube.music` |
| Google Photos | `com.google.android.apps.photos` |
| Play Store | `com.android.vending` |
| Files by Google | `com.google.android.apps.nbu.files` |
| Calendar / Keep / Clock | `com.google.android.calendar` / `com.google.android.keep` / `com.google.android.deskclock` |
| Instagram / X / LinkedIn | `com.instagram.android` / `com.twitter.android` / `com.linkedin.android` |
| Spotify / Netflix | `com.spotify.music` / `com.netflix.mediaclient` |
| GPay / PhonePe / Paytm | `com.google.android.apps.nbu.paisa.user` / `com.phonepe.app` / `net.one97.paytm` |
| Amazon / Flipkart | `in.amazon.mShop.android.shopping` / `com.flipkart.android` |
| Swiggy / Zomato / Blinkit / Zepto | `in.swiggy.android` / `com.application.zomato` / `com.grofers.customerapp` / `com.zeptoconsumerapp` |
| Uber / Ola | `com.ubercab` / `com.olacabs.customer` |
| realme/ColorOS Gallery / Files / Camera | `com.coloros.gallery3d` / `com.coloros.filemanager` / `com.oppo.camera` |
| Settings | `com.android.settings` |

Payment apps: you may open them and navigate, but never enter a UPI PIN or
approve a payment. The user does that.
