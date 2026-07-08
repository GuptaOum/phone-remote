package com.phoneremote

import android.app.*
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream

class ScreenCaptureService : Service() {

    companion object {
        var instance: ScreenCaptureService? = null
    }

    inner class LocalBinder : Binder() { val service get() = this@ScreenCaptureService }
    override fun onBind(i: Intent): IBinder = LocalBinder()
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null
    private var onFrame: ((ByteArray) -> Unit)? = null
    private var running = false
    @Volatile private var pendingShot: ((ByteArray) -> Unit)? = null
    private val thread = Thread(::captureLoop).also { it.isDaemon = true }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        thread.start()
    }

    fun hasProjection(): Boolean = projection != null

    fun start(code: Int, data: Intent, cb: (ByteArray) -> Unit) {
        onFrame = cb
        startForegroundCompat()
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        projection = mgr.getMediaProjection(code, data)
        createDisplayAndReader()
        running = true
    }

    // Reuse existing MediaProjection — no permission dialog needed
    fun restart(cb: (ByteArray) -> Unit) {
        display?.release()
        reader?.close()
        display = null
        reader = null
        onFrame = cb
        startForegroundCompat()
        createDisplayAndReader()
        running = true
    }

    fun captureOnce(callback: (ByteArray) -> Unit) {
        if (projection == null) { callback(byteArrayOf()); return }
        if (running && reader != null) {
            // Streaming is active — piggyback on captureLoop (thread-safe: loop owns reader)
            pendingShot = callback
        } else {
            // Not streaming — use a temporary display
            Thread { captureInBackground(callback) }.start()
        }
    }

    private fun captureInBackground(callback: (ByteArray) -> Unit) {
        var tempReader: ImageReader? = null
        var tempDisplay: VirtualDisplay? = null
        try {
            val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
            val screenW: Int; val screenH: Int
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val b = wm.currentWindowMetrics.bounds; screenW = b.width(); screenH = b.height()
            } else {
                val p = android.graphics.Point()
                @Suppress("DEPRECATION") wm.defaultDisplay.getRealSize(p)
                screenW = p.x; screenH = p.y
            }
            val w = (screenW * 0.7f).toInt(); val h = (screenH * 0.7f).toInt()
            val dpi = resources.displayMetrics.densityDpi
            tempReader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
            tempDisplay = projection!!.createVirtualDisplay(
                "PhoneRemoteShot", w, h, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, tempReader.surface, null, null
            )
            Thread.sleep(300)
            var img: android.media.Image? = null
            repeat(20) {
                if (img != null) return@repeat
                img = tempReader.acquireLatestImage()
                if (img == null) Thread.sleep(100)
            }
            img?.let {
                val plane = it.planes[0]
                val stride = plane.rowStride / plane.pixelStride
                val bmp = Bitmap.createBitmap(stride, it.height, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                it.close()
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
                bmp.recycle()
                callback(out.toByteArray())
            } ?: callback(byteArrayOf())
        } catch (_: Exception) { callback(byteArrayOf()) }
        tempDisplay?.release()
        tempReader?.close()
    }

    fun stop() {
        running = false
        display?.release()
        reader?.close()
        display = null
        reader = null
        // Keep projection alive so next start() skips the permission dialog
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    private fun startForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(1, buildNotification())
        }
    }

    private fun createDisplayAndReader() {
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val screenW: Int
        val screenH: Int
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
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

        val scale = 0.7f
        val w = (screenW * scale).toInt()
        val h = (screenH * scale).toInt()
        val dpi = resources.displayMetrics.densityDpi

        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2)
        display = projection!!.createVirtualDisplay(
            "PhoneRemote", w, h, dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader!!.surface, null, null
        )
    }

    private fun captureLoop() {
        while (true) {
            if (!running) { Thread.sleep(100); continue }
            try {
                val img = reader?.acquireLatestImage()
                if (img == null) { Thread.sleep(33); continue }
                val plane = img.planes[0]
                val stride = plane.rowStride / plane.pixelStride
                val bmp = Bitmap.createBitmap(stride, img.height, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(plane.buffer)
                img.close()
                val shot = pendingShot
                if (shot != null) {
                    pendingShot = null
                    val out = ByteArrayOutputStream()
                    bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
                    bmp.recycle()
                    shot.invoke(out.toByteArray())
                    Thread.sleep(83)
                    continue
                }
                val out = ByteArrayOutputStream()
                bmp.compress(Bitmap.CompressFormat.JPEG, 35, out)
                bmp.recycle()
                onFrame?.invoke(out.toByteArray())
                Thread.sleep(83)
            } catch (e: Exception) {
                if (running) Thread.sleep(100)
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
        display?.release()
        reader?.close()
        projection?.stop()
        display = null; reader = null; projection = null
        super.onDestroy()
    }
}
