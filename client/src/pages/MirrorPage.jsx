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
} from 'lucide-react';

export default function MirrorPage() {
  const { selectedDeviceId, phoneOnline, latestFrame, sendControl, sendRaw, addListener } = useDevice();
  const [streaming, setStreaming] = useState(() => sessionStorage.getItem('pr_streaming') === 'true');
  const [streamStarting, setStreamStarting] = useState(false);
  const [showTypeModal, setShowTypeModal] = useState(false);
  const [typeText, setTypeText] = useState('');
  const [pressSubmit, setPressSubmit] = useState(false);
  const [takingScreenshot, setTakingScreenshot] = useState(false);
  const [showFlashMenu, setShowFlashMenu] = useState(false);

  const canvasRef = useRef(null);
  const pointerStartRef = useRef(null);
  const typeDialogRef = useRef(null);

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
  }, [addListener, sendRaw]);

  // Draw incoming JPEG frames to canvas
  useEffect(() => {
    if (!latestFrame || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth || 1080;
      canvas.height = img.naturalHeight || 1920;
      ctx.drawImage(img, 0, 0);
      setStreaming(true);
      setStreamStarting(false);
      sessionStorage.setItem('pr_streaming', 'true');
    };
    img.src = latestFrame;
  }, [latestFrame]);

  // Start or stop streaming
  const handleToggleStream = () => {
    if (streaming) {
      setStreaming(false);
      sessionStorage.removeItem('pr_streaming');
      sendRaw({ type: 'stream_stop' });
    } else {
      setStreamStarting(true);
      sendRaw({ type: 'stream_start' });
    }
  };

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
    if (!streaming) return;
    const { x, y } = getNormalizedPos(e);
    pointerStartRef.current = { x, y, time: Date.now() };
  };

  const handlePointerUp = (e) => {
    if (!streaming || !pointerStartRef.current) return;
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

  const handleSendText = (e) => {
    e.preventDefault();
    if (!typeText) return;
    sendControl('type_text', { text: typeText, submit: pressSubmit, method: 'set' });
    setTypeText('');
    setShowTypeModal(false);
  };

  const handleKeyPress = (key) => {
    sendControl('press_key', { key });
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
            className="phone-canvas"
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
          />

          {!streaming && (
            <div className="stream-overlay">
              <div className="overlay-content">
                <h3>{phoneOnline ? 'Phone Connected' : 'Waiting for Device'}</h3>
                <p>
                  {phoneOnline
                    ? 'Screen mirroring is ready. Press Start to stream the screen.'
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

        <div className="control-group">
          <span className="group-title">Hardware & Input</span>
          <div className="action-button-grid">
            <button className="btn" onClick={() => setShowTypeModal(true)}>
              <Type size={16} />
              <span>Type Text</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('lock')}>
              <Power size={16} />
              <span>Lock / Power</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('volume_up')}>
              <Volume2 size={16} />
              <span>Vol +</span>
            </button>
            <button className="btn" onClick={() => handleKeyPress('volume_down')}>
              <Volume1 size={16} />
              <span>Vol -</span>
            </button>
          </div>
        </div>

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
              <div className="checkbox-row">
                <input
                  type="checkbox"
                  id="pressSubmit"
                  checked={pressSubmit}
                  onChange={(e) => setPressSubmit(e.target.checked)}
                />
                <label htmlFor="pressSubmit">Press Enter / Submit after typing</label>
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
          cursor: crosshair;
          touch-action: none;
        }
        .stream-overlay {
          position: absolute;
          inset: 0;
          background: rgba(10, 12, 16, 0.85);
          backdrop-filter: blur(10px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          text-align: center;
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
          width: 320px;
          background: var(--bg2);
          border-left: 1px solid var(--border);
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .control-group {
          display: flex;
          flex-direction: column;
          gap: 10px;
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
          background: rgba(0, 0, 0, 0.6);
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
          max-width: 420px;
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
        .checkbox-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--muted);
          margin: 12px 0 18px 0;
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
