import React, { useState, useEffect, useRef } from 'react';
import { useDevice } from '../context/DeviceContext';
import {
  Play,
  Square,
  ArrowLeft,
  Home,
  Layers,
  Power,
  Volume2,
  Volume1,
  Camera,
  Type,
  Bell,
  Zap,
  AlertCircle,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
} from 'lucide-react';

// sessionStorage holds the id of the device this tab is streaming, so a page
// refresh resumes that device's stream (and only that one).
const INTENT_KEY = 'pr_streaming';
const START_TIMEOUT_MS = 15000;
const STOP_FRAME_SUPPRESS_MS = 1500;

const STREAM_ERRORS = {
  permission_denied: 'Screen-recording permission was denied on the phone.',
  projection_stopped: 'Screen sharing was stopped on the phone.',
  phone_offline: 'The phone is offline.',
  capture_failed: 'The phone could not start screen capture. Try again.',
};

export default function MirrorPage() {
  const {
    selectedDeviceId,
    phoneOnline,
    wsStatus,
    sendControl,
    sendRaw,
    addListener,
  } = useDevice();

  const [streaming, setStreaming] = useState(false);
  const [streamStarting, setStreamStarting] = useState(false);
  const [streamError, setStreamError] = useState('');
  const [notice, setNotice] = useState('');
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [pressSubmit, setPressSubmit] = useState(false);
  const [usePaste, setUsePaste] = useState(false);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [showFlashMenu, setShowFlashMenu] = useState(false);

  const canvasRef = useRef(null);
  const pointerStartRef = useRef(null);
  const suppressFramesUntilRef = useRef(0);
  const renderingRef = useRef(false);
  const latestBlobRef = useRef(null);
  const streamingRef = useRef(false);
  const startingRef = useRef(false);
  const startingTimeoutRef = useRef(null);
  const screenshotTimeoutRef = useRef(null);
  const noticeTimeoutRef = useRef(null);

  const hasIntent = () => !!selectedDeviceId && sessionStorage.getItem(INTENT_KEY) === selectedDeviceId;
  const setIntent = () => sessionStorage.setItem(INTENT_KEY, selectedDeviceId);
  const clearIntent = () => {
    if (sessionStorage.getItem(INTENT_KEY) === selectedDeviceId) sessionStorage.removeItem(INTENT_KEY);
  };

  const showNotice = (text) => {
    setNotice(text);
    clearTimeout(noticeTimeoutRef.current);
    noticeTimeoutRef.current = setTimeout(() => setNotice(''), 5000);
  };

  // High-performance direct canvas frame renderer
  // Discards intermediate frames while rendering to guarantee absolute latest frame with zero queue delay
  const drawLatestFrame = () => {
    if (renderingRef.current || !latestBlobRef.current) return;
    const blob = latestBlobRef.current;
    latestBlobRef.current = null;
    renderingRef.current = true;

    createImageBitmap(blob)
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (canvas && streamingRef.current && Date.now() >= suppressFramesUntilRef.current) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          const ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0);
        }
        bitmap.close();
      })
      .catch(() => {
        // Suppress decode errors on rapid/aborted frames
      })
      .finally(() => {
        renderingRef.current = false;
        // If a fresher frame arrived while decoding, draw it immediately!
        if (latestBlobRef.current && Date.now() >= suppressFramesUntilRef.current) {
          drawLatestFrame();
        }
      });
  };

  const clearView = () => {
    pointerStartRef.current = null;
    latestBlobRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const setOff = () => {
    streamingRef.current = false;
    startingRef.current = false;
    setStreaming(false);
    setStreamStarting(false);
    if (startingTimeoutRef.current) clearTimeout(startingTimeoutRef.current);
    clearView();
  };

  const markStreaming = () => {
    startingRef.current = false;
    streamingRef.current = true;
    setStreamStarting(false);
    setStreaming(true);
    setStreamError('');
    if (startingTimeoutRef.current) clearTimeout(startingTimeoutRef.current);
  };

  const startStream = () => {
    if (startingRef.current || streamingRef.current) return;
    setIntent();
    setStreamError('');
    suppressFramesUntilRef.current = 0;
    startingRef.current = true;
    setStreamStarting(true);
    sendRaw({ type: 'stream_start' });

    if (startingTimeoutRef.current) clearTimeout(startingTimeoutRef.current);
    startingTimeoutRef.current = setTimeout(() => {
      if (!startingRef.current) return;
      // Give up and release our claim, so a permission granted much later
      // doesn't leave the phone sharing to nobody.
      clearIntent();
      setOff();
      sendRaw({ type: 'stream_stop' });
      setStreamError('The phone did not start sharing. Check the phone for a screen-recording permission prompt, then try again.');
    }, START_TIMEOUT_MS);
  };

  // User pressed Stop (or Cancel while starting)
  const stopStream = () => {
    clearIntent();
    setOff();
    suppressFramesUntilRef.current = Date.now() + STOP_FRAME_SUPPRESS_MS;
    sendRaw({ type: 'stream_stop' });
  };

  // The phone or our socket went away. Keep the intent so the stream resumes
  // by itself when the phone is reachable again.
  const handleLinkLost = () => {
    setOff();
  };

  // Toggle stream
  const handleToggleStream = () => {
    if (streaming || streamStarting) {
      stopStream();
    } else {
      startStream();
    }
  };

  // Listen for stream status updates and frames from phone
  useEffect(() => {
    return addListener((msg) => {
      const mine = () => streamingRef.current || startingRef.current || hasIntent();
      switch (msg.type) {
        case 'phone_connected':
          if (hasIntent()) startStream();
          break;
        case 'stream_started':
          if (mine()) markStreaming();
          break;
        case 'stream_stopped':
          if (!mine()) break;
          clearIntent();
          setOff();
          suppressFramesUntilRef.current = Date.now() + STOP_FRAME_SUPPRESS_MS;
          break;
        case 'stream_error':
          if (!mine()) break;
          clearIntent();
          setOff();
          setStreamError(STREAM_ERRORS[msg.reason] || `Screen sharing failed${msg.reason ? ` (${msg.reason})` : ''}.`);
          break;
        case 'phone_disconnected':
        case '_ws_closed':
          handleLinkLost();
          break;
        case 'device_offline':
          if (!msg.deviceId || msg.deviceId === selectedDeviceId) handleLinkLost();
          break;
        case 'screenshot_error':
          clearTimeout(screenshotTimeoutRef.current);
          setTakingScreenshot(false);
          showNotice(`Screenshot failed${msg.reason ? `: ${msg.reason}` : ''}`);
          break;
        case 'binary_frame': {
          if (msg.typeByte === 0x03) {
            const url = URL.createObjectURL(msg.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `screenshot_${Date.now()}.jpg`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            clearTimeout(screenshotTimeoutRef.current);
            setTakingScreenshot(false);
            return;
          }

          if (msg.typeByte !== 0x01) return; // Only process screen frames
          if (!streamingRef.current && !startingRef.current) return;
          if (Date.now() < suppressFramesUntilRef.current) return;
          if (!streamingRef.current) markStreaming();

          latestBlobRef.current = msg.blob;
          drawLatestFrame();
          break;
        }
        default:
          break;
      }
    });
  }, [addListener, sendRaw, selectedDeviceId]);

  // Resume on mount / phone reconnect if this tab was streaming this device
  useEffect(() => {
    if (phoneOnline && hasIntent()) startStream();
  }, [phoneOnline]);

  // Leaving the page (route change or device switch) releases the stream.
  // A refresh never runs this, so the intent survives it.
  useEffect(() => {
    return () => {
      if (startingTimeoutRef.current) clearTimeout(startingTimeoutRef.current);
      clearTimeout(screenshotTimeoutRef.current);
      clearTimeout(noticeTimeoutRef.current);
      latestBlobRef.current = null;
      if (streamingRef.current || startingRef.current) {
        streamingRef.current = false;
        startingRef.current = false;
        clearIntent();
        sendRaw({ type: 'stream_stop' });
      }
    };
  }, []);

  // Touch gesture calculations (normalized 0.0 - 1.0 of the PHONE screen).
  // The canvas uses object-fit: contain, so the frame is letterboxed inside
  // the element box — map against the drawn image, not the element.
  const getNormalizedPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const cw = canvas.width || 1;
    const ch = canvas.height || 1;
    const scale = Math.min(rect.width / cw, rect.height / ch) || 1;
    const drawnW = cw * scale;
    const drawnH = ch * scale;
    const left = rect.left + (rect.width - drawnW) / 2;
    const top = rect.top + (rect.height - drawnH) / 2;
    const x = Math.max(0, Math.min(1, (e.clientX - left) / drawnW));
    const y = Math.max(0, Math.min(1, (e.clientY - top) / drawnH));
    return { x, y };
  };

  const handlePointerDown = (e) => {
    // CRITICAL: Prevent touch actions if streaming is false
    if (!streaming) {
      pointerStartRef.current = null;
      return;
    }
    e.preventDefault();
    try {
      e.target.setPointerCapture?.(e.pointerId);
    } catch (_) {}
    const { x, y } = getNormalizedPos(e);
    pointerStartRef.current = { x, y, time: Date.now() };
  };

  const handlePointerUp = (e) => {
    // CRITICAL: Prevent touch actions if streaming is false
    if (!streaming || !pointerStartRef.current) {
      pointerStartRef.current = null;
      return;
    }
    e.preventDefault();
    const start = pointerStartRef.current;
    const end = getNormalizedPos(e);
    const duration = Date.now() - start.time;
    pointerStartRef.current = null;

    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.03) {
      if (duration > 500) {
        // A zero-distance swipe held for the press duration is a long-press.
        sendControl('swipe', {
          x1: start.x,
          y1: start.y,
          x2: start.x,
          y2: start.y,
          ms: Math.max(600, Math.min(3000, duration)),
        });
      } else {
        sendControl('tap', { x: start.x, y: start.y });
      }
    } else {
      sendControl('swipe', {
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        ms: Math.max(100, Math.min(1000, duration)),
      });
    }
  };

  const handlePointerCancel = () => {
    pointerStartRef.current = null;
  };

  const handleWheel = (e) => {
    if (!streaming) return;
    e.preventDefault();
    const { x, y } = getNormalizedPos(e);
    sendControl('scroll', { x, y, dx: e.deltaX / 1080, dy: e.deltaY / 1920 });
  };

  // Keyboard navigation & hardware buttons
  const handleKeyPress = (key) => {
    switch (key) {
      case 'back':
        sendControl('back');
        break;
      case 'home':
        sendControl('home');
        break;
      case 'recents':
        sendControl('recents');
        break;
      case 'lock':
      case 'power':
        sendControl('keyevent', { keycode: 'KEYCODE_POWER' });
        break;
      case 'volume_up':
      case 'vol_up':
        sendControl('keyevent', { keycode: 'KEYCODE_VOLUME_UP' });
        break;
      case 'volume_down':
      case 'vol_down':
        sendControl('keyevent', { keycode: 'KEYCODE_VOLUME_DOWN' });
        break;
      case 'enter':
        sendControl('keyevent', { keycode: 'KEYCODE_ENTER' });
        break;
      case 'delete':
      case 'backspace':
        sendControl('keyevent', { keycode: 'KEYCODE_DEL' });
        break;
      default:
        break;
    }
  };

  // Directional Swipe / D-Pad Navigation
  const handleSwipe = (direction) => {
    switch (direction) {
      case 'left':
        sendControl('swipe', { x1: 0.8, y1: 0.5, x2: 0.2, y2: 0.5, ms: 300 });
        break;
      case 'right':
        sendControl('swipe', { x1: 0.2, y1: 0.5, x2: 0.8, y2: 0.5, ms: 300 });
        break;
      case 'up':
        sendControl('swipe', { x1: 0.5, y1: 0.7, x2: 0.5, y2: 0.3, ms: 300 });
        break;
      case 'down':
        sendControl('swipe', { x1: 0.5, y1: 0.3, x2: 0.5, y2: 0.7, ms: 300 });
        break;
      default:
        break;
    }
  };

  const handleCenterTap = () => {
    sendControl('tap', { x: 0.5, y: 0.5 });
  };

  // Physical Keyboard Listeners (Arrow navigation + Escape/Enter)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (
        showTypeModal ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      ) {
        return;
      }
      if (!streaming) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          handleSwipe('up');
          break;
        case 'ArrowDown':
          e.preventDefault();
          handleSwipe('down');
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handleSwipe('left');
          break;
        case 'ArrowRight':
          e.preventDefault();
          handleSwipe('right');
          break;
        case 'Escape':
          e.preventDefault();
          sendControl('back');
          break;
        case 'Enter':
          e.preventDefault();
          sendControl('keyevent', { keycode: 'KEYCODE_ENTER' });
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [streaming, showTypeModal, sendControl]);

  // Type Text Handler
  const handleSendText = (e) => {
    e.preventDefault();
    if (!typeText) return;
    const action = usePaste ? 'paste' : 'text';
    sendControl(action, { value: typeText });

    if (pressSubmit) {
      setTimeout(() => {
        sendControl('keyevent', { keycode: 'KEYCODE_ENTER' });
      }, 150);
    }
    setTypeText('');
    setShowTypeModal(false);
  };

  const handleScreenshot = () => {
    if (!sendRaw({ type: 'screenshot' })) return;
    setTakingScreenshot(true);
    clearTimeout(screenshotTimeoutRef.current);
    screenshotTimeoutRef.current = setTimeout(() => {
      setTakingScreenshot(false);
      showNotice('Screenshot timed out — the phone did not respond.');
    }, 15000);
  };

  const handleRingPhone = () => {
    sendRaw({ type: 'ring' });
  };

  const handleFlash = (count) => {
    sendRaw({ type: 'flash', count });
    setShowFlashMenu(false);
  };

  if (!selectedDeviceId) {
    return (
      <div className="empty-mirror-view">
        <AlertCircle size={36} color="var(--amber)" />
        <h2>No Device Selected</h2>
        <p>Please return to the Devices tab and select an Android phone.</p>
      </div>
    );
  }

  const linkDown = wsStatus !== 'connected';
  const resuming = hasIntent() && !streaming;
  let overlayTitle;
  let overlayText;
  if (linkDown) {
    overlayTitle = 'Connection Lost';
    overlayText = resuming
      ? 'Reconnecting to the server. The stream will resume automatically.'
      : 'Reconnecting to the server…';
  } else if (!phoneOnline) {
    overlayTitle = resuming ? 'Waiting for Phone to Reconnect' : 'Waiting for Device';
    overlayText = resuming
      ? 'The stream will resume automatically when the phone is back online.'
      : 'Ensure the Phone Remote companion app is running on the device.';
  } else if (streamStarting) {
    overlayTitle = 'Starting Stream...';
    overlayText = 'Connecting to phone display. Please grant permission if prompted on the device.';
  } else {
    overlayTitle = 'Phone Connected';
    overlayText = 'Screen mirroring is ready. Press Start Streaming to view and interact.';
  }
  const controlsDisabled = !phoneOnline || linkDown;

  return (
    <div className="mirror-view-container">
      {/* Phone Screen Frame */}
      <div className="phone-display-area">
        <div className="phone-chassis">
          <canvas
            ref={canvasRef}
            className={`phone-canvas ${streaming ? 'active-stream' : 'inert-stream'}`}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onWheel={handleWheel}
          />

          {!streaming && (
            <div className="stream-overlay">
              <div className="overlay-content">
                <h3>{overlayTitle}</h3>
                <p>{overlayText}</p>
                {streamError && <p className="stream-error">{streamError}</p>}
                <button
                  className="btn primary stream-btn"
                  onClick={handleToggleStream}
                  disabled={!streamStarting && controlsDisabled}
                >
                  {streamStarting ? (
                    <span className="spinner"></span>
                  ) : (
                    <Play size={16} fill="currentColor" />
                  )}
                  <span>{streamStarting ? 'Cancel' : 'Start Streaming'}</span>
                </button>
              </div>
            </div>
          )}

          {notice && <div className="stream-notice">{notice}</div>}
        </div>
      </div>

      {/* Control Toolbar */}
      <div className="controls-sidebar">
        {/* Session Group */}
        <div className="control-group">
          <span className="group-title">Session</span>
          <button
            className={`btn ${streaming || streamStarting ? 'danger' : 'primary'} control-action-btn`}
            onClick={handleToggleStream}
            disabled={!streaming && !streamStarting && controlsDisabled}
          >
            {streaming || streamStarting ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            <span>{streaming ? 'Stop Stream' : (streamStarting ? 'Cancel Start' : 'Start Stream')}</span>
          </button>
        </div>

        {/* Navigation Group */}
        <div className="control-group">
          <span className="group-title">Navigation</span>
          <div className="nav-button-row">
            <button className="btn" title="Back" disabled={controlsDisabled} onClick={() => handleKeyPress('back')}>
              <ArrowLeft size={16} />
              <span>Back</span>
            </button>
            <button className="btn" title="Home" disabled={controlsDisabled} onClick={() => handleKeyPress('home')}>
              <Home size={16} />
              <span>Home</span>
            </button>
            <button className="btn" title="Recents" disabled={controlsDisabled} onClick={() => handleKeyPress('recents')}>
              <Layers size={16} />
              <span>Recents</span>
            </button>
          </div>
        </div>

        {/* Accessibility & D-Pad Navigation */}
        <div className="control-group">
          <span className="group-title">Accessibility & D-Pad Swiping</span>
          <div className="dpad-card">
            <div className="dpad-row">
              <button
                className="btn dpad-btn"
                title="Swipe Up / Scroll Down (Arrow Up)"
                disabled={controlsDisabled}
                onClick={() => handleSwipe('up')}
              >
                <ChevronUp size={22} />
              </button>
            </div>
            <div className="dpad-row dpad-middle">
              <button
                className="btn dpad-btn"
                title="Swipe Left (Arrow Left)"
                disabled={controlsDisabled}
                onClick={() => handleSwipe('left')}
              >
                <ChevronLeft size={22} />
              </button>
              <button
                className="btn dpad-btn dpad-center"
                title="Center Tap (Tap screen center)"
                disabled={controlsDisabled}
                onClick={handleCenterTap}
              >
                <CircleDot size={20} />
              </button>
              <button
                className="btn dpad-btn"
                title="Swipe Right (Arrow Right)"
                disabled={controlsDisabled}
                onClick={() => handleSwipe('right')}
              >
                <ChevronRight size={22} />
              </button>
            </div>
            <div className="dpad-row">
              <button
                className="btn dpad-btn"
                title="Swipe Down / Scroll Up (Arrow Down)"
                disabled={controlsDisabled}
                onClick={() => handleSwipe('down')}
              >
                <ChevronDown size={22} />
              </button>
            </div>
          </div>
        </div>

        {/* Hardware & Input Group */}
        <div className="control-group">
          <span className="group-title">Hardware & Input</span>
          <div className="action-button-grid">
            <button className="btn" disabled={controlsDisabled} onClick={() => setShowTypeModal(true)} title="Type text into phone">
              <Type size={16} />
              <span>Type Text</span>
            </button>
            <button className="btn" disabled={controlsDisabled} onClick={() => handleKeyPress('lock')} title="Lock / Power screen">
              <Power size={16} />
              <span>Lock / Power</span>
            </button>
            <button className="btn" disabled={controlsDisabled} onClick={() => handleKeyPress('volume_up')} title="Raise volume">
              <Volume2 size={16} />
              <span>Vol +</span>
            </button>
            <button className="btn" disabled={controlsDisabled} onClick={() => handleKeyPress('volume_down')} title="Lower volume">
              <Volume1 size={16} />
              <span>Vol -</span>
            </button>
          </div>
        </div>

        {/* Utilities Group */}
        <div className="control-group">
          <span className="group-title">Utilities</span>
          <div className="action-button-grid">
            <button className="btn" onClick={handleScreenshot} disabled={takingScreenshot || controlsDisabled} title="Screenshot">
              <Camera size={16} />
              <span>{takingScreenshot ? 'Capturing...' : 'Screenshot'}</span>
            </button>
            <button className="btn" disabled={controlsDisabled} onClick={handleRingPhone} title="Ring phone">
              <Bell size={16} />
              <span>Ring</span>
            </button>
            <div style={{ position: 'relative' }}>
              <button className="btn" disabled={controlsDisabled} onClick={() => setShowFlashMenu(!showFlashMenu)} style={{ width: '100%' }} title="Flash blink">
                <Zap size={16} />
                <span>Flash</span>
              </button>
              {showFlashMenu && !controlsDisabled && (
                <div style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 0,
                  right: 0,
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  padding: '4px',
                  zIndex: 20
                }}>
                  {[2, 3, 4].map((count) => (
                    <button key={count} className="btn" onClick={() => handleFlash(count)} style={{ padding: '4px 8px', fontSize: '11px' }}>
                      {count}× Blink
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Type Text Modal */}
      {showTypeModal && (
        <div className="modal-backdrop" onClick={() => setShowTypeModal(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Send Text to Phone</h3>
            <p className="modal-desc">Type below to insert text into the focused field on screen.</p>
            <form onSubmit={handleSendText}>
              <input
                type="text"
                className="input"
                autoFocus
                placeholder="Message, search query, or URL..."
                value={typeText}
                onChange={(e) => setTypeText(e.target.value)}
              />
              <div className="checkbox-options-container">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    id="pressSubmit"
                    checked={pressSubmit}
                    onChange={(e) => setPressSubmit(e.target.checked)}
                  />
                  <span>Press Enter / Submit after typing</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    id="usePaste"
                    checked={usePaste}
                    onChange={(e) => setUsePaste(e.target.checked)}
                  />
                  <span>Use Paste mode (bypasses input filters)</span>
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setShowTypeModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary">
                  Send to Phone
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .mirror-view-container {
          flex: 1;
          display: flex;
          background: #000;
          overflow: hidden;
        }
        .phone-display-area {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 18px;
        }
        .phone-chassis {
          background: #0a0a0a;
          border-radius: 36px;
          box-shadow: 0 0 0 2px #222, 0 0 0 5px #18181f, 0 30px 90px rgba(0, 0, 0, 0.9);
          aspect-ratio: 9 / 19.5;
          height: calc(100vh - 54px - 36px);
          max-height: 840px;
          position: relative;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .phone-canvas {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }
        .phone-canvas.active-stream {
          cursor: crosshair;
          touch-action: none;
          pointer-events: auto;
        }
        .phone-canvas.inert-stream {
          cursor: not-allowed;
          pointer-events: none;
        }
        .stream-overlay {
          position: absolute;
          inset: 0;
          background: rgba(10, 12, 16, 0.88);
          backdrop-filter: blur(12px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          text-align: center;
          z-index: 10;
        }
        .overlay-content h3 {
          font-size: 18px;
          color: #fff;
          margin-bottom: 8px;
        }
        .overlay-content p {
          font-size: 13px;
          color: var(--muted);
          max-width: 260px;
          margin-bottom: 20px;
          line-height: 1.5;
        }
        .stream-btn {
          width: 100%;
          padding: 10px;
          font-size: 13.5px;
        }
        .overlay-content p.stream-error {
          color: #fca5a5;
          margin-top: -10px;
        }
        .stream-notice {
          position: absolute;
          left: 50%;
          bottom: 18px;
          transform: translateX(-50%);
          z-index: 11;
          background: rgba(0, 0, 0, 0.8);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 8px 14px;
          font-size: 12.5px;
          color: #fff;
          white-space: nowrap;
        }
        .controls-sidebar {
          width: 330px;
          background: var(--bg2);
          border-left: 1px solid var(--border);
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 18px;
          overflow-y: auto;
        }
        .control-group {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .group-title {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--muted);
        }
        .control-action-btn {
          width: 100%;
          padding: 10px;
        }
        .nav-button-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }
        .action-button-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
        }
        
        /* D-Pad Styling */
        .dpad-card {
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 12px 10px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }
        .dpad-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .dpad-middle {
          width: 100%;
          justify-content: center;
        }
        .dpad-btn {
          width: 44px;
          height: 40px;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 8px;
          color: var(--text);
          transition: all 0.15s ease;
        }
        .dpad-btn:hover {
          background: var(--accent-glow);
          border-color: var(--accent);
          color: var(--accent2);
          transform: scale(1.05);
        }
        .dpad-btn:active {
          transform: scale(0.94);
        }
        .dpad-center {
          background: var(--accent-glow);
          border-color: rgba(99, 102, 241, 0.4);
          color: var(--accent2);
        }
        .dpad-center:hover {
          background: var(--accent);
          color: #fff;
        }

        .empty-mirror-view {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px;
          text-align: center;
          gap: 12px;
        }
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.65);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .modal-dialog {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 16px;
          width: 100%;
          max-width: 440px;
          padding: 24px;
          box-shadow: var(--shadow);
        }
        .modal-dialog h3 {
          font-size: 16px;
          color: #fff;
          margin-bottom: 6px;
        }
        .modal-desc {
          font-size: 12.5px;
          color: var(--muted);
          margin-bottom: 16px;
        }
        .checkbox-options-container {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin: 14px 0 18px 0;
        }
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12.5px;
          color: var(--text);
          cursor: pointer;
        }
        .checkbox-row input[type="checkbox"] {
          accent-color: var(--accent);
          width: 15px;
          height: 15px;
        }
        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }
        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid rgba(255, 255, 255, 0.3);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
      `}</style>
    </div>
  );
}
