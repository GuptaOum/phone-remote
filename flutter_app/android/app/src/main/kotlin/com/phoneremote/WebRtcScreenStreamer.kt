package com.phoneremote

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.*

/**
 * Screen → WebRTC, fully native: lives in the foreground service, so it keeps
 * streaming with the Flutter UI closed. Frames come from the same VirtualDisplay
 * as the JPEG path (the display is pointed at [surface] instead of the JPEG
 * ImageReader), so one projection consent covers both.
 *
 * Each browser tab gets its own PeerConnection (keyed by the server's tab id);
 * all of them share one video track. The browser offers, we answer.
 */
class WebRtcScreenStreamer(
    private val ctx: Context,
    private val send: (String) -> Unit,
    private val onPeersChanged: () -> Unit,
) : ScreenCaptureService.SurfaceSink {

    companion object {
        private const val TAG = "PhoneRemote"
        private const val MAX_BITRATE_BPS = 2_500_000
        private var initialized = false
    }

    private class Peer {
        lateinit var pc: PeerConnection
        var remoteSet = false
        var connected = false
        val pendingIce = mutableListOf<IceCandidate>()
    }

    // All state below is touched only on this thread.
    private val thread = HandlerThread("RtcScreen").also { it.start() }
    private val h = Handler(thread.looper)
    private val peers = HashMap<String, Peer>()

    private var egl: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    @Volatile private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    private var track: VideoTrack? = null
    @Volatile private var surface: Surface? = null
    private var unusable = false

    @Volatile var connectedCount = 0
        private set

    // Called by ScreenCaptureService under its lock, from any thread.
    override fun surface(w: Int, h: Int): Surface? {
        val th = helper ?: return null
        if (w <= 0 || h <= 0) return null
        th.setTextureSize(w, h)
        return surface ?: Surface(th.surfaceTexture).also { surface = it }
    }

    fun onMessage(json: JSONObject) {
        h.post {
            val from = json.optString("from")
            if (from.isEmpty()) return@post
            when (json.optString("type")) {
                "rtc_offer" -> handleOffer(from, json.optString("sdp"), json.optJSONArray("iceServers"))
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
            if (!initialized) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext)
                        .createInitializationOptions()
                )
                initialized = true
            }
            val e = EglBase.create()
            egl = e
            val f = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(e.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(e.eglBaseContext))
                .createPeerConnectionFactory()
            factory = f
            val src = f.createVideoSource(true)
            source = src
            val th = SurfaceTextureHelper.create("RtcScreenCapture", e.eglBaseContext)
                ?: throw IllegalStateException("no SurfaceTextureHelper")
            th.startListening(VideoSink { frame -> src.capturerObserver.onFrameCaptured(frame) })
            helper = th
            src.capturerObserver.onCapturerStarted(true)
            track = f.createVideoTrack("screen0", src)
            true
        } catch (t: Throwable) {
            // Includes UnsatisfiedLinkError: no native lib for this ABI → JPEG only.
            Log.e(TAG, "WebRTC unavailable: $t")
            unusable = true
            releaseMedia()
            false
        }
    }

    private fun releaseMedia() {
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
        val config = PeerConnection.RTCConfiguration(parseIceServers(iceServers))
            .apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }

        val peer = Peer()
        val pc = factory!!.createPeerConnection(config, observer(from, peer))
            ?: return sendError(from, "pc_failed")
        peer.pc = pc
        peers[from] = peer

        pc.setRemoteDescription(object : SdpCallback() {
            override fun onSetSuccess() { h.post { onRemoteSet(from, peer) } }
            override fun onSetFailure(e: String?) { h.post { fail(from, peer, "bad_offer") } }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun onRemoteSet(from: String, peer: Peer) {
        if (peers[from] !== peer) return
        peer.remoteSet = true
        peer.pendingIce.forEach { peer.pc.addIceCandidate(it) }
        peer.pendingIce.clear()
        // After the remote offer, so addTrack reuses the browser's recvonly transceiver.
        peer.pc.addTrack(track, listOf("screen"))?.let(::tuneSender)
        peer.pc.createAnswer(object : SdpCallback() {
            override fun onCreateSuccess(answer: SessionDescription) {
                h.post {
                    if (peers[from] !== peer) return@post
                    peer.pc.setLocalDescription(object : SdpCallback() {
                        override fun onSetSuccess() {
                            send(JSONObject()
                                .put("type", "rtc_answer").put("to", from)
                                .put("sdp", answer.description).toString())
                        }
                        override fun onSetFailure(e: String?) { h.post { fail(from, peer, "answer_failed") } }
                    }, answer)
                }
            }
            override fun onCreateFailure(e: String?) { h.post { fail(from, peer, "answer_failed") } }
        }, MediaConstraints())
    }

    // Screen content is mostly text: under pressure drop frames, never resolution.
    private fun tuneSender(sender: RtpSender) {
        try {
            val p = sender.parameters
            p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION
            p.encodings.forEach { it.maxBitrateBps = MAX_BITRATE_BPS; it.maxFramerate = 30 }
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
                if (!peer.connected) { peer.connected = true; recount() }
            PeerConnection.PeerConnectionState.DISCONNECTED ->
                if (peer.connected) { peer.connected = false; recount() }
            PeerConnection.PeerConnectionState.FAILED,
            PeerConnection.PeerConnectionState.CLOSED -> closePeer(from)
            else -> {}
        }
    }

    private fun recount() {
        connectedCount = peers.values.count { it.connected }
        onPeersChanged()
    }

    private fun closePeer(from: String) {
        val peer = peers.remove(from) ?: return
        try { peer.pc.dispose() } catch (_: Exception) {}
        if (peer.connected) recount()
    }

    private fun fail(from: String, peer: Peer, reason: String) {
        if (peers[from] !== peer) return
        closePeer(from)
        sendError(from, reason)
    }

    private fun sendError(to: String, reason: String) {
        send(JSONObject().put("type", "rtc_error").put("to", to).put("reason", reason).toString())
    }

    private fun observer(from: String, peer: Peer) = object : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            send(JSONObject()
                .put("type", "rtc_ice").put("to", from)
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
