package com.phoneremote

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.graphics.Point
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Display
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream

class ScreenCaptureService : Service() {

    companion object {
        var instance: ScreenCaptureService? = null

        /** Real display size in the CURRENT rotation (includes the nav bar). */
        fun realScreenSize(ctx: Context): Point {
            val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
            val p = Point()
            @Suppress("DEPRECATION")
            dm.getDisplay(Display.DEFAULT_DISPLAY)?.getRealSize(p)
            return p
        }

        private const val SCALE = 0.7f
        private const val ROTATION_CHECK_MS = 750L
    }

    inner class LocalBinder : Binder() { val service get() = this@ScreenCaptureService }
    override fun onBind(i: Intent): IBinder = LocalBinder()
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private val mainHandler = Handler(Looper.getMainLooper())
    // Guards display/reader: the capture thread reads from the reader while the
    // main thread may release or swap it.
    private val lock = Any()
    @Volatile private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var capW = 0
    private var capH = 0
    @Volatile private var onFrame: ((ByteArray) -> Unit)? = null
    @Volatile private var running = false
    private val thread = Thread(::captureLoop).also { it.isDaemon = true }

    // Required before createVirtualDisplay on Android 14+. Also how we learn
    // the user ended sharing from the status bar, or the token was revoked.
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            val wasRunning = running
            running = false
            synchronized(lock) { releaseDisplayLocked() }
            projection = null
            try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
            if (wasRunning) ConnectionForegroundService.instance?.onProjectionStopped()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        thread.start()
    }

    fun hasProjection(): Boolean = projection != null
    val isStreaming: Boolean get() = running

    /** Store the consent result. Capture itself starts in [startStreaming]. */
    fun acceptProjection(code: Int, data: Intent) {
        // Android 14: the mediaProjection foreground service must be running
        // before getMediaProjection is called.
        startForegroundCompat()
        dropProjection()
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = mgr.getMediaProjection(code, data)?.also {
            it.registerCallback(projectionCallback, mainHandler)
        }
    }

    /**
     * Begin (or keep) capturing, delivering JPEG frames to [cb].
     * Already capturing → only the frame sink is swapped; the virtual display
     * is NOT recreated (recreating it stutters, and on Android 14+ a token
     * cannot create a second display at all).
     * @return false if the token can't be used and consent must be asked again.
     */
    fun startStreaming(cb: (ByteArray) -> Unit): Boolean {
        if (projection == null) return false
        onFrame = cb
        if (running && display != null) return true
        startForegroundCompat()
        try {
            synchronized(lock) { if (display == null) createDisplayAndReaderLocked() }
        } catch (e: Exception) {
            synchronized(lock) { releaseDisplayLocked() }
            dropProjection()
            return false
        }
        running = true
        return true
    }

    /** Consent arrived but nobody wants the stream anymore — keep the token, drop the notification. */
    fun idle() {
        if (!running) try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
    }

    fun stop() {
        running = false
        onFrame = null
        synchronized(lock) { releaseDisplayLocked() }
        // Before Android 14 the token can drive a new display later, so the
        // next start needs no permission dialog. From 14 on it is single-use.
        if (Build.VERSION.SDK_INT >= 34) dropProjection()
        try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
    }

    private fun dropProjection() {
        val p = projection ?: return
        projection = null
        try { p.unregisterCallback(projectionCallback) } catch (_: Exception) {}
        try { p.stop() } catch (_: Exception) {}
    }

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(1, buildNotification())
        }
    }

    private fun targetSize(): Pair<Int, Int> {
        val real = realScreenSize(this)
        return Pair((real.x * SCALE).toInt(), (real.y * SCALE).toInt())
    }

    private fun createDisplayAndReaderLocked() {
        val (w, h) = targetSize()
        val dpi = resources.displayMetrics.densityDpi
        val r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        reader = r
        capW = w
        capH = h
        display = projection!!.createVirtualDisplay(
            "PhoneRemote", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            r.surface, null, null
        )
    }

    private fun releaseDisplayLocked() {
        try { display?.release() } catch (_: Exception) {}
        try { reader?.close() } catch (_: Exception) {}
        display = null
        reader = null
        capW = 0
        capH = 0
    }

    // Rotation: resize the mirror instead of letterboxing a landscape screen
    // into a portrait buffer (which also put every remote tap off target).
    private fun resizeIfRotatedLocked() {
        val d = display ?: return
        val (w, h) = targetSize()
        if (w <= 0 || h <= 0 || (w == capW && h == capH)) return
        val newReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        d.resize(w, h, resources.displayMetrics.densityDpi)
        d.surface = newReader.surface
        try { reader?.close() } catch (_: Exception) {}
        reader = newReader
        capW = w
        capH = h
    }

    private fun captureLoop() {
        var lastRotationCheck = 0L
        while (true) {
            if (!running) { Thread.sleep(100); continue }
            try {
                var bmp: Bitmap? = null
                synchronized(lock) {
                    val now = System.currentTimeMillis()
                    if (now - lastRotationCheck > ROTATION_CHECK_MS) {
                        lastRotationCheck = now
                        resizeIfRotatedLocked()
                    }
                    val img = reader?.acquireLatestImage()
                    if (img != null) {
                        try {
                            val plane = img.planes[0]
                            val stride = plane.rowStride / plane.pixelStride
                            val full = Bitmap.createBitmap(stride, img.height, Bitmap.Config.ARGB_8888)
                            full.copyPixelsFromBuffer(plane.buffer)
                            // Row padding makes the buffer wider than the image; crop it
                            // off so the frame's aspect matches the screen exactly.
                            bmp = if (stride > img.width) {
                                Bitmap.createBitmap(full, 0, 0, img.width, img.height).also { full.recycle() }
                            } else full
                        } finally {
                            img.close()
                        }
                    }
                }
                val frame = bmp
                if (frame == null) { Thread.sleep(33); continue }
                val out = ByteArrayOutputStream()
                frame.compress(Bitmap.CompressFormat.JPEG, 35, out)
                frame.recycle()
                onFrame?.invoke(out.toByteArray())
                Thread.sleep(83)
            } catch (e: Exception) {
                Thread.sleep(100)
            }
        }
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel("capture", "Screen Capture", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, "capture")
        .setContentTitle("Phone Remote")
        .setContentText("Screen is being shared remotely")
        .setSmallIcon(android.R.drawable.ic_menu_camera)
        .setOngoing(true).build()

    override fun onDestroy() {
        instance = null
        running = false
        synchronized(lock) { releaseDisplayLocked() }
        dropProjection()
        super.onDestroy()
    }
}
