import { useCallback, useEffect, useRef, useState } from 'react';
import { useDevice } from '../context/DeviceContext';

// No video within this long (relay included) → fall back to JPEG.
const CONNECT_TIMEOUT_MS = 12000;
// Like Google Meet: a lost network path is repaired on the SAME call (ICE
// restart) — the video holds its last frame for a moment, then continues.
// false = old behaviour (fall back to JPEG, auto-retry later). Pairs with
// ICE_RESTART_HINT in server/src/services/signaling.js.
const ICE_RESTART = true;
// While restarting, keep the phone on WebRTC (true) or show JPEG meanwhile
// (false). JPEG is still the last resort if all restarts fail.
const STAY_ON_WEBRTC_WHILE_RECOVERING = true;
// Without ICE restart: give a 'disconnected' peer this long to recover by
// itself before falling back to JPEG.
const DISCONNECT_GRACE_MS = 5000;
// Network path lost (e.g. phone switched Wi-Fi ↔ cellular): ICE-restart the
// same peer up to this many times, each given RESTART_TIMEOUT_MS, before
// giving up on it (→ JPEG + auto-retry). JPEG covers the gap meanwhile.
const RESTART_TIMEOUT_MS = 6000;
const RESTART_MAX_ATTEMPTS = 3;
// Recovered onto the TURN relay? Right after a network switch the direct path
// (e.g. Jio IPv6) often isn't up yet, and WebRTC keeps the first path that
// worked — so try to move to a direct path once the network has settled.
const UPGRADE_DELAYS_MS = [5000, 15000];
// A video frame newer than this means WebRTC is what the user is seeing.
const VIDEO_FRESH_MS = 1000;
const FRAME_POLL_MS = 250;
// JPEG-over-WebSocket fallback — switched OFF: the screen/camera are shown
// only as WebRTC video. If the call can't be (re)established, we keep retrying
// WebRTC and the page shows "Connecting video…" meanwhile. Set true to bring
// back JPEG as the fallback (pairs with JPEG_FALLBACK in the phone's
// ConnectionForegroundService.kt).
const JPEG_FALLBACK = false;
// After a failed call, retry WebRTC with backoff. With JPEG on, a retry is a
// probe (JPEG keeps playing); without it, a normal offer.
const RETRY_FIRST_MS = JPEG_FALLBACK ? 4000 : 2000;
const RETRY_MAX_MS = JPEG_FALLBACK ? 30000 : 10000;

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
 * ICE restart: when the peer loses its network path ('disconnected' / 'failed',
 * or the server says the phone just re-registered — i.e. switched network) we
 * renegotiate the SAME peer with new ICE credentials instead of rebuilding it.
 * While that runs the tab reports rtc_recovering, so the phone shows JPEG; the
 * moment a new path answers we send rtc_ready and the phone switches back.
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
  const recoveringRef = useRef(false);
  const restartAttemptsRef = useRef(0);
  const restartTimerRef = useRef(null);
  const upgradeTimerRef = useRef(null);
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
    clearTimeout(restartTimerRef.current);
    clearTimeout(upgradeTimerRef.current);
    recoveringRef.current = false;
    restartAttemptsRef.current = 0;
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
      startRef.current?.({ probe: JPEG_FALLBACK });
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

  // Is the call going through our TURN relay (vs. direct phone ↔ browser)?
  const onRelay = async (pc) => {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return false;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  };

  const finishRecovery = useCallback((pc, upgradeStep = 0) => {
    if (pc !== pcRef.current || !recoveringRef.current) return;
    recoveringRef.current = false;
    restartAttemptsRef.current = 0;
    clearTimeout(restartTimerRef.current);
    sendRaw({ type: 'rtc_ready', kind }); // phone switches back to WebRTC
    // On the relay → one more restart later, once a direct path may exist.
    const delay = UPGRADE_DELAYS_MS[upgradeStep];
    if (delay === undefined) return;
    clearTimeout(upgradeTimerRef.current);
    upgradeTimerRef.current = setTimeout(async () => {
      if (pc !== pcRef.current || recoveringRef.current) return;
      try {
        if (!(await onRelay(pc))) return; // already direct
      } catch (_) { return; }
      upgradeStepRef.current = upgradeStep + 1;
      restartIceRef.current?.();
    }, delay);
  }, [sendRaw, kind]);
  const upgradeStepRef = useRef(0);

  // During a restart the browser may keep reporting 'connected' for the dead
  // old path, so decide by stats: a nominated pair that has received STUN
  // responses since the restart began is a working new path.
  const watchRecovery = useCallback((pc, baseline) => {
    const poll = async () => {
      if (pc !== pcRef.current || !recoveringRef.current) return;
      try {
        const stats = await pc.getStats();
        let ok = false;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded'
              && (r.responsesReceived || 0) > (baseline.get(r.id) || 0)) ok = true;
        });
        if (ok) return finishRecovery(pc, upgradeStepRef.current);
      } catch (_) { /* closed mid-poll */ }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 500);
  }, [finishRecovery]);

  // An ICE-restart offer can be lost: if the browser notices the dead path
  // before the phone's NEW socket has registered, the server still delivers
  // the offer to the phone's old, dead socket. Withdraw the unanswered offer
  // (rollback) so a fresh one can be sent.
  const rollbackOffer = async (pc) => {
    if (pc.signalingState !== 'have-local-offer') return true;
    try { await pc.setLocalDescription({ type: 'rollback' }); return true; } catch (_) { return false; }
  };

  const restartIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    if (!(await rollbackOffer(pc)) || pc !== pcRef.current) return;
    if (pc.signalingState !== 'stable') return;
    if (restartAttemptsRef.current >= RESTART_MAX_ATTEMPTS) { fail(); return; }
    restartAttemptsRef.current += 1;
    if (!recoveringRef.current) {
      recoveringRef.current = true;
      if (!STAY_ON_WEBRTC_WHILE_RECOVERING) sendRaw({ type: 'rtc_recovering', kind }); // phone shows JPEG meanwhile
    }
    clearTimeout(timerRef.current);
    clearTimeout(restartTimerRef.current);
    const baseline = new Map();
    pc.getStats()
      .then((stats) => stats.forEach((r) => {
        if (r.type === 'candidate-pair') baseline.set(r.id, r.responsesReceived || 0);
      }))
      .catch(() => {})
      .then(() => pc.createOffer({ iceRestart: true }))
      .then((o) => pc.setLocalDescription(o))
      .then(() => {
        if (pc !== pcRef.current) return;
        sendRaw({ type: 'rtc_offer', kind, restart: true, sdp: pc.localDescription.sdp });
        watchRecovery(pc, baseline);
      })
      .catch(() => { if (pc === pcRef.current) fail(); });
    // No new path in time → try again (new network may still be coming up, or
    // the offer went to a dead socket — restartIce withdraws it first).
    restartTimerRef.current = setTimeout(() => {
      if (pc === pcRef.current && recoveringRef.current) restartIceRef.current?.();
    }, RESTART_TIMEOUT_MS);
  }, [fail, sendRaw, kind, watchRecovery]);
  const restartIceRef = useRef(null);
  restartIceRef.current = restartIce;

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
        if (!recoveringRef.current) sendRaw({ type: 'rtc_ready', kind });
      } else if (s === 'disconnected' || s === 'failed') {
        if (ICE_RESTART && hadVideoRef.current) {
          if (!recoveringRef.current) upgradeStepRef.current = 0; // new outage
          // Network path lost after media flowed: find a new path, same peer.
          restartIceRef.current?.();
        } else if (s === 'failed') {
          fail(); // → JPEG, auto-retry later
        } else {
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            if (pc === pcRef.current && pc.connectionState !== 'connected') fail();
          }, DISCONNECT_GRACE_MS);
        }
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
    if (!JPEG_FALLBACK) return false;         // WebRTC only
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
          // A late answer to an offer we already withdrew (rollback): ignore.
          if (pc.signalingState !== 'have-local-offer') break;
          pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            .then(() => {
              pendingIceRef.current.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
            })
            .catch(() => fail());
          break;
        case 'rtc_ice':
          if (!pc || !mine || !msg.candidate) break;
          // Also queue while an offer (e.g. ICE restart) awaits its answer: the
          // phone's new candidates belong to the new session.
          if (pc.remoteDescription && pc.signalingState === 'stable') pc.addIceCandidate(msg.candidate).catch(() => {});
          else pendingIceRef.current.push(msg.candidate);
          break;
        case 'rtc_error':
          if (mine) fail(msg.reason !== 'unsupported');
          break;
        case 'rtc_unsupported':
          if (mine) fail(false);
          break;
        case 'rtc_restart':
          // Server: the phone just re-registered (network switch) — the old
          // path is dead even if the browser hasn't noticed yet.
          // Also while already recovering: our offer may have gone to the
          // phone's old socket — resend it to the new one.
          if (ICE_RESTART && pc && mine && hadVideoRef.current) {
            restartAttemptsRef.current = 0;
            upgradeStepRef.current = 0;
            clearTimeout(upgradeTimerRef.current);
            restartIceRef.current?.();
          }
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
