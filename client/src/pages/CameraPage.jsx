import React, { useState, useEffect, useRef } from 'react';
import { useDevice } from '../context/DeviceContext';
import { Camera, SwitchCamera, Play, Square, AlertCircle, Info } from 'lucide-react';

export default function CameraPage() {
  const { selectedDeviceId, phoneOnline, sendRaw, addListener } = useDevice();
  const [live, setLive] = useState(false);
  const [isFront, setIsFront] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  
  const canvasRef = useRef(null);
  const isFrontRef = useRef(true);
  const suppressFramesUntilRef = useRef(0);

  useEffect(() => {
    isFrontRef.current = isFront;
  }, [isFront]);

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'camera_streaming') {
        setLive(true);
        setErrorMessage('');
      } else if (msg.type === 'camera_stopped') {
        setLive(false);
      } else if (msg.type === 'camera_error') {
        setLive(false);
        setErrorMessage(
          'Camera permission off. On the phone: Settings → Apps → Phone Remote → enable Camera permission.'
        );
      } else if (msg.type === 'phone_disconnected') {
        setLive(false);
      } else if (msg.type === 'binary_frame') {
        if (msg.typeByte !== 0x02) return; // Only process camera frames
        if (Date.now() < suppressFramesUntilRef.current) return;

        setLive(true);
        createImageBitmap(msg.blob).then((bitmap) => {
          const canvas = canvasRef.current;
          if (!canvas) {
            bitmap.close();
            return;
          }
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
          bitmap.close();
        }).catch((err) => {
          console.error('Frame decode error:', err);
        });
      }
    });
  }, [addListener]);

  const handleStartCamera = (front) => {
    suppressFramesUntilRef.current = 0;
    setIsFront(front);
    isFrontRef.current = front;
    sendRaw({ type: 'camera_start', front });
  };

  const handleFlipCamera = () => {
    const nextFront = !isFront;
    setIsFront(nextFront);
    isFrontRef.current = nextFront;
    sendRaw({ type: 'camera_flip' });
  };

  const handleStopCamera = () => {
    sendRaw({ type: 'camera_stop' });
    setLive(false);
    suppressFramesUntilRef.current = Date.now() + 4000;
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

  return (
    <div className="camera-main">
      <div className="cam-badge">
        <div className={`cam-dot ${live ? 'live' : 'off'}`} />
        <span className="cam-label">{live ? 'Live' : 'Camera off'}</span>
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
            Camera ready — select front or back.<br />
            <small>Works even when phone screen is off.</small>
          </div>
        </div>
      )}

      <div className="cam-controls">
        <button
          className="btn primary"
          onClick={() => handleStartCamera(true)}
          disabled={!phoneOnline}
        >
          <Play size={14} fill="currentColor" />
          <span>Front</span>
        </button>
        <button
          className="btn primary"
          onClick={() => handleStartCamera(false)}
          disabled={!phoneOnline}
        >
          <Play size={14} fill="currentColor" />
          <span>Back</span>
        </button>
        <button
          className="btn"
          onClick={handleFlipCamera}
          disabled={!live || !phoneOnline}
        >
          <SwitchCamera size={14} />
          <span>Flip</span>
        </button>
        <button
          className="btn danger"
          onClick={handleStopCamera}
          disabled={!live}
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
