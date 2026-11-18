import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevice } from '../context/DeviceContext';

// No video within this long (relay included) → fall back to JPEG.
const CONNECT_TIMEOUT_MS = 12000;
// 'disconnected' often recovers by itself; JPEG covers the gap meanwhile.
const DISCONNECT_GRACE_MS = 5000;
// A video frame newer than this means WebRTC is what the user is seeing.
const VIDEO_FRESH_MS = 1000;
const FRAME_POLL_MS = 250;
// After a fallback, retry WebRTC (as a probe, JPEG keeps playing) with backoff.
const RETRY_FIRST_MS = 4000;
const RETRY_MAX_MS = 30000;

/**
 * WebRTC receive side for one phone source (`kind`: 'screen' | 'camera').
 *
 * WebRTC first: the page calls start() together with stream/camera start. We
 * offer a recvonly peer; the server switches the phone to WebRTC as soon as
 * the offer arrives, so the first frames already come as video (direct, or via
 * our TURN relay). While that is connecting, JPEG frames are held back. If it
 * fails (no answer, no path within CONNECT_TIMEOUT_MS, unsupported phone) we
 * send rtc_failed, the server moves the phone to JPEG, and JPEG is shown.
 * Later drops work the same way: video stops, JPEG resumes, the page shows it.
 *
 * Auto-retry: after a fallback (e.g. the phone switched Wi-Fi ↔ cellular) we
 * try WebRTC again after 4s, 8s, 16s… (max 30s) while `shouldRetry()` says the
 * page still wants the stream. A retry is a *probe*: JPEG stays on screen and
 * the phone switches only once the new peer is connected.
 *
 * Returns:
 *  - videoActive   true while WebRTC frames are being shown
 *  - start()       open a peer if none (no-op after a failure until reset())
 *  - stop()        close the peer locally
 *  - reset()       stop() and allow a fresh attempt (new stream start)
 *  - acceptJpeg()  should an arriving JPEG frame be shown? (false while WebRTC
 *                  is still connecting, or while video is flowing)
 *  - showJpeg()    JPEG frames took over again
 */
