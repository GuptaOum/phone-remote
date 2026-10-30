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
  Compass,
} from 'lucide-react';

export default function MirrorPage() {
  const {
    selectedDeviceId,
    phoneOnline,
    latestFrame,
    clearLatestFrame,
    sendControl,
    sendRaw,
    addListener,
  } = useDevice();

  const [streaming, setStreaming] = useState(() => sessionStorage.getItem('pr_streaming') === 'true');
  const [streamStarting, setStreamStarting] = useState(false);
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [pressSubmit, setPressSubmit] = useState(false);
  const [usePaste, setUsePaste] = useState(false);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [showFlashMenu, setShowFlashMenu] = useState(false);

  const canvasRef = useRef(null);
  const pointerStartRef = useRef(null);
  const suppressFramesUntilRef = useRef(0);

  // Stop stream helper that thoroughly cuts off frames, clears canvas, and disables touches
  const stopStream = () => {
    setStreaming(false);
    setStreamStarting(false);
    sessionStorage.removeItem('pr_streaming');
    suppressFramesUntilRef.current = Date.now() + 4000;
    pointerStartRef.current = null;

    if (clearLatestFrame) clearLatestFrame();

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    sendRaw({ type: 'stream_stop' });
  };

  const startStream = () => {
    suppressFramesUntilRef.current = 0;
    setStreamStarting(true);
    sendRaw({ type: 'stream_start' });
  };

  // Toggle stream
  const handleToggleStream = () => {
    if (streaming) {
      stopStream();
    } else {
      startStream();
    }
  };

  // Listen for stream status updates and frames from phone
  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'phone_connected') {
        if (sessionStorage.getItem('pr_streaming') === 'true') {
          sendRaw({ type: 'stream_start' });
        }
      } else if (msg.type === 'stream_stopped') {
        setStreaming(false);
        setStreamStarting(false);
        sessionStorage.removeItem('pr_streaming');
        suppressFramesUntilRef.current = Date.now() + 4000;
        pointerStartRef.current = null;
        if (clearLatestFrame) clearLatestFrame();
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      } else if (msg.type === 'phone_disconnected') {
        stopStream();
      } else if (msg.type === 'offer') {
        setStreaming(true);
        setStreamStarting(false);
        sessionStorage.setItem('pr_streaming', 'true');
      } else if (msg.type === 'binary_frame' && msg.typeByte === 0x03) {
        const url = URL.createObjectURL(msg.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `screenshot_${Date.now()}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
        setTakingScreenshot(false);
      }
    });
  }, [addListener, sendRaw, clearLatestFrame]);

  // Draw incoming JPEG frames to canvas
  useEffect(() => {
    if (!latestFrame || !canvasRef.current) return;
    if (Date.now() < suppressFramesUntilRef.current) return;
    // If user has stopped streaming, do not draw stale frames
    if (!streaming && sessionStorage.getItem('pr_streaming') !== 'true') return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      if (Date.now() < suppressFramesUntilRef.current) return;
      canvas.width = img.naturalWidth || 1080;
      canvas.height = img.naturalHeight || 1920;
      ctx.drawImage(img, 0, 0);
      setStreaming(true);
      setStreamStarting(false);
      sessionStorage.setItem('pr_streaming', 'true');
    };
    img.src = latestFrame;
  }, [latestFrame, streaming]);

  // Touch gesture calculations (normalized 0.0 - 1.0)
  const getNormalizedPos = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  };

  const handlePointerDown = (e) => {
    // CRITICAL: Prevent touch actions if streaming is false
    if (!streaming) {
      pointerStartRef.current = null;
      return;
    }
    e.preventDefault();
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
        sendControl('long_press', { x: start.x, y: start.y, ms: duration });
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
    setTakingScreenshot(true);
    sendRaw({ type: 'screenshot' });
    setTimeout(() => setTakingScreenshot(false), 6000);
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
          />

          {!streaming && (
            <div className="stream-overlay">
              <div className="overlay-content">
                <h3>{phoneOnline ? 'Phone Connected' : 'Waiting for Device'}</h3>
                <p>
                  {phoneOnline
                    ? 'Screen mirroring is ready. Press Start Streaming to view and interact.'
                    : 'Ensure the Phone Remote companion app is running on the device.'}
                </p>
                <button
                  className="btn primary stream-btn"
                  onClick={handleToggleStream}
                  disabled={!phoneOnline || streamStarting}
                >
                  {streamStarting ? (
                    <span className="spinner"></span>
                  ) : (
                    <Play size={16} fill="currentColor" />
                  )}
                  <span>{streamStarting ? 'Starting stream...' : 'Start Streaming'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Control Toolbar */}
      <div className="controls-sidebar">
        {/* Session Group */}
        <div className="control-group">
          <span className="group-title">Session</span>
          <button
            className={`btn ${streaming ? 'danger' : 'primary'} control-action-btn`}
            onClick={handleToggleStream}
            disabled={!phoneOnline}
          >
            {streaming ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            <span>{streaming ? 'Stop Stream' : 'Start Stream'}</span>
          </button>
        </div>

        {/* Navigation Group */}
        <div className="control-group">
          <span className="group-title">Navigation</span>
          <div className="nav-button-row">
            <button className="btn" title="Back" onClick={() => handleKeyPress('back')}>
              <ArrowLeft size={16} />
              <span>Back</span>
            </button>
            <button className="btn" title="Home" onClick={() => handleKeyPress('home')}>
              <Home size={16} />
              <span>Home</span>
            </button>
            <button className="btn" title="Recents" onClick={() => handleKeyPress('recents')}>
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
                onClick={() => handleSwipe('up')}
              >
                <ChevronUp size={22} />
              </button>
            </div>
            <div className="dpad-row dpad-middle">
              <button
                className="btn dpad-btn"
                title="Swipe Left (Arrow Left)"
                onClick={() => handleSwipe('left')}
              >
                <ChevronLeft size={22} />
              </button>
              <button
                className="btn dpad-btn dpad-center"
                title="Center Tap (Tap screen center)"
                onClick={handleCenterTap}
              >
                <CircleDot size={20} />
              </button>
              <button
                className="btn dpad-btn"
                title="Swipe Right (Arrow Right)"
                onClick={() => handleSwipe('right')}
              >
                <ChevronRight size={22} />
              </button>
            </div>
            <div className="dpad-row">
              <button
                className="btn dpad-btn"
                title="Swipe Down / Scroll Up (Arrow Down)"
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
            <button className="btn" onClick={() => setShowTypeModal(true)} title="Type text into phone">
              <Type size={16} />
              <span>Type Text</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('lock')} title="Lock / Power screen">
              <Power size={16} />
              <span>Lock / Power</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('volume_up')} title="Raise volume">
              <Volume2 size={16} />
              <span>Vol +</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('volume_down')} title="Lower volume">
              <Volume1 size={16} />
              <span>Vol -</span>
            </button>
          </div>
        </div>

        {/* Utilities Group */}
        <div className="control-group">
          <span className="group-title">Utilities</span>
          <div className="action-button-grid">
            <button className="btn" onClick={handleScreenshot} disabled={takingScreenshot} title="Screenshot">
              <Camera size={16} />
              <span>{takingScreenshot ? 'Capturing...' : 'Screenshot'}</span>
            </button>
            <button className="btn" onClick={handleRingPhone} title="Ring phone">
              <Bell size={16} />
              <span>Ring</span>
            </button>
            <div style={{ position: 'relative' }}>
              <button className="btn" onClick={() => setShowFlashMenu(!showFlashMenu)} style={{ width: '100%' }} title="Flash blink">
                <Zap size={16} />
                <span>Flash</span>
              </button>
              {showFlashMenu && (
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
