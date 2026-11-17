package com.phoneremote

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Size
import android.view.Surface
import androidx.core.app.NotificationCompat

class CameraForegroundService : Service() {

    companion object {
        var instance: CameraForegroundService? = null
        // WebRTC capture size cap (sensor orientation, i.e. landscape).
        private const val RTC_MAX_W = 1280
        private const val RTC_MAX_H = 720
    }

    /** Alternative frame destination (WebRTC); null = the JPEG ImageReader. */
    interface CameraSink {
        fun cameraSurface(w: Int, h: Int, sensorOrientation: Int, front: Boolean): Surface?
    }

    inner class LocalBinder : Binder() { val service get() = this@CameraForegroundService }
    override fun onBind(i: Intent): IBinder = LocalBinder()

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var camThread: HandlerThread? = null
    private var camHandler: Handler? = null
    private var onFrame: ((ByteArray) -> Unit)? = null

    // Survives camera restarts (flip): WebRTC peers stay connected across them.
    @Volatile private var sink: CameraSink? = null
    private var camFront = true
    private var camOrientation = 0
    private var rtcSize = Size(640, 480)
    private var started = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(2, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        } else {
            startForeground(2, buildNotification())
        }
        return START_STICKY
    }

    val isStreaming: Boolean get() = onFrame != null

    // Bumped on every start/stop so callbacks from a superseded camera
    // session (flip, restart) can't report on behalf of the current one.
    @Volatile private var generation = 0

    /**
     * [onStarted] fires once the repeating request is running; [onError] if the
     * camera can't be opened or drops out. Both may run on the camera thread.
     */
    fun startCamera(
        front: Boolean,
        onStarted: (() -> Unit)? = null,
        onError: ((String) -> Unit)? = null,
        cb: (ByteArray) -> Unit,
    ) {
        stopCamera()
        val gen = ++generation
        onFrame = cb
        val fail = { reason: String ->
            if (gen == generation) {
                stopCamera()
                onError?.invoke(reason)
            }
        }

        try {
            camThread = HandlerThread("CamThread").also { it.start() }
            camHandler = Handler(camThread!!.looper)

            val manager = getSystemService(CAMERA_SERVICE) as CameraManager
            val cameraId = findCameraId(manager, front) ?: return fail("no_camera")
            val chars = manager.getCameraCharacteristics(cameraId)
            camFront = chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
            camOrientation = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            rtcSize = pickRtcSize(chars)
            started = false

            val reader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2)
            imageReader = reader
            reader.setOnImageAvailableListener({ r ->
                val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                try {
                    val buf = image.planes[0].buffer
                    val bytes = ByteArray(buf.remaining())
                    buf.get(bytes)
                    onFrame?.invoke(bytes)
                } finally {
                    image.close()
                }
            }, camHandler)

            manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
                override fun onOpened(cam: CameraDevice) {
                    if (gen != generation) { cam.close(); return }
                    cameraDevice = cam
                    configureSession(cam, gen, onStarted, fail)
                }
                override fun onDisconnected(cam: CameraDevice) {
                    cam.close()
                    fail("camera_disconnected")
                }
                override fun onError(cam: CameraDevice, error: Int) {
                    cam.close()
                    val inUse = error == CameraDevice.StateCallback.ERROR_CAMERA_IN_USE ||
                        error == CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE
                    fail(if (inUse) "camera_in_use" else "camera_error")
                }
            }, camHandler)
        } catch (e: SecurityException) {
            fail("permission_denied")
        } catch (e: Exception) {
            fail("open_failed")
        }
    }

    /**
     * (Re)creates the capture session aimed at the current destination: the
     * WebRTC sink if one is set and ready, else the JPEG reader. Runs on the
     * camera thread; the camera itself stays open.
     */
    private fun configureSession(
        cam: CameraDevice,
        gen: Int,
        onStarted: (() -> Unit)?,
        fail: (String) -> Unit,
    ) {
        val reader = imageReader ?: return
        val rtcTarget = sink?.cameraSurface(rtcSize.width, rtcSize.height, camOrientation, camFront)
        val target = rtcTarget ?: reader.surface
        try {
            cam.createCaptureSession(
                listOf(target),
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (gen != generation) { session.close(); return }
                        try {
                            captureSession = session
                            val tpl = if (rtcTarget != null) CameraDevice.TEMPLATE_RECORD else CameraDevice.TEMPLATE_PREVIEW
                            val req = cam.createCaptureRequest(tpl)
                            req.addTarget(target)
                            if (rtcTarget == null) req.set(CaptureRequest.JPEG_QUALITY, 20.toByte())
                            session.setRepeatingRequest(req.build(), null, camHandler)
                            if (!started) { started = true; onStarted?.invoke() }
                        } catch (e: Exception) {
                            fail("capture_failed")
                        }
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        fail("configure_failed")
                    }
                }, camHandler
            )
        } catch (e: Exception) {
            fail("capture_failed")
        }
    }

    /** Point the running camera at [s] (WebRTC) or back at JPEG (null). */
    fun routeTo(s: CameraSink?) {
        if (sink === s) return
        sink = s
        val h = camHandler ?: return
        h.post {
            val cam = cameraDevice ?: return@post
            val gen = generation
            configureSession(cam, gen, null) { reason ->
                // Can't feed WebRTC: fall back to JPEG rather than losing the camera.
                if (gen == generation && sink != null) { sink = null; configureSession(cam, gen, null) { } }
                android.util.Log.e("PhoneRemote", "camera reroute failed: $reason")
            }
        }
    }

    private fun pickRtcSize(chars: CameraCharacteristics): Size {
        val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(SurfaceTexture::class.java).orEmpty()
        return sizes.filter { it.width <= RTC_MAX_W && it.height <= RTC_MAX_H }
            .maxByOrNull { it.width * it.height } ?: Size(640, 480)
    }

    fun stopCamera() {
        generation++
        onFrame = null
        try { captureSession?.close() } catch (_: Exception) {}
        try { cameraDevice?.close() } catch (_: Exception) {}
        try { imageReader?.close() } catch (_: Exception) {}
        try { camThread?.quitSafely() } catch (_: Exception) {}
        captureSession = null; cameraDevice = null
        imageReader = null; camThread = null; camHandler = null
    }

    private fun findCameraId(mgr: CameraManager, front: Boolean): String? {
        val target = if (front) CameraCharacteristics.LENS_FACING_FRONT
                     else CameraCharacteristics.LENS_FACING_BACK
        val ids = mgr.cameraIdList
        return ids.firstOrNull { id ->
            mgr.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == target
        } ?: ids.firstOrNull()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel("camera", "Camera Stream", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Keeps camera streaming when screen is off"
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }
    }

    private fun buildNotification() = NotificationCompat.Builder(this, "camera")
        .setContentTitle("Phone Remote")
        .setContentText("Camera streaming remotely")
        .setSmallIcon(android.R.drawable.ic_menu_camera)
        .setOngoing(true)
        .build()

    override fun onDestroy() {
        stopCamera()
        instance = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