export function useRtcStream(kind, videoRef, { onVideoFrame, shouldRetry } = {}) {
  const { sendRaw, addListener, getRtcConfig } = useDevice();
  const [videoActive, setVideoActive] = useState(false);

  const pcRef = useRef(null);
  const gaveUpRef = useRef(false);
  const timerRef = useRef(null);
  const pendingIceRef = useRef([]);
  const lastFrameAtRef = useRef(0);
  const activeRef = useRef(false);
  const hadVideoRef = useRef(false);
  const probeRef = useRef(false);
  const retryTimerRef = useRef(null);
  const retryDelayRef = useRef(RETRY_FIRST_MS);
  const startRef = useRef(null);
  const onFrameRef = useRef(onVideoFrame);
  onFrameRef.current = onVideoFrame;
  const shouldRetryRef = useRef(shouldRetry);
  shouldRetryRef.current = shouldRetry;

  const setActive = useCallback((on) => {
    if (activeRef.current === on) return;
    activeRef.current = on;
    setVideoActive(on);
  }, []);

  const stop = useCallback(() => {
    clearTimeout(timerRef.current);
    clearTimeout(retryTimerRef.current);
    probeRef.current = false;
    pendingIceRef.current = [];
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) pc.close();
    if (videoRef.current) videoRef.current.srcObject = null;
    lastFrameAtRef.current = 0;
    hadVideoRef.current = false;
    setActive(false);
  }, [videoRef, setActive]);

  // `retry: false` when retrying is pointless (phone can't do WebRTC at all).
  const fail = useCallback((retry = true) => {
    const had = !!pcRef.current;
    stop();
    gaveUpRef.current = true;
    if (had) sendRaw({ type: 'rtc_failed', kind });
    if (!retry || !shouldRetryRef.current) return;
    const delay = retryDelayRef.current;
    retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
    retryTimerRef.current = setTimeout(() => {
      if (pcRef.current || !shouldRetryRef.current?.()) return;
      gaveUpRef.current = false;
      startRef.current?.({ probe: true });
    }, delay);
  }, [stop, sendRaw, kind]);

  // Detect arriving video from the decoder's frame counter rather than from the
  // <video> element: a hidden element may never report frames, and the page
  // keeps it hidden until we say video is flowing.
  const watchVideoFrames = useCallback((pc) => {
    let lastDecoded = 0;
    const poll = async () => {
      if (pc !== pcRef.current) return;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
          const n = r.framesDecoded || 0;
          if (n > lastDecoded && pc === pcRef.current) {
            lastDecoded = n;
            lastFrameAtRef.current = Date.now();
            hadVideoRef.current = true;
            retryDelayRef.current = RETRY_FIRST_MS; // healthy again: reset backoff
            setActive(true);
            if (videoRef.current) onFrameRef.current?.(videoRef.current);
          }
        });
      } catch (_) { /* closed mid-poll */ }
      if (pc === pcRef.current) setTimeout(poll, FRAME_POLL_MS);
    };
    poll();
  }, [videoRef, setActive]);

  const start = useCallback(({ probe = false } = {}) => {
    if (pcRef.current || gaveUpRef.current || !window.RTCPeerConnection) return;
    const pc = new RTCPeerConnection(getRtcConfig());
    pcRef.current = pc;
    probeRef.current = probe;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && candidate.candidate) sendRaw({ type: 'rtc_ice', kind, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ receiver, streams, track }) => {
      if (pc !== pcRef.current || !videoRef.current) return;
      // Remote control: show each frame as soon as it arrives. Chrome otherwise
      // buffers video to smooth jitter, which adds delay on cellular.
      try { receiver.jitterBufferTarget = 0; } catch (_) {}
      try { receiver.playoutDelayHint = 0; } catch (_) {}
      videoRef.current.srcObject = streams[0] || new MediaStream([track]);
      watchVideoFrames(pc);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== pcRef.current) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        // Keep the CONNECT_TIMEOUT running until the first video frame.
        if (hadVideoRef.current) clearTimeout(timerRef.current);
        sendRaw({ type: 'rtc_ready', kind });
      } else if (s === 'failed') {
        fail();
      } else if (s === 'disconnected') {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (pc === pcRef.current && pc.connectionState !== 'connected') fail();
        }, DISCONNECT_GRACE_MS);
      }
    };
    // Connected but no video yet counts as a failure too: the user is waiting.
    timerRef.current = setTimeout(() => {
      if (pc === pcRef.current && !hadVideoRef.current) fail();
    }, CONNECT_TIMEOUT_MS);
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => {
        if (pc === pcRef.current) sendRaw({ type: 'rtc_offer', kind, probe, sdp: pc.localDescription.sdp });
      })
      .catch(() => fail());
  }, [getRtcConfig, sendRaw, kind, videoRef, watchVideoFrames, fail]);
  startRef.current = start;

  const reset = useCallback(() => {
    stop();
    gaveUpRef.current = false;
    retryDelayRef.current = RETRY_FIRST_MS;
  }, [stop]);

  const acceptJpeg = useCallback(() => {
    if (!pcRef.current) return true;          // no WebRTC (failed / unsupported)
    if (!hadVideoRef.current) return probeRef.current; // connecting: WebRTC first; a retry keeps JPEG
    return Date.now() - lastFrameAtRef.current >= VIDEO_FRESH_MS; // video stalled
  }, []);

  const showJpeg = useCallback(() => setActive(false), [setActive]);

  // Signalling replies for this kind (older phone builds omit kind → screen).
  useEffect(() => {
    return addListener((msg) => {
      const pc = pcRef.current;
      const mine = (msg.kind || 'screen') === kind;
      switch (msg.type) {
        case 'rtc_answer':
          if (!pc || !mine) break;
          pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            .then(() => {
              pendingIceRef.current.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
            })
            .catch(() => fail());
          break;
        case 'rtc_ice':
          if (!pc || !mine || !msg.candidate) break;
          if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
          else pendingIceRef.current.push(msg.candidate);
          break;
        case 'rtc_error':
          if (mine) fail(msg.reason !== 'unsupported');
          break;
        case 'rtc_unsupported':
          if (mine) fail(false);
          break;
        case 'phone_disconnected':
        case '_ws_closed':
          // The server already dropped our peer; a reconnect starts fresh.
          stop();
          gaveUpRef.current = false;
          break;
        default:
          break;
      }
    });
  }, [addListener, kind, fail, stop]);

  // Leaving the page.
  useEffect(() => () => stop(), [stop]);

  return { videoActive, start, stop, reset, acceptJpeg, showJpeg };
}
