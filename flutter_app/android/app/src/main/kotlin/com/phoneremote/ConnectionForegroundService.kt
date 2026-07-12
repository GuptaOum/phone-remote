package com.phoneremote

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ConnectionForegroundService : Service() {

    companion object {
        var instance: ConnectionForegroundService? = null
        var onMessage: ((String) -> Unit)? = null
        const val NOTIF_ID = 3
        const val NOTIF_ID_PROMPT = 4
        const val CHANNEL_ID = "connection"
        const val PREFS_NAME = "PhoneRemotePrefs"
        const val ACTION_STOP = "com.phoneremote.STOP_SERVICE"
        const val ACTION_REQUEST_PROJECTION = "com.phoneremote.REQUEST_PROJECTION"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var client: OkHttpClient? = null
    private var ws: WebSocket? = null
    private val uploads = mutableMapOf<String, MutableList<Byte>>()
    private val uploadPaths = mutableMapOf<String, String>()
    private val cancelledDownloads = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    private var _cameraFront = true
    private var locationManager: LocationManager? = null
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            val json = JSONObject().apply {
                put("type", "location")
                put("lat", loc.latitude)
                put("lng", loc.longitude)
                put("accuracy", loc.accuracy)
                put("altitude", loc.altitude)
                if (loc.hasSpeed()) put("speed", loc.speed)
                put("timestamp", System.currentTimeMillis())
            }
            send(json.toString())
        }
        @Deprecated("Deprecated in API level 29")
        override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
    }

    var serverUrl = ""
        private set
    private var token = ""
    private var deviceId = ""
    private var screenW = 0
    private var screenH = 0
    private var model = "Android"
    private var authFailed = false

    private var lastCameraFrameMs = 0L
    private var reconnectDelay = 1L
    private var reconnectRunnable: Runnable? = null
    var isAlive = false
        private set

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(3, TimeUnit.SECONDS)
            .build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            prefs.edit().remove("url").remove("token").apply()
            onMessage?.invoke("""{"type":"_service_stopped"}""")
            stopService(Intent(this, CameraForegroundService::class.java))
            // ScreenCaptureService intentionally left running — MediaProjection token reused on next connect
            stopSelf()
            return START_NOT_STICKY
        }

        val url    = intent?.getStringExtra("url")    ?: prefs.getString("url", "") ?: ""
        val status = intent?.getStringExtra("status") ?: "Connecting..."
        model    = intent?.getStringExtra("model") ?: prefs.getString("model", "Android") ?: "Android"
        token    = intent?.getStringExtra("token")?.ifEmpty { null } ?: prefs.getString("token", "") ?: ""
        deviceId = intent?.getStringExtra("deviceId")?.ifEmpty { null } ?: prefs.getString("deviceId", "") ?: ""
        authFailed = false

        // Always use real display dimensions from WindowManager.
        // Flutter's physicalSize excludes the navigation bar (~132 px on this device),
        // which would make the bottom of the screen unreachable for touch input.
        val wm = getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            val bounds = wm.currentWindowMetrics.bounds
            screenW = bounds.width()
            screenH = bounds.height()
        } else {
            val realSize = android.graphics.Point()
            @Suppress("DEPRECATION")
            wm.defaultDisplay.getRealSize(realSize)
            screenW = realSize.x
            screenH = realSize.y
        }

        if (url.isNotEmpty()) {
            prefs.edit()
                .putString("url", url)
                .putString("token", token)
                .putString("deviceId", deviceId)
                .putInt("screenW", screenW)
                .putInt("screenH", screenH)
                .putString("model", model)
                .apply()
        }

        showForeground(status, url)

        if (url.isNotEmpty()) {
            if (url != serverUrl || !isAlive) {
                serverUrl = url
                doConnect()
            }
        }

        return START_STICKY
    }

    // ── WebSocket ─────────────────────────────────────────────────────────────

    private fun doConnect() {
        cancelReconnect()
        ws?.close(1000, "reconnecting")
        ws = null
        if (serverUrl.isEmpty()) return

        val wsUrl = serverUrl.replaceFirst(Regex("^http"), "ws")
        val req = Request.Builder()
            .url(wsUrl)
            .addHeader("ngrok-skip-browser-warning", "1")
            .build()

        ws = client?.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                handler.post {
                    reconnectDelay = 1
                    val auth = JSONObject().apply {
                        put("type", "auth")
                        put("token", token)
                    }
                    webSocket.send(auth.toString())
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handler.post {
                    try {
                        val json = JSONObject(text)
                        when (json.optString("type")) {
                            "auth_ok" -> {
                                isAlive = true
                                updateNotification("Connected", serverUrl)
                                val reg = JSONObject().apply {
                                    put("type", "register")
                                    put("role", "phone")
                                    put("deviceId", deviceId)
                                    put("deviceName", model)
                                    put("screenW", screenW)
                                    put("screenH", screenH)
                                    put("model", model)
                                }
                                webSocket.send(reg.toString())
                                startLocationUpdates()
                            }
                            "auth_error" -> {
                                handleAuthFailure("Login expired — open the app to sign in")
                                return@post
                            }
                            "device_removed" -> {
                                handleAuthFailure(
                                    json.optString("reason").ifBlank { "Device removed from dashboard" }
                                )
                                return@post
                            }
                            "control" -> {
                                // Handle directly in Kotlin — works even when Flutter is dead
                                handleControl(json)
                                return@post
                            }
                            "pf_list", "pf_download", "pf_delete",
                            "pf_upload_start", "pf_upload_chunk" -> {
                                handlePhoneFiles(json)
                                return@post
                            }
                            "pf_download_cancel" -> {
                                cancelledDownloads.add(json.optString("id"))
                                return@post
                            }
                            "camera_start", "camera_stop", "camera_flip" -> {
                                handleCamera(json)
                                return@post
                            }
                            "stream_start", "stream_stop" -> {
                                handleScreenCapture(json)
                                return@post
                            }
                            "screenshot" -> {
                                handleScreenshot()
                                return@post
                            }
                            "ring" -> {
                                handleRing()
                                return@post
                            }
                            "flash" -> {
                                handleFlash(json.optInt("count", 3))
                                return@post
                            }
                            "open_app" -> {
                                handleOpenApp(json)
                                return@post
                            }
                        }
                        onMessage?.invoke(text)
                    } catch (_: Exception) {}
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                handler.post { onLost() }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (code == 4001) {
                    if (authFailed) return
                    handler.post { handleAuthFailure(reason.ifEmpty { "Device removed" }) }
                    return
                }
                if (code != 1000) handler.post { onLost() }
            }
        })
    }

    private fun handleAuthFailure(message: String) {
        authFailed = true
        isAlive = false
        cancelReconnect()
        stopLocationUpdates()
        prefs.edit().remove("url").remove("token").remove("deviceId").apply()
        updateNotification(message, serverUrl)
        onMessage?.invoke("""{"type":"_auth_error"}""")
        try {
            stopService(Intent(this, CameraForegroundService::class.java))
        } catch (_: Exception) {}
        stopSelf()
    }

    private fun onLost() {
        val was = isAlive
        isAlive = false
        if (authFailed) return  // token rejected — don't reconnect until re-login
        if (was) {
            updateNotification("Reconnecting...", serverUrl)
            onMessage?.invoke("""{"type":"_disconnected"}""")
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        reconnectRunnable = Runnable {
            reconnectDelay = (reconnectDelay * 2).coerceAtMost(3)
            doConnect()
        }
        handler.postDelayed(reconnectRunnable!!, reconnectDelay * 1000)
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { handler.removeCallbacks(it) }
        reconnectRunnable = null
    }

    fun send(json: String) {
        ws?.send(json)
    }

    private fun sendBinary(bytes: ByteString) {
        ws?.send(bytes)
    }

    private fun sendScreenFrame(jpegBytes: ByteArray) {
        if ((ws?.queueSize() ?: 1L) > 0L) return
        val payload = ByteArray(jpegBytes.size + 1)
        payload[0] = 0x01
        jpegBytes.copyInto(payload, destinationOffset = 1)
        sendBinary(ByteString.of(*payload))
    }

    // Called by MainActivity after the user grants screen recording permission,
    // and by handleScreenCapture when a projection token already exists.
    fun startScreenStreaming() {
        val svc = ScreenCaptureService.instance ?: return
        if (!svc.hasProjection()) return
        svc.restart { jpegBytes -> sendScreenFrame(jpegBytes) }
        send("""{"type":"stream_started"}""")
        onMessage?.invoke("""{"type":"_screen_started"}""")
        // Restore the main notification back to normal "Connected" state
        updateNotification("Connected", serverUrl)
        // Dismiss the separate prompt notification if it was shown
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIF_ID_PROMPT)
    }

    private fun startLocationUpdates() {
        if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        val lm = locationManager ?: return
        // Send last known location immediately
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        providers.mapNotNull { lm.getLastKnownLocation(it) }
            .maxByOrNull { it.accuracy }
            ?.let { locationListener.onLocationChanged(it) }
        // Request live updates: every 15s or 10m movement
        for (provider in providers) {
            try { lm.requestLocationUpdates(provider, 15_000L, 10f, locationListener) } catch (_: Exception) {}
        }
    }

    private fun stopLocationUpdates() {
        try { locationManager?.removeUpdates(locationListener) } catch (_: Exception) {}
        locationManager = null
    }

    private fun handleControl(json: JSONObject) {
        val svc = RemoteAccessibilityService.instance ?: return
        val w = screenW.toFloat().takeIf { it > 0 } ?: return
        val h = screenH.toFloat().takeIf { it > 0 } ?: return
        try {
            when (json.optString("action")) {
                "tap"      -> svc.tap(
                    (json.getDouble("x") * w).toFloat(),
                    (json.getDouble("y") * h).toFloat()
                )
                "swipe"    -> svc.swipe(
                    (json.getDouble("x1") * w).toFloat(),
                    (json.getDouble("y1") * h).toFloat(),
                    (json.getDouble("x2") * w).toFloat(),
                    (json.getDouble("y2") * h).toFloat(),
                    json.optInt("ms", 300).toLong()
                )
                "scroll"   -> svc.scroll(
                    (json.getDouble("x") * w).toFloat(),
                    (json.getDouble("y") * h).toFloat(),
                    (json.getDouble("dy") * h).toFloat()
                )
                "keyevent" -> svc.pressKey(json.optString("keycode", "KEYCODE_BACK"))
                "text"     -> svc.typeText(json.optString("value", ""))
                "back"     -> svc.pressKey("KEYCODE_BACK")
                "home"     -> svc.pressKey("KEYCODE_HOME")
                "recents"  -> svc.pressKey("KEYCODE_APP_SWITCH")
            }
        } catch (_: Exception) {}
    }

    // Android shared-storage root. All phone-file operations are confined here —
    // an authoritative OS-level guard, independent of the browser's own check.
    private val phoneBase = "/storage/emulated/0"

    /** Resolves a path (handling ../symlinks) and returns the File only if it
     *  lands inside phoneBase; otherwise null. Empty path → the base itself. */
    private fun confinedFile(path: String): java.io.File? = try {
        val base = java.io.File(phoneBase).canonicalFile
        val f = java.io.File(path.ifEmpty { phoneBase }).canonicalFile
        if (f.path == base.path || f.path.startsWith(base.path + java.io.File.separator)) f else null
    } catch (_: Exception) { null }

    private fun pfErr(id: String, msg: String) =
        JSONObject().apply { put("type", "pf_error"); put("id", id); put("error", msg) }.toString()

    private fun handlePhoneFiles(json: JSONObject) {
        val id = json.optString("id")
        Thread {
            try {
                when (json.optString("type")) {
                    "pf_list" -> {
                        val dir = confinedFile(json.optString("path"))
                        if (dir == null) {
                            send(pfErr(id, "Access denied: outside shared storage"))
                            return@Thread
                        }
                        val path = dir.path
                        if (!dir.exists()) {
                            send(JSONObject().apply { put("type", "pf_error"); put("id", id); put("error", "Directory not found: $path") }.toString())
                            return@Thread
                        }
                        val entries = org.json.JSONArray()
                        dir.listFiles()
                            ?.sortedWith(compareBy({ it.isFile }, { it.name.lowercase() }))
                            ?.forEach { f ->
                                entries.put(JSONObject().apply {
                                    put("name", f.name)
                                    put("path", f.absolutePath)
                                    put("type", if (f.isDirectory) "dir" else "file")
                                    put("size", f.length())
                                    put("modified", f.lastModified())
                                })
                            }
                        send(JSONObject().apply {
                            put("type", "pf_list_result"); put("id", id)
                            put("path", path); put("entries", entries)
                        }.toString())
                    }
                    "pf_download" -> {
                        val file = confinedFile(json.optString("path"))
                        if (file == null) {
                            send(pfErr(id, "Access denied: outside shared storage"))
                            return@Thread
                        }
                        if (!file.exists()) {
                            send(JSONObject().apply { put("type", "pf_error"); put("id", id); put("error", "File not found") }.toString())
                            return@Thread
                        }
                        val bytes = file.readBytes()
                        val chunkSize = 65536
                        if (bytes.isEmpty()) {
                            send(JSONObject().apply {
                                put("type", "pf_chunk"); put("id", id)
                                put("index", 0); put("total", 1); put("done", true); put("data", "")
                            }.toString())
                            return@Thread
                        }
                        var offset = 0; var index = 0
                        val total = Math.ceil(bytes.size.toDouble() / chunkSize).toInt()
                        while (offset < bytes.size) {
                            if (cancelledDownloads.remove(id)) return@Thread
                            val end = minOf(offset + chunkSize, bytes.size)
                            send(JSONObject().apply {
                                put("type", "pf_chunk"); put("id", id)
                                put("index", index); put("total", total)
                                put("done", end >= bytes.size)
                                put("data", android.util.Base64.encodeToString(bytes.copyOfRange(offset, end), android.util.Base64.NO_WRAP))
                            }.toString())
                            offset = end; index++
                        }
                    }
                    "pf_upload_start" -> {
                        val dest = confinedFile(json.optString("path"))
                        if (dest == null) {
                            send(pfErr(id, "Access denied: outside shared storage"))
                            return@Thread
                        }
                        synchronized(uploads) { uploads[id] = mutableListOf() }
                        synchronized(uploadPaths) { uploadPaths[id] = dest.path }
                    }
                    "pf_upload_chunk" -> {
                        val data = android.util.Base64.decode(json.optString("data"), android.util.Base64.DEFAULT)
                        synchronized(uploads) { uploads.getOrPut(id) { mutableListOf() }.addAll(data.toList()) }
                        if (!json.optBoolean("done")) {
                            // Flow control: browser waits for this ack before sending the
                            // next chunk — prevents flooding the WebSocket on large files
                            // (same pattern as pf_chunk_ack on the download path).
                            send(JSONObject().apply {
                                put("type", "pf_upload_chunk_ack")
                                put("id", id)
                                put("index", json.optInt("index"))
                            }.toString())
                        }
                        if (json.optBoolean("done")) {
                            val allBytes: ByteArray
                            synchronized(uploads) { allBytes = uploads.remove(id)?.toByteArray() ?: byteArrayOf() }
                            val path: String
                            synchronized(uploadPaths) { path = uploadPaths.remove(id)?.trim() ?: "" }
                            if (path.isEmpty()) {
                                send(JSONObject().apply { put("type", "pf_error"); put("id", id); put("error", "Invalid upload path") }.toString())
                                return@Thread
                            }
                            val file = java.io.File(path.replace('\\', '/'))
                            file.parentFile?.mkdirs()
                            file.writeBytes(allBytes)
                            send(JSONObject().apply { put("type", "pf_upload_ok"); put("id", id); put("path", path) }.toString())
                        }
                    }
                    "pf_delete" -> {
                        val f = confinedFile(json.optString("path"))
                        if (f == null || f.path == java.io.File(phoneBase).canonicalFile.path) {
                            // Never allow deleting outside the base, or the base root itself
                            send(pfErr(id, "Access denied"))
                            return@Thread
                        }
                        if (f.isDirectory) f.deleteRecursively() else f.delete()
                        send(JSONObject().apply { put("type", "pf_delete_ok"); put("id", id); put("path", f.path) }.toString())
                    }
                }
            } catch (e: Exception) {
                try { send(JSONObject().apply { put("type", "pf_error"); put("id", id); put("error", e.message ?: "Unknown error") }.toString()) } catch (_: Exception) {}
            }
        }.start()
    }

    // Launch an app by fuzzy label match (e.g. "youtube") or exact package name.
    private fun handleOpenApp(json: JSONObject) {
        val id = json.optString("id")
        val pkgArg = json.optString("package").trim()
        val query = json.optString("query").trim()
        Thread {
            try {
                val pm = packageManager
                var pkg: String? = pkgArg.ifEmpty { null }
                var label: String? = null

                if (pkg == null && query.isNotEmpty()) {
                    val mainIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    val q = query.lowercase()
                    val best = pm.queryIntentActivities(mainIntent, 0)
                        .mapNotNull { ri ->
                            val lbl = ri.loadLabel(pm)?.toString() ?: return@mapNotNull null
                            val p = ri.activityInfo.packageName
                            val l = lbl.lowercase()
                            val score = when {
                                l == q            -> 4
                                l.startsWith(q)   -> 3
                                l.contains(q)     -> 2
                                p.lowercase().contains(q) -> 1
                                else              -> 0
                            }
                            if (score > 0) Triple(score, lbl, p) else null
                        }
                        .maxByOrNull { it.first }
                    if (best != null) { label = best.second; pkg = best.third }
                }

                if (pkg == null) {
                    send(JSONObject().apply {
                        put("type", "open_app_result"); put("id", id); put("ok", false)
                        put("error", "No installed app matches \"$query\"")
                    }.toString())
                    return@Thread
                }
                val launch = pm.getLaunchIntentForPackage(pkg)
                if (launch == null) {
                    send(JSONObject().apply {
                        put("type", "open_app_result"); put("id", id); put("ok", false)
                        put("error", "\"$pkg\" has no launcher and can't be opened")
                    }.toString())
                    return@Thread
                }
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // Launch via the AccessibilityService context when available —
                // accessibility services are exempt from the background
                // activity-start restrictions that block a plain Service on
                // Android 10+, so this is the reliable path.
                val ctx: Context = RemoteAccessibilityService.instance ?: this
                handler.post {
                    try { ctx.startActivity(launch) } catch (_: Exception) {
                        try { startActivity(launch) } catch (_: Exception) {}
                    }
                }
                send(JSONObject().apply {
                    put("type", "open_app_result"); put("id", id); put("ok", true)
                    put("launched", label ?: pkg); put("package", pkg)
                }.toString())
            } catch (e: Exception) {
                send(JSONObject().apply {
                    put("type", "open_app_result"); put("id", id); put("ok", false)
                    put("error", e.message ?: "Launch failed")
                }.toString())
            }
        }.start()
    }

    private fun handleCamera(json: JSONObject) {
        when (json.optString("type")) {
            "camera_start" -> {
                if (checkSelfPermission(android.Manifest.permission.CAMERA)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    send(JSONObject().apply {
                        put("type", "camera_error")
                        put("reason", "permission_denied")
                    }.toString())
                    return
                }
                val front = json.optBoolean("front", true)
                _cameraFront = front
                CameraForegroundService.instance?.stopCamera()
                startService(Intent(this, CameraForegroundService::class.java))
                handler.postDelayed({
                    CameraForegroundService.instance?.startCamera(front) { jpegBytes ->
                        val now = System.currentTimeMillis()
                        if (now - lastCameraFrameMs < 83L) return@startCamera  // 12fps cap
                        if ((ws?.queueSize() ?: 1L) > 0L) return@startCamera   // drop if wire busy
                        lastCameraFrameMs = now
                        val payload = ByteArray(jpegBytes.size + 1)
                        payload[0] = 0x02  // camera frame type marker
                        jpegBytes.copyInto(payload, destinationOffset = 1)
                        sendBinary(ByteString.of(*payload))
                    }
                    send("""{"type":"camera_streaming"}""")
                }, 300)
            }
            "camera_stop" -> {
                CameraForegroundService.instance?.stopCamera()
                stopService(Intent(this, CameraForegroundService::class.java))
                send("""{"type":"camera_stopped"}""")
            }
            "camera_flip" -> {
                _cameraFront = !_cameraFront
                val front = _cameraFront
                CameraForegroundService.instance?.stopCamera()
                handler.postDelayed({
                    CameraForegroundService.instance?.startCamera(front) { jpegBytes ->
                        val now = System.currentTimeMillis()
                        if (now - lastCameraFrameMs < 83L) return@startCamera  // 12fps cap
                        if ((ws?.queueSize() ?: 1L) > 0L) return@startCamera   // drop if wire busy
                        lastCameraFrameMs = now
                        val payload = ByteArray(jpegBytes.size + 1)
                        payload[0] = 0x02  // camera frame type marker
                        jpegBytes.copyInto(payload, destinationOffset = 1)
                        sendBinary(ByteString.of(*payload))
                    }
                    send("""{"type":"camera_streaming"}""")
                }, 300)
            }
        }
    }

    private fun handleScreenshot() {
        val svc = RemoteAccessibilityService.instance
        if (svc == null) {
            send("""{"type":"screenshot_error","reason":"accessibility_not_enabled"}""")
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            send("""{"type":"screenshot_error","reason":"requires_android_12"}""")
            return
        }
        svc.captureScreenshot { jpegBytes ->
            if (jpegBytes.isEmpty()) {
                send("""{"type":"screenshot_error","reason":"capture_failed"}""")
                return@captureScreenshot
            }
            val payload = ByteArray(jpegBytes.size + 1)
            payload[0] = 0x03
            jpegBytes.copyInto(payload, destinationOffset = 1)
            sendBinary(ByteString.of(*payload))
        }
    }

    private fun handleFlash(count: Int) {
        Thread {
            try {
                val cm = getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
                val cameraId = cm.cameraIdList.firstOrNull { id ->
                    cm.getCameraCharacteristics(id)
                        .get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
                }
                if (cameraId == null) {
                    android.util.Log.e("PhoneRemote", "Flash: no camera with flash found")
                    return@Thread
                }
                val n = count.coerceIn(1, 10)
                android.util.Log.d("PhoneRemote", "Flash: blinking $n times on camera $cameraId")
                repeat(n) { i ->
                    cm.setTorchMode(cameraId, true)
                    Thread.sleep(200)
                    cm.setTorchMode(cameraId, false)
                    if (i < n - 1) Thread.sleep(200)
                }
            } catch (e: Exception) {
                android.util.Log.e("PhoneRemote", "Flash failed: ${e.javaClass.simpleName}: ${e.message}")
            }
        }.start()
    }

    private fun handleRing() {
        try {
            val am = getSystemService(Context.AUDIO_SERVICE) as android.media.AudioManager
            // Force alarm stream volume to max so it plays even in silent/DND mode
            val maxVol = am.getStreamMaxVolume(android.media.AudioManager.STREAM_ALARM)
            am.setStreamVolume(android.media.AudioManager.STREAM_ALARM, maxVol, 0)

            val uri = android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM)
                ?: android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE)
            val ringtone = android.media.RingtoneManager.getRingtone(this, uri)
            if (ringtone == null) {
                val tg = android.media.ToneGenerator(android.media.AudioManager.STREAM_ALARM, 100)
                tg.startTone(android.media.ToneGenerator.TONE_PROP_BEEP2, 5000)
                handler.postDelayed({ tg.release() }, 5500)
                return
            }
            ringtone.audioAttributes = android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            ringtone.play()
            handler.postDelayed({ ringtone.stop() }, 5000)
        } catch (e: Exception) {
            android.util.Log.e("PhoneRemote", "Ring failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun handleScreenCapture(json: JSONObject) {
        when (json.optString("type")) {
            "stream_start" -> {
                if (ScreenCaptureService.instance?.hasProjection() == true) {
                    startScreenStreaming()
                } else {
                    // No projection token yet — show a tappable notification the user can see
                    // from anywhere, and also try to bring the app to the foreground directly.
                    showProjectionPromptNotification()
                    try {
                        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                            action = ACTION_REQUEST_PROJECTION
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        }
                        if (launch != null) startActivity(launch)
                    } catch (_: Exception) {}
                }
            }
            "stream_stop" -> {
                ScreenCaptureService.instance?.stop()
                send("""{"type":"stream_stopped"}""")
                onMessage?.invoke(json.toString())
            }
        }
    }

    private fun showProjectionPromptNotification() {
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            action = ACTION_REQUEST_PROJECTION
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        } ?: return
        val pi = PendingIntent.getActivity(
            this, 99, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // High-priority notification with full-screen intent:
        // - If phone screen is on → fires as a heads-up banner AND tries to launch the activity directly
        // - If phone screen is off → appears on lock screen so user can tap it
        // - USE_FULL_SCREEN_INTENT permission (added to manifest) enables the auto-launch behaviour
        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Screen Recording Permission Required")
            .setContentText("Tap to allow screen sharing and start streaming")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)   // treated like an incoming call — highest visibility
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)                   // auto-launches activity when screen is on
            .setAutoCancel(true)
            .build()
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID_PROMPT, notif)

        // Also update the ALWAYS-VISIBLE foreground service notification (works even if POST_NOTIFICATIONS
        // was denied, because foreground notifications can never be fully blocked by the user).
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification("Tap to allow screen recording ▶", serverUrl, pi))
    }

    // ── Notification ──────────────────────────────────────────────────────────

    fun updateNotification(status: String, url: String = serverUrl) {
        val mgr = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIF_ID, buildNotification(status, url))
    }

    private fun showForeground(status: String, url: String) {
        val notif = buildNotification(status, url)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun buildNotification(
        status: String,
        url: String,
        customTapIntent: PendingIntent? = null
    ): Notification {
        val tap = customTapIntent ?: PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, ConnectionForegroundService::class.java).apply {
                action = ACTION_STOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Phone Remote")
            .setContentText("Connection Service is running")
            .setSubText(status)
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .setContentIntent(tap)
            .addAction(android.R.drawable.ic_delete, "Stop", stopIntent)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Connection Service", NotificationManager.IMPORTANCE_MIN
            )
            ch.description = "Keeps Phone Remote running in the background"
            ch.setShowBadge(false)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onTaskRemoved(rootIntent: Intent?) {
        // App swiped from recents — service keeps running (stopWithTask="false" in manifest)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        instance = null
        cancelReconnect()
        stopLocationUpdates()
        ws?.close(1000, "service destroyed")
        client?.dispatcher?.executorService?.shutdown()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
