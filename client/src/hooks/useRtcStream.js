import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevice } from '../context/DeviceContext';

// No connection within this long (relay included) → stay on JPEG.
const CONNECT_TIMEOUT_MS = 15000;
// 'disconnected' often recovers by itself; JPEG covers the gap meanwhile.
const DISCONNECT_GRACE_MS = 5000;
// A video frame newer than this means WebRTC is what the user is seeing.
const VIDEO_FRESH_MS = 1000;
const FRAME_POLL_MS = 250;

/**
 * WebRTC receive side for one phone source (`kind`: 'screen' | 'camera').
 *
 * The page always starts on JPEG frames (instant picture). On the first JPEG
 * frame it calls start(): we offer a recvonly peer, the phone answers, and once
 * connected (direct, or via our TURN relay) the server moves the phone's
 * capture over to WebRTC. Whichever source delivered the latest frame is shown,
 * so a fallback to JPEG needs no extra signalling: when video frames stop and
 * JPEG frames resume, the page calls showJpeg().
 *
 * Returns:
 *  - videoActive   true while WebRTC frames are being shown
 *  - start()       open a peer if none (no-op after a failure until reset())
 *  - stop()        close the peer locally
 *  - reset()       stop() and allow a fresh attempt (new stream start)
 *  - isVideoFresh() video frame within the last second → ignore stray JPEGs
 *  - showJpeg()    JPEG frames took over again
 */
export function useRtcStream(kind, videoRef, { onVideoFrame } = {}) {
  const { sendRaw, addListener, getRtcConfig } = useDevice();
  const [videoActive, setVideoActive] = useState(false);

  const pcRef = useRef(null);
  const gaveUpRef = useRef(false);
  const timerRef = useRef(null);
  const pendingIceRef = useRef([]);
  const lastFrameAtRef = useRef(0);
  const activeRef = useRef(false);
  const onFrameRef = useRef(onVideoFrame);
  onFrameRef.current = onVideoFrame;

  const setActive = useCallback((on) => {
    if (activeRef.current === on) return;
    activeRef.current = on;
    setVideoActive(on);
  }, []);

  const stop = useCallback(() => {
    clearTimeout(timerRef.current);
    pendingIceRef.current = [];
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) pc.close();
    if (videoRef.current) videoRef.current.srcObject = null;
    lastFrameAtRef.current = 0;
    setActive(false);
  }, [videoRef, setActive]);

  const fail = useCallback(() => {
    const had = !!pcRef.current;
    stop();
    gaveUpRef.current = true; // retried on the next stream start
    if (had) sendRaw({ type: 'rtc_failed', kind });
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
            setActive(true);
            if (videoRef.current) onFrameRef.current?.(videoRef.current);
          }
        });
      } catch (_) { /* closed mid-poll */ }
      if (pc === pcRef.current) setTimeout(poll, FRAME_POLL_MS);
    };
    poll();
  }, [videoRef, setActive]);

  const start = useCallback(() => {
    if (pcRef.current || gaveUpRef.current || !window.RTCPeerConnection) return;
    const pc = new RTCPeerConnection(getRtcConfig());
    pcRef.current = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && candidate.candidate) sendRaw({ type: 'rtc_ice', kind, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ streams, track }) => {
      if (pc !== pcRef.current || !videoRef.current) return;
      videoRef.current.srcObject = streams[0] || new MediaStream([track]);
      watchVideoFrames(pc);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== pcRef.current) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(timerRef.current);
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
    timerRef.current = setTimeout(() => {
      if (pc === pcRef.current && pc.connectionState !== 'connected') fail();
    }, CONNECT_TIMEOUT_MS);
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => {
        if (pc === pcRef.current) sendRaw({ type: 'rtc_offer', kind, sdp: pc.localDescription.sdp });
      })
      .catch(fail);
  }, [getRtcConfig, sendRaw, kind, videoRef, watchVideoFrames, fail]);

  const reset = useCallback(() => {
    stop();
    gaveUpRef.current = false;
  }, [stop]);

  const isVideoFresh = useCallback(
    () => !!pcRef.current && Date.now() - lastFrameAtRef.current < VIDEO_FRESH_MS,
    []
  );

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
            .catch(fail);
          break;
        case 'rtc_ice':
          if (!pc || !mine || !msg.candidate) break;
          if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
          else pendingIceRef.current.push(msg.candidate);
          break;
        case 'rtc_error':
        case 'rtc_unsupported':
          if (mine) fail();
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

  return { videoActive, start, stop, reset, isVideoFresh, showJpeg };
}
