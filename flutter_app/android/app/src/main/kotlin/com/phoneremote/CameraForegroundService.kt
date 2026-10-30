package com.phoneremote

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import androidx.core.app.NotificationCompat

class CameraForegroundService : Service() {

    companion object {
        var instance: CameraForegroundService? = null
    }

    inner class LocalBinder : Binder() { val service get() = this@CameraForegroundService }
    override fun onBind(i: Intent): IBinder = LocalBinder()

    private var cameraDevice: CameraDevice? = null
    private var captureSession: CameraCaptureSession? = null
    private var imageReader: ImageReader? = null
    private var camThread: HandlerThread? = null
    private var camHandler: Handler? = null
    private var onFrame: ((ByteArray) -> Unit)? = null

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
                    try {
                        cam.createCaptureSession(
                            listOf(reader.surface),
                            object : CameraCaptureSession.StateCallback() {
                                override fun onConfigured(session: CameraCaptureSession) {
                                    if (gen != generation) { session.close(); return }
                                    try {
                                        captureSession = session
                                        val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                                        req.addTarget(reader.surface)
                                        req.set(CaptureRequest.JPEG_QUALITY, 20.toByte())
                                        session.setRepeatingRequest(req.build(), null, camHandler)
                                        onStarted?.invoke()
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
