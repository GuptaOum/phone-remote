package com.phoneremote

import android.content.Context
import android.graphics.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.OrientationEventListener
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*

/**
 * One captured source (screen or camera) → WebRTC, fully native: lives in the
 * foreground services, so it keeps streaming with the Flutter UI closed.
 *
 * Frames arrive on [surface]: the capturer that already feeds the JPEG path
 * (VirtualDisplay for the screen, the camera session for the camera) is pointed
 * at this Surface instead of its JPEG ImageReader, so one permission covers
 * both and switching transport never reopens the source.
 *
 * Each browser tab gets its own PeerConnection (keyed by the server's tab id);
 * all of them share one video track. The browser offers, we answer.
 */
class WebRtcStreamer(
    private val ctx: Context,
    private val kind: Kind,
    private val send: (String) -> Unit,
    private val onPeersChanged: () -> Unit,
) : ScreenCaptureService.SurfaceSink, CameraForegroundService.CameraSink {

    enum class Kind(
        val label: String,
        val screencast: Boolean,
        val maxBitrateBps: Int,
        val degradation: RtpParameters.DegradationPreference,
        val maxFramerate: Int = 30,
        // Send at most 1/n of the capture size (WebRTC can still go lower).
        val scaleDownBy: Double = 1.0,
    ) {
        // Remote control needs low latency more than sharp text: real-time mode
        // (not "screencast", which lets fps collapse to keep detail) and, when
        // bandwidth is tight (cellular start), lower the resolution — never the
        // frame rate.
        //
        // Tuned for navigating the phone, not watching video (2026-11-23): on a
        // Jio mobile uplink, bursts above ~600 kbps queued up and lost packets,
        // which is what made taps feel late. 600 kbps max, 15 fps and half the
        // screen size keep each frame small, so nothing builds up a delay.
        SCREEN("screen", false, 600_000, RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE,
            maxFramerate = 15, scaleDownBy = 2.0),
        // Camera is motion: keep it fluid, let resolution adapt on weak links.
        CAMERA("camera", false, 1_500_000, RtpParameters.DegradationPreference.BALANCED),
    }

    companion object {
        private const val TAG = "PhoneRemote"
        private var initialized = false
    }

    private class Peer {
        lateinit var pc: PeerConnection
        var remoteSet = false
        var connected = false
        val pendingIce = mutableListOf<IceCandidate>()
    }

    // All state below is touched only on this thread.
    private val thread = HandlerThread("Rtc-${kind.label}").also { it.start() }
    private val h = Handler(thread.looper)
    private val peers = HashMap<String, Peer>()

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    @Volatile private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    @Volatile private var surface: Surface? = null
    private var unusable = false

    // Camera only: the OS rotates the camera texture to the device's natural
    // orientation and mirrors the front lens. Like libwebrtc's own Camera2Session
    // we undo both and send the sensor rotation as metadata instead — otherwise a
    // rotated image would be squeezed into the sensor-shaped buffer.
    @Volatile private var camOrientation = 0
    @Volatile private var camFront = false

    // How the phone is physically held (0/90/180/270, clockwise from upright),
    // from the motion sensor. Not the display rotation: the camera runs in the
    // background and auto-rotate may be off, so the screen can stay portrait
    // while the phone is held sideways. Added to the frame rotation so the
    // browser shows a landscape picture when the phone is held landscape.
    @Volatile private var heldDegrees = 0
    private val heldListener: OrientationEventListener? =
        if (kind == Kind.CAMERA) object : OrientationEventListener(ctx.applicationContext) {
            override fun onOrientationChanged(deg: Int) {
                if (deg == ORIENTATION_UNKNOWN) return // lying flat: keep the last one
                // Switch only when clearly past the 45° midpoint, so holding the
                // phone near a diagonal doesn't make the picture flip back and forth.
                val diff = ((deg - heldDegrees + 540) % 360) - 180
                if (Math.abs(diff) > 55) heldDegrees = ((deg + 45) / 90 % 4) * 90
            }
        } else null

    @Volatile var connectedCount = 0
        private set

    /**
     * Peers negotiating or connected (removed on failure/close). WebRTC-first:
     * the capture is routed here as soon as this is > 0, so the first frames
     * already go to WebRTC; a failed peer drops it back to 0 → JPEG.
     */
    @Volatile var peerCount = 0
        private set

    // Screen: called by ScreenCaptureService under its lock, from any thread.
    override fun surface(w: Int, h: Int): Surface? {
        val th = helper ?: return null
        if (w <= 0 || h <= 0) return null
        th.setTextureSize(w, h)
        return surface ?: Surface(th.surfaceTexture).also { surface = it }
    }

    // Camera: called by CameraForegroundService on its camera thread.
    override fun cameraSurface(w: Int, h: Int, sensorOrientation: Int, front: Boolean): Surface? {
        camOrientation = sensorOrientation
        camFront = front
        heldListener?.let { if (it.canDetectOrientation()) it.enable() }
        return surface(w, h)
    }

    fun onMessage(json: JSONObject) {
        h.post {
            val from = json.optString("from")
            if (from.isEmpty()) return@post
            when (json.optString("type")) {
                "rtc_offer" -> {
                    val sdp = json.optString("sdp")
                    val ice = json.optJSONArray("iceServers")
                    // ICE restart (network changed): renegotiate the SAME peer — a
                    // new one would bring a new DTLS identity the browser rejects.
                    val peer = peers[from]
                    if (json.optBoolean("restart") && peer != null && peer.remoteSet) restartIce(from, peer, sdp, ice)
                    else handleOffer(from, sdp, ice)
                }
                "rtc_ice" -> handleIce(from, json.optJSONObject("candidate"))
                "rtc_close" -> closePeer(from)
            }
        }
    }

    fun closeAll() {
        h.post { peers.keys.toList().forEach(::closePeer) }
    }

    fun release() {
        h.post {
            peers.keys.toList().forEach(::closePeer)
            releaseMedia()
            thread.quitSafely()
        }
    }

    private fun ensureInit(): Boolean {
        if (factory != null) return true
        if (unusable) return false
        return try {
            synchronized(WebRtcStreamer::class.java) {
                if (!initialized) {
                    PeerConnectionFactory.initialize(
                        PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext)
                            .createInitializationOptions()
                    )
                    initialized = true
                }
            }
            val e = EglBase.create()
            egl = e
            val f = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
                .createPeerConnectionFactory()
            factory = f
            val src = f.createVideoSource(kind.screencast)
            source = src
            val th = SurfaceTextureHelper.create("Rtc-${kind.label}-capture", e.eglBaseContext)
                ?: throw IllegalStateException("no SurfaceTextureHelper")
            th.startListening(VideoSink { frame ->
                if (kind == Kind.CAMERA) {
                    val fixed = cameraFrame(frame)
                    src.capturerObserver.onFrameCaptured(fixed)
                    fixed.release()
                } else {
                    src.capturerObserver.onFrameCaptured(frame)
                }
            })
            helper = th
            src.capturerObserver.onCapturerStarted(true)
            track = f.createVideoTrack("${kind.label}0", src)
            true
        } catch (t: Throwable) {
            // Includes UnsatisfiedLinkError: no native lib for this ABI → JPEG only.
            Log.e(TAG, "WebRTC ${kind.label} unavailable: $t")
            unusable = true
            releaseMedia()
            false
        }
    }

    /**
     * Same correction libwebrtc's Camera2Session applies: undo the OS texture
     * transform, then send the rotation as metadata. The rotation combines the
     * sensor angle with how the phone is held (Camera2Session uses the display
     * rotation for the same purpose).
     */
    private fun cameraFrame(frame: VideoFrame): VideoFrame {
        val buf = frame.buffer as? TextureBufferImpl ?: return frame.also { it.retain() }
        val m = Matrix()
        m.preTranslate(0.5f, 0.5f)
        if (camFront) m.preScale(-1f, 1f)
        m.preRotate(-camOrientation.toFloat())
        m.preTranslate(-0.5f, -0.5f)
        val held = heldDegrees
        val rotation = if (camFront) (camOrientation - held + 360) % 360 else (camOrientation + held) % 360
        return VideoFrame(buf.applyTransformMatrix(m, buf.width, buf.height), rotation, frame.timestampNs)
    }

    private fun releaseMedia() {
        try { heldListener?.disable() } catch (_: Exception) {}
        try { helper?.stopListening() } catch (_: Exception) {}
        try { helper?.dispose() } catch (_: Exception) {}
        try { surface?.release() } catch (_: Exception) {}
        try { track?.dispose() } catch (_: Exception) {}
        try { source?.dispose() } catch (_: Exception) {}
        try { factory?.dispose() } catch (_: Exception) {}
        try { egl?.release() } catch (_: Exception) {}
        helper = null; surface = null; track = null; source = null; factory = null; egl = null
    }

    /**
     * ICE servers sent by the server with each offer: STUN plus our coturn
     * relay with short-lived credentials. Falls back to Google STUN alone if
     * the server sent none (older server) or the list is malformed.
     */
    private fun parseIceServers(arr: JSONArray?): List<PeerConnection.IceServer> {
        val out = mutableListOf<PeerConnection.IceServer>()
        if (arr != null) for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val urls = o.optJSONArray("urls")?.let { a -> (0 until a.length()).map { a.optString(it) } }
                ?: listOfNotNull(o.optString("urls").takeIf { it.isNotEmpty() })
            if (urls.isEmpty()) continue
            val b = PeerConnection.IceServer.builder(urls)
            o.optString("username").takeIf { it.isNotEmpty() }?.let { b.setUsername(it) }
            o.optString("credential").takeIf { it.isNotEmpty() }?.let { b.setPassword(it) }
            out.add(b.createIceServer())
        }
        if (out.isEmpty()) out.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer())
        return out
    }

    private fun handleOffer(from: String, sdp: String, iceServers: JSONArray?) {
        closePeer(from)
        if (!ensureInit()) return sendError(from, "unsupported")
        val config = rtcConfig(iceServers)

        val peer = Peer()
        val pc = factory!!.createPeerConnection(config, observer(from, peer))
            ?: return sendError(from, "pc_failed")
        peer.pc = pc
        peers[from] = peer
        recount() // capture can now be routed here (surface exists after ensureInit)

        pc.setRemoteDescription(object : SdpCallback() {
            override fun onSetSuccess() { h.post { onRemoteSet(from, peer) } }
            override fun onSetFailure(e: String?) { h.post { fail(from, peer, "bad_offer") } }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun rtcConfig(iceServers: JSONArray?) =
        PeerConnection.RTCConfiguration(parseIceServers(iceServers)).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // Keep gathering after connecting: when the phone changes network
            // (Wi-Fi ↔ cellular) new candidates are found and sent right away.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }

    /** Answer an ICE-restart offer on the existing connection: new network path, same media. */
    private fun restartIce(from: String, peer: Peer, sdp: String, iceServers: JSONArray?) {
        try { peer.pc.setConfiguration(rtcConfig(iceServers)) } catch (_: Exception) {} // fresh TURN credentials
        Log.i(TAG, "rtc ${kind.label}: ICE restart from browser")
        peer.pc.setRemoteDescription(object : SdpCallback() {
            override fun onSetSuccess() {
                h.post {
                    if (peers[from] !== peer) return@post
                    peer.pc.createAnswer(object : SdpCallback() {
                        override fun onCreateSuccess(answer: SessionDescription) {
                            h.post {
                                if (peers[from] !== peer) return@post
                                peer.pc.setLocalDescription(object : SdpCallback() {
                                    override fun onSetSuccess() {
                                        send(msg("rtc_answer", from).put("sdp", answer.description).toString())
                                    }
                                    override fun onSetFailure(e: String?) { h.post { fail(from, peer, "restart_failed") } }
                                }, answer)
                            }
                        }
                        override fun onCreateFailure(e: String?) { h.post { fail(from, peer, "restart_failed") } }
                    }, MediaConstraints())
                }
            }
            override fun onSetFailure(e: String?) { h.post { fail(from, peer, "restart_failed") } }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun onRemoteSet(from: String, peer: Peer) {
        if (peers[from] !== peer) return
        peer.remoteSet = true
        peer.pendingIce.forEach { peer.pc.addIceCandidate(it) }
        peer.pendingIce.clear()
        // After the remote offer, so addTrack reuses the browser's recvonly transceiver.
        peer.pc.addTrack(track, listOf(kind.label))?.let(::tuneSender)
        peer.pc.createAnswer(object : SdpCallback() {
            override fun onCreateSuccess(answer: SessionDescription) {
                h.post {
                    if (peers[from] !== peer) return@post
                    peer.pc.setLocalDescription(object : SdpCallback() {
                        override fun onSetSuccess() {
                            send(msg("rtc_answer", from).put("sdp", answer.description).toString())
                        }
                        override fun onSetFailure(e: String?) { h.post { fail(from, peer, "answer_failed") } }
                    }, answer)
                }
            }
            override fun onCreateFailure(e: String?) { h.post { fail(from, peer, "answer_failed") } }
        }, MediaConstraints())
    }

    private fun tuneSender(sender: RtpSender) {
        try {
            val p = sender.parameters
            p.degradationPreference = kind.degradation
            p.encodings.forEach {
                it.maxBitrateBps = kind.maxBitrateBps
                it.maxFramerate = kind.maxFramerate
                if (kind.scaleDownBy > 1.0) it.scaleResolutionDownBy = kind.scaleDownBy
            }
            sender.parameters = p
        } catch (_: Exception) {}
    }

    private fun handleIce(from: String, c: JSONObject?) {
        val peer = peers[from] ?: return
        val sdp = c?.optString("candidate").orEmpty()
        if (sdp.isBlank()) return
        val cand = IceCandidate(c!!.optString("sdpMid"), c.optInt("sdpMLineIndex"), sdp)
        if (peer.remoteSet) peer.pc.addIceCandidate(cand) else peer.pendingIce.add(cand)
    }

    private fun onState(from: String, peer: Peer, s: PeerConnection.PeerConnectionState) {
        if (peers[from] !== peer) return
        when (s) {
            PeerConnection.PeerConnectionState.CONNECTED ->
                if (!peer.connected) { peer.connected = true; recount(); logStats(from, peer) }
            PeerConnection.PeerConnectionState.DISCONNECTED ->
                if (peer.connected) { peer.connected = false; recount() }
            PeerConnection.PeerConnectionState.FAILED,
            PeerConnection.PeerConnectionState.CLOSED -> closePeer(from)
            else -> {}
        }
    }

    /**
     * Every 5s while connected: what the encoder actually sends (fps, size,
     * bitrate, why it is limited) and which network path the call uses.
     * `adb logcat -s PhoneRemote` — for diagnosing lag without guessing.
     */
    private fun logStats(from: String, peer: Peer) {
        var lastBytes = -1L
        var lastAt = 0L
        val tick = object : Runnable {
            override fun run() {
                if (peers[from] !== peer || !peer.connected) return
                peer.pc.getStats { report ->
                    val stats = report.statsMap.values
                    val out = stats.firstOrNull { it.type == "outbound-rtp" && it.members["kind"] == "video" }
                    val pair = stats.firstOrNull { it.type == "candidate-pair" && it.members["nominated"] == true && it.members["state"] == "succeeded" }
                    val local = pair?.let { p -> stats.firstOrNull { it.id == p.members["localCandidateId"] } }
                    val remote = pair?.let { p -> stats.firstOrNull { it.id == p.members["remoteCandidateId"] } }
                    // What the browser reports back: share of packets lost and jitter.
                    val rin = stats.firstOrNull { it.type == "remote-inbound-rtp" && it.members["kind"] == "video" }
                    fun num(v: Any?) = (v as? Number)?.toDouble()
                    val bweKbps = num(pair?.members?.get("availableOutgoingBitrate"))?.let { (it / 1000).toLong() }
                    val targetKbps = num(out?.members?.get("targetBitrate"))?.let { (it / 1000).toLong() }
                    val lossPct = num(rin?.members?.get("fractionLost"))?.let { Math.round(it * 1000) / 10.0 }
                    val jitterMs = num(rin?.members?.get("jitter"))?.let { Math.round(it * 1000) }
                    val bytes = (out?.members?.get("bytesSent") as? Number)?.toLong() ?: 0L
                    val now = System.currentTimeMillis()
                    val kbps = if (lastBytes >= 0 && now > lastAt) (bytes - lastBytes) * 8 / (now - lastAt) else 0
                    lastBytes = bytes; lastAt = now
                    Log.i(TAG, "rtc ${kind.label}: ${out?.members?.get("framesPerSecond")}fps " +
                        "${out?.members?.get("frameWidth")}x${out?.members?.get("frameHeight")} ${kbps}kbps " +
                        "limit=${out?.members?.get("qualityLimitationReason")} " +
                        "path=${local?.members?.get("candidateType")}/${local?.members?.get("protocol")}" +
                        "${local?.members?.get("relayProtocol")?.let { "($it)" } ?: ""}" +
                        "→${remote?.members?.get("candidateType")} rtt=${pair?.members?.get("currentRoundTripTime")} " +
                        "bwe=${bweKbps}kbps target=${targetKbps}kbps loss=${lossPct}% jitter=${jitterMs}ms " +
                        "lost=${rin?.members?.get("packetsLost")} nack=${out?.members?.get("nackCount")} " +
                        "pli=${out?.members?.get("pliCount")} resent=${out?.members?.get("retransmittedPacketsSent")}")
                }
                h.postDelayed(this, 5000)
            }
        }
        h.postDelayed(tick, 3000)
    }

    private fun recount() {
        connectedCount = peers.values.count { it.connected }
        peerCount = peers.size
        onPeersChanged()
    }

    private fun closePeer(from: String) {
        val peer = peers.remove(from) ?: return
        try { peer.pc.dispose() } catch (_: Exception) {}
        recount()
    }

    private fun fail(from: String, peer: Peer, reason: String) {
        if (peers[from] !== peer) return
        closePeer(from)
        sendError(from, reason)
    }

    private fun msg(type: String, to: String) =
        JSONObject().put("type", type).put("kind", kind.label).put("to", to)

    private fun sendError(to: String, reason: String) {
        send(msg("rtc_error", to).put("reason", reason).toString())
    }

    private fun observer(from: String, peer: Peer) = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            send(msg("rtc_ice", from)
                .put("candidate", JSONObject()
                    .put("candidate", c.sdp)
                    .put("sdpMid", c.sdpMid)
                    .put("sdpMLineIndex", c.sdpMLineIndex))
                .toString())
        }
        override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
            h.post { onState(from, peer, s) }
        }
        override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
        override fun onAddStream(s: MediaStream?) {}
        override fun onRemoveStream(s: MediaStream?) {}
        override fun onDataChannel(d: DataChannel?) {}
        override fun onRenegotiationNeeded() {}
    }

    private abstract class SdpCallback : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(e: String?) {}
        override fun onSetFailure(e: String?) {}
    }
}
