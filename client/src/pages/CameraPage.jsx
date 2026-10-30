import React, { useState, useEffect, useRef } from 'react';
import { useDevice } from '../context/DeviceContext';
import { Camera, SwitchCamera, Play, Square, AlertCircle } from 'lucide-react';

// sessionStorage: { deviceId, front } of the camera this tab has open, so a
// refresh re-attaches to it instead of leaving it running unseen.
const INTENT_KEY = 'pr_camera';
const START_TIMEOUT_MS = 15000;

function readIntent(deviceId) {
  try {
    const v = JSON.parse(sessionStorage.getItem(INTENT_KEY) || 'null');
    return v && v.deviceId === deviceId ? v : null;
  } catch {
    return null;
  }
}

export default function CameraPage() {
  const { selectedDeviceId, phoneOnline, wsStatus, sendRaw, addListener } = useDevice();
  const [live, setLive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [isFront, setIsFront] = useState(() => readIntent(selectedDeviceId)?.front ?? true);
  const [errorMessage, setErrorMessage] = useState('');

  const canvasRef = useRef(null);
  const isFrontRef = useRef(isFront);
  const suppressFramesUntilRef = useRef(0);
  const liveRef = useRef(false);
  const startingRef = useRef(false);
  const startTimeoutRef = useRef(null);
  const renderingRef = useRef(false);
  const latestBlobRef = useRef(null);

  const setIntent = (front) =>
    sessionStorage.setItem(INTENT_KEY, JSON.stringify({ deviceId: selectedDeviceId, front }));
  const clearIntent = () => {
    if (readIntent(selectedDeviceId)) sessionStorage.removeItem(INTENT_KEY);
  };

  const applyFront = (front) => {
    isFrontRef.current = front;
    setIsFront(front);
  };

  const setOff = () => {
    liveRef.current = false;
    startingRef.current = false;
    setLive(false);
    setStarting(false);
    clearTimeout(startTimeoutRef.current);
    latestBlobRef.current = null;
  };

  const markLive = () => {
    startingRef.current = false;
    liveRef.current = true;
    setStarting(false);
    setLive(true);
    setErrorMessage('');
    clearTimeout(startTimeoutRef.current);
  };

  // Only the newest frame is decoded; frames that arrive mid-decode replace
  // each other instead of piling up.
  const drawLatestFrame = () => {
    if (renderingRef.current || !latestBlobRef.current) return;
    const blob = latestBlobRef.current;
    latestBlobRef.current = null;
    renderingRef.current = true;
    createImageBitmap(blob)
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (canvas && liveRef.current) {
          const ctx = canvas.getContext('2d');
          canvas.width = bitmap.height;
          canvas.height = bitmap.width;
          ctx.save();
          if (isFrontRef.current) {
            ctx.translate(0, bitmap.width);
            ctx.rotate(-Math.PI / 2);
          } else {
            ctx.translate(bitmap.height, 0);
            ctx.rotate(Math.PI / 2);
          }
          ctx.drawImage(bitmap, 0, 0);
          ctx.restore();
        }
        bitmap.close();
      })
      .catch(() => {})
      .finally(() => {
        renderingRef.current = false;
        if (latestBlobRef.current) drawLatestFrame();
      });
  };

  const startCamera = (front) => {
    if (startingRef.current) return;
    suppressFramesUntilRef.current = 0;
    applyFront(front);
    setIntent(front);
    setErrorMessage('');
    startingRef.current = true;
    setStarting(true);
    sendRaw({ type: 'camera_start', front });
    clearTimeout(startTimeoutRef.current);
    startTimeoutRef.current = setTimeout(() => {
      if (!startingRef.current || liveRef.current) return;
      clearIntent();
      setOff();
      sendRaw({ type: 'camera_stop' });
      setErrorMessage('The phone did not start the camera. Check that the app is running and has camera permission.');
    }, START_TIMEOUT_MS);
  };

  useEffect(() => {
    return addListener((msg) => {
      const mine = () => liveRef.current || startingRef.current || !!readIntent(selectedDeviceId);
      switch (msg.type) {
        case 'phone_connected': {
          const intent = readIntent(selectedDeviceId);
          if (intent && !liveRef.current) startCamera(intent.front);
          break;
        }
        case 'camera_streaming':
          if (!mine()) break;
          if (typeof msg.front === 'boolean') {
            applyFront(msg.front);
            setIntent(msg.front);
          }
          markLive();
          break;
        case 'camera_stopped':
          if (!mine()) break;
          clearIntent();
          setOff();
          break;
        case 'camera_error':
          if (!mine()) break;
          clearIntent();
          setOff();
          setErrorMessage(
            msg.reason === 'phone_offline'
              ? 'The phone is offline.'
              : 'Camera permission off. On the phone: Settings → Apps → Phone Remote → enable Camera permission.'
          );
          break;
        case 'phone_disconnected':
        case '_ws_closed':
          // Keep the intent: the camera is re-requested when the phone is back.
          setOff();
          break;
        case 'device_offline':
          if (!msg.deviceId || msg.deviceId === selectedDeviceId) setOff();
          break;
        case 'binary_frame':
          if (msg.typeByte !== 0x02) return; // Only process camera frames
          if (!liveRef.current && !startingRef.current) return;
          if (Date.now() < suppressFramesUntilRef.current) return;
          if (!liveRef.current) markLive();
          latestBlobRef.current = msg.blob;
          drawLatestFrame();
          break;
        default:
          break;
      }
    });
  }, [addListener, sendRaw, selectedDeviceId]);

  // Re-attach after a refresh / phone reconnect if this tab had the camera open
  useEffect(() => {
    if (!phoneOnline) return;
    const intent = readIntent(selectedDeviceId);
    if (intent && !liveRef.current) startCamera(intent.front);
  }, [phoneOnline]);

  // Leaving the page releases the camera (a refresh doesn't run this).
  useEffect(() => {
    return () => {
      clearTimeout(startTimeoutRef.current);
      latestBlobRef.current = null;
      if (liveRef.current || startingRef.current) {
        liveRef.current = false;
        startingRef.current = false;
        clearIntent();
        sendRaw({ type: 'camera_stop' });
      }
    };
  }, []);

  const handleFlipCamera = () => {
    const nextFront = !isFront;
    applyFront(nextFront);
    setIntent(nextFront);
    sendRaw({ type: 'camera_flip' });
  };

  const handleStopCamera = () => {
    clearIntent();
    setOff();
    suppressFramesUntilRef.current = Date.now() + 1500;
    sendRaw({ type: 'camera_stop' });
  };

  if (!selectedDeviceId) {
    return (
      <div className="empty-camera-view">
        <AlertCircle size={36} color="var(--amber)" />
        <h2>No Device Selected</h2>
        <p>Please return to the Devices tab and select an Android phone.</p>
        <style>{`
          .empty-camera-view {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 12px;
            color: var(--muted);
          }
        `}</style>
      </div>
    );
  }

  const canControl = phoneOnline && wsStatus === 'connected';
  const waitingToResume = !live && !starting && !!readIntent(selectedDeviceId);

  return (
    <div className="camera-main">
      <div className="cam-badge">
        <div className={`cam-dot ${live ? 'live' : 'off'}`} />
        <span className="cam-label">
          {live ? 'Live' : starting ? 'Starting…' : waitingToResume ? 'Reconnecting…' : 'Camera off'}
        </span>
      </div>

      {errorMessage && (
        <div className="alert-banner" onClick={() => setErrorMessage('')}>
          <AlertCircle size={15} />
          <span>{errorMessage}</span>
        </div>
      )}

      <canvas
        ref={canvasRef}
        className="cam-canvas"
        style={{ display: live ? 'block' : 'none' }}
      />

      {!live && (
        <div className="cam-placeholder">
          <div className="cam-icon">
            <Camera size={30} />
          </div>
          <div>
            {starting
              ? 'Starting camera…'
              : waitingToResume
                ? 'Waiting for the phone — the camera will resume automatically.'
                : 'Camera ready — select front or back.'}
            <br />
            <small>Works even when phone screen is off.</small>
          </div>
        </div>
      )}

      <div className="cam-controls">
        <button
          className="btn primary"
          onClick={() => startCamera(true)}
          disabled={!canControl || starting || (live && isFront)}
        >
          <Play size={14} fill="currentColor" />
          <span>Front</span>
        </button>
        <button
          className="btn primary"
          onClick={() => startCamera(false)}
          disabled={!canControl || starting || (live && !isFront)}
        >
          <Play size={14} fill="currentColor" />
          <span>Back</span>
        </button>
        <button
          className="btn"
          onClick={handleFlipCamera}
          disabled={!live || !canControl}
        >
          <SwitchCamera size={14} />
          <span>Flip</span>
        </button>
        <button
          className="btn danger"
          onClick={handleStopCamera}
          disabled={!live && !starting && !waitingToResume}
        >
          <Square size={14} fill="currentColor" />
          <span>Stop</span>
        </button>
      </div>

      <style>{`
        .camera-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 18px;
          background: radial-gradient(ellipse at center, #0f1018 0%, #0a0c10 100%);
          position: relative;
          overflow: hidden;
          padding: 20px;
        }

        .cam-badge {
          position: absolute;
          top: 14px;
          left: 14px;
          z-index: 10;
          background: rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 20px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 12px;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
        }

        .cam-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          transition: background 0.3s, box-shadow 0.3s;
        }
        .cam-dot.live {
          background: var(--green);
          box-shadow: 0 0 6px #22c55e88;
          animation: pulse 1.5s ease-in-out infinite;
        }
        .cam-dot.off {
          background: var(--red);
        }

        .cam-label {
          color: #9ca3af;
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.3px;
        }

        .cam-canvas {
          object-fit: contain;
          border-radius: 16px;
          max-width: 90vw;
          max-height: calc(95vh - 120px);
          box-shadow: 0 8px 48px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.05);
        }

        .cam-placeholder {
          color: var(--muted);
          font-size: 13.5px;
          line-height: 1.9;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 10px;
        }

        .cam-placeholder .cam-icon {
          width: 56px;
          height: 56px;
          border-radius: 18px;
          background: var(--bg3);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          margin-bottom: 4px;
        }

        .cam-placeholder small {
          color: #4b5563;
          font-size: 12px;
        }

        .cam-controls {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 8px;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 6px 8px;
          z-index: 10;
        }

        .alert-banner {
          position: absolute;
          top: 14px;
          right: 14px;
          z-index: 100;
          background: #ef44441a;
          border: 1px solid #ef444455;
          color: #fca5a5;
          border-radius: 10px;
          padding: 8px 14px;
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12.5px;
          cursor: pointer;
          backdrop-filter: blur(8px);
        }
      `}</style>
    </div>
  );
}
