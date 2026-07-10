package com.phoneremote

import android.app.Activity
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import android.util.Base64
import org.json.JSONObject

class MainActivity : FlutterActivity() {
    private val SCREEN_CH = "com.phoneremote/screen"
    private val TOUCH_CH  = "com.phoneremote/touch"
    private val CAMERA_CH = "com.phoneremote/camera"
    private val PERM_CODE = 101

    private var screenChannel: MethodChannel? = null
    private var touchChannel: MethodChannel? = null
    private var cameraChannel: MethodChannel? = null
    private var captureService: ScreenCaptureService? = null
    private var pendingResult: MethodChannel.Result? = null
    private var physicalW: Int = 0
    private var physicalH: Int = 0

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(n: ComponentName, b: IBinder) {
            captureService = (b as ScreenCaptureService.LocalBinder).service
        }
        override fun onServiceDisconnected(n: ComponentName) { captureService = null }
    }

    override fun configureFlutterEngine(engine: FlutterEngine) {
        super.configureFlutterEngine(engine)

        // ── Event channel — streams WebSocket messages from Kotlin service to Flutter ──
        EventChannel(engine.dartExecutor.binaryMessenger, "com.phoneremote/events")
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(args: Any?, sink: EventChannel.EventSink) {
                    ConnectionForegroundService.onMessage = { json ->
                        runOnUiThread { try { sink.success(json) } catch (_: Exception) {} }
                    }
                    // Immediately tell Flutter the current connection state
                    val svc = ConnectionForegroundService.instance
                    if (svc != null) {
                        runOnUiThread {
                            try {
                                if (svc.isAlive) sink.success("""{"type":"auth_ok"}""")
                                else sink.success("""{"type":"_disconnected"}""")
                            } catch (_: Exception) {}
                        }
                    }
                }
                override fun onCancel(args: Any?) {
                    ConnectionForegroundService.onMessage = null
                }
            })

        // Store true physical screen dimensions (used to tag every frame)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = windowManager.currentWindowMetrics.bounds
            physicalW = bounds.width()
            physicalH = bounds.height()
        } else {
            val realSize = android.graphics.Point()
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.getRealSize(realSize)
            physicalW = realSize.x
            physicalH = realSize.y
        }

        // Bind capture service
        bindService(
            Intent(this, ScreenCaptureService::class.java),
            conn, BIND_AUTO_CREATE
        )

        // ── Screen channel ──────────────────────────────────────────────
        screenChannel = MethodChannel(engine.dartExecutor.binaryMessenger, SCREEN_CH)
        screenChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "startCapture" -> {
                    if (captureService?.hasProjection() == true) {
                        captureService?.restart { jpegBytes ->
                            val b64 = Base64.encodeToString(jpegBytes, Base64.NO_WRAP)
                            ConnectionForegroundService.instance?.send(
                                JSONObject().apply {
                                    put("type", "frame"); put("data", b64)
                                    put("w", physicalW); put("h", physicalH)
                                }.toString()
                            )
                        }
                        ConnectionForegroundService.instance?.send("""{"type":"stream_started"}""")
                        ConnectionForegroundService.onMessage?.invoke("""{"type":"_screen_started"}""")
                        result.success(null)
                    } else {
                        pendingResult = result
                        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                        startActivityForResult(mgr.createScreenCaptureIntent(), PERM_CODE)
                    }
                }
                "stopCapture" -> {
                    captureService?.stop()
                    ConnectionForegroundService.instance?.send("""{"type":"stream_stopped"}""")
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }

        // ── Camera channel ─────────────────────────────────────────────
        cameraChannel = MethodChannel(engine.dartExecutor.binaryMessenger, CAMERA_CH)
        cameraChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "startCameraStream" -> {
                    val front = call.argument<Boolean>("front") ?: true
                    val svc = CameraForegroundService.instance
                    if (svc == null) { result.error("NO_SVC", "Camera service not running", null); return@setMethodCallHandler }
                    svc.startCamera(front) { jpegBytes ->
                        runOnUiThread {
                            try { cameraChannel?.invokeMethod("onCameraFrame", Base64.encodeToString(jpegBytes, Base64.NO_WRAP)) } catch (_: Exception) {}
                        }
                    }
                    result.success(null)
                }
                "stopCameraStream" -> {
                    CameraForegroundService.instance?.stopCamera()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }

        // ── Touch channel ───────────────────────────────────────────────
        touchChannel = MethodChannel(engine.dartExecutor.binaryMessenger, TOUCH_CH)
        touchChannel!!.setMethodCallHandler { call, result ->
            when (call.method) {
                "isAccessibilityEnabled" -> {
                    result.success(RemoteAccessibilityService.instance != null)
                    return@setMethodCallHandler
                }
                "openAccessibilitySettings" -> {
                    startActivity(android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(null)
                    return@setMethodCallHandler
                }
                "startCameraService" -> {
                    startService(android.content.Intent(this, CameraForegroundService::class.java))
                    result.success(null)
                    return@setMethodCallHandler
                }
                "stopCameraService" -> {
                    stopService(android.content.Intent(this, CameraForegroundService::class.java))
                    result.success(null)
                    return@setMethodCallHandler
                }
                "wsSend" -> {
                    val json = call.argument<String>("json") ?: ""
                    ConnectionForegroundService.instance?.send(json)
                    result.success(null)
                    return@setMethodCallHandler
                }
                "requestBatteryOptimization" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        val pm = getSystemService(POWER_SERVICE) as PowerManager
                        if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                            startActivity(
                                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                    Uri.parse("package:$packageName"))
                            )
                        }
                    }
                    result.success(null)
                    return@setMethodCallHandler
                }
                "openAutoLaunchSettings" -> {
                    // Try Realme/OPPO/ColorOS auto-launch settings, fall back to app info
                    val tried = listOf(
                        Intent().setClassName("com.coloros.safecenter",
                            "com.coloros.safecenter.startupapp.StartupAppListActivity"),
                        Intent().setClassName("com.oppo.safe",
                            "com.oppo.safe.permission.startup.StartupAppListActivity"),
                        Intent().setClassName("com.iqoo.secure",
                            "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:$packageName"))
                    )
                    for (i in tried) {
                        try { startActivity(i); break } catch (_: Exception) {}
                    }
                    result.success(null)
                    return@setMethodCallHandler
                }
                "startConnectionService" -> {
                    val url    = call.argument<String>("url")    ?: ""
                    val token  = call.argument<String>("token")  ?: ""
                    val deviceId = call.argument<String>("deviceId") ?: ""
                    val status = call.argument<String>("status") ?: "Connected"
                    val screenW = call.argument<Int>("screenW") ?: 0
                    val screenH = call.argument<Int>("screenH") ?: 0
                    val model   = call.argument<String>("model") ?: "Android"
                    val intent = android.content.Intent(this, ConnectionForegroundService::class.java)
                        .putExtra("url", url)
                        .putExtra("token", token)
                        .putExtra("deviceId", deviceId)
                        .putExtra("status", status)
                        .putExtra("screenW", screenW)
                        .putExtra("screenH", screenH)
                        .putExtra("model", model)
                    startService(intent)
                    result.success(null)
                    return@setMethodCallHandler
                }
                "stopConnectionService" -> {
                    // Clear saved connection creds so a START_STICKY restart
                    // doesn't silently reconnect after logout
                    getSharedPreferences(ConnectionForegroundService.PREFS_NAME, android.content.Context.MODE_PRIVATE)
                        .edit().remove("url").remove("token").apply()
                    stopService(android.content.Intent(this, ConnectionForegroundService::class.java))
                    result.success(null)
                    return@setMethodCallHandler
                }
                "stopConnectionServiceForUrl" -> {
                    val url = call.argument<String>("url") ?: ""
                    val svc = ConnectionForegroundService.instance
                    if (svc != null && svc.serverUrl == url) {
                        // Clear saved URL so START_STICKY doesn't reconnect
                        getSharedPreferences(ConnectionForegroundService.PREFS_NAME, android.content.Context.MODE_PRIVATE)
                            .edit().remove("url").apply()
                        stopService(android.content.Intent(this, ConnectionForegroundService::class.java))
                        stopService(android.content.Intent(this, CameraForegroundService::class.java))
                        // ScreenCaptureService intentionally left running — MediaProjection token
                        // is reused on next connection so no permission dialog is needed
                    }
                    result.success(null)
                    return@setMethodCallHandler
                }
                "updateConnectionStatus" -> {
                    val status = call.argument<String>("status") ?: ""
                    val url    = call.argument<String>("url")    ?: ""
                    ConnectionForegroundService.instance?.updateNotification(status, url)
                    result.success(null)
                    return@setMethodCallHandler
                }
            }
            val svc = RemoteAccessibilityService.instance
            if (svc == null) {
                result.error("NO_A11Y", "Accessibility service not enabled", null)
                return@setMethodCallHandler
            }
            val w: Float
            val h: Float
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
                val bounds = windowManager.currentWindowMetrics.bounds
                w = bounds.width().toFloat()
                h = bounds.height().toFloat()
            } else {
                val realSize = android.graphics.Point()
                @Suppress("DEPRECATION")
                windowManager.defaultDisplay.getRealSize(realSize)
                w = realSize.x.toFloat()
                h = realSize.y.toFloat()
            }

            when (call.method) {
                "tap" -> {
                    val x = (call.argument<Double>("x")!! * w).toFloat()
                    val y = (call.argument<Double>("y")!! * h).toFloat()
                    svc.tap(x, y)
                    result.success(null)
                }
                "swipe" -> {
                    val x1 = (call.argument<Double>("x1")!! * w).toFloat()
                    val y1 = (call.argument<Double>("y1")!! * h).toFloat()
                    val x2 = (call.argument<Double>("x2")!! * w).toFloat()
                    val y2 = (call.argument<Double>("y2")!! * h).toFloat()
                    val ms = call.argument<Int>("ms") ?: 300
                    svc.swipe(x1, y1, x2, y2, ms.toLong())
                    result.success(null)
                }
                "scroll" -> {
                    val x  = (call.argument<Double>("x")!!  * w).toFloat()
                    val y  = (call.argument<Double>("y")!!  * h).toFloat()
                    val dx = (call.argument<Double>("dx")!! * w).toFloat()
                    val dy = (call.argument<Double>("dy")!! * h).toFloat()
                    svc.scroll(x, y, dy)
                    result.success(null)
                }
                "keyevent" -> {
                    svc.pressKey(call.argument<String>("keycode") ?: "KEYCODE_BACK")
                    result.success(null)
                }
                "text" -> {
                    svc.typeText(call.argument<String>("value") ?: "")
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }

    // Handle REQUEST_PROJECTION when the app is already running (notification tap while in background)
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == ConnectionForegroundService.ACTION_REQUEST_PROJECTION) {
            requestProjectionPermission()
        }
    }

    // Handle REQUEST_PROJECTION on cold start (app was closed when notification was tapped)
    override fun onStart() {
        super.onStart()
        if (intent?.action == ConnectionForegroundService.ACTION_REQUEST_PROJECTION) {
            intent.action = null  // prevent re-trigger on config changes
            requestProjectionPermission()
        }
    }

    private fun requestProjectionPermission() {
        // If we already have a projection token (race: user tapped notification twice),
        // just start streaming immediately — no dialog needed.
        val svc = captureService ?: ScreenCaptureService.instance
        if (svc?.hasProjection() == true) {
            ConnectionForegroundService.instance?.startScreenStreaming()
            return
        }
        pendingResult = null
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(mgr.createScreenCaptureIntent(), PERM_CODE)
    }

    override fun onActivityResult(req: Int, res: Int, data: Intent?) {
        super.onActivityResult(req, res, data)
        if (req == PERM_CODE) {
            if (res == Activity.RESULT_OK && data != null) {
                // Promote ScreenCaptureService to a started service so it survives MainActivity death
                startService(Intent(this, ScreenCaptureService::class.java))
                // Set up the MediaProjection token (empty callback — binary streaming is started below)
                val svc = captureService ?: ScreenCaptureService.instance
                svc?.start(res, data) { _ -> }
                // Start binary streaming via ConnectionForegroundService (replaces old b64 path)
                ConnectionForegroundService.instance?.startScreenStreaming()
                // Dismiss the permission prompt notification
                (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
                    .cancel(ConnectionForegroundService.NOTIF_ID_PROMPT)
                pendingResult?.success(null)
            } else {
                pendingResult?.error("DENIED", "Screen capture denied", null)
            }
            pendingResult = null
        }
    }

    override fun onDestroy() {
        unbindService(conn)
        super.onDestroy()
    }
}
