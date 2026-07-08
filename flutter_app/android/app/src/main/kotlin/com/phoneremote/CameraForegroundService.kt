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

    fun startCamera(front: Boolean, cb: (ByteArray) -> Unit) {
        stopCamera()
        onFrame = cb

        camThread = HandlerThread("CamThread").also { it.start() }
        camHandler = Handler(camThread!!.looper)

        val manager = getSystemService(CAMERA_SERVICE) as CameraManager
        val cameraId = findCameraId(manager, front)

        imageReader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 2)
        imageReader!!.setOnImageAvailableListener({ reader ->
            val image = reader.acquireLatestImage() ?: return@setOnImageAvailableListener
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
                cameraDevice = cam
                cam.createCaptureSession(
                    listOf(imageReader!!.surface),
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(session: CameraCaptureSession) {
                            captureSession = session
                            val req = cam.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                            req.addTarget(imageReader!!.surface)
                            req.set(CaptureRequest.JPEG_QUALITY, 20.toByte())
                            session.setRepeatingRequest(req.build(), null, camHandler)
                        }
                        override fun onConfigureFailed(session: CameraCaptureSession) {}
                    }, camHandler
                )
            }
            override fun onDisconnected(cam: CameraDevice) { cam.close() }
            override fun onError(cam: CameraDevice, error: Int) { cam.close() }
        }, camHandler)
    }

    fun stopCamera() {
        onFrame = null
        try { captureSession?.close() } catch (_: Exception) {}
        try { cameraDevice?.close() } catch (_: Exception) {}
        try { imageReader?.close() } catch (_: Exception) {}
        try { camThread?.quitSafely() } catch (_: Exception) {}
        captureSession = null; cameraDevice = null
        imageReader = null; camThread = null; camHandler = null
    }

    private fun findCameraId(mgr: CameraManager, front: Boolean): String {
        val target = if (front) CameraCharacteristics.LENS_FACING_FRONT
                     else CameraCharacteristics.LENS_FACING_BACK
        return mgr.cameraIdList.firstOrNull { id ->
            mgr.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == target
        } ?: mgr.cameraIdList[0]
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
