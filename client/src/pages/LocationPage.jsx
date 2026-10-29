import React, { useState, useEffect, useRef } from 'react';
import { useDevice } from '../context/DeviceContext';
import { MapPin, ExternalLink, AlertCircle } from 'lucide-react';

export default function LocationPage() {
  const { selectedDeviceId, addListener } = useDevice();
  const [locData, setLocData] = useState(null);

  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);

  // Initialize Leaflet map
  useEffect(() => {
    if (!mapContainerRef.current) return;
    const L = window.L;
    if (!L) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([20, 0], 2);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(map);
      mapInstanceRef.current = map;
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markerRef.current = null;
        circleRef.current = null;
      }
    };
  }, []);

  // Handle incoming location events from phone
  useEffect(() => {
    return addListener((msg) => {
      const L = window.L;
      if (!L || !mapInstanceRef.current) return;

      if (msg.type === 'location') {
        const lat = msg.lat;
        const lng = msg.lng;
        const latlng = [lat, lng];
        setLocData(msg);

        const phoneIcon = L.divIcon({
          html: '<div style="font-size:28px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))">📍</div>',
          iconSize: [32, 32],
          iconAnchor: [16, 28],
          className: '',
        });

        if (!markerRef.current) {
          mapInstanceRef.current.setView(latlng, 15);
          markerRef.current = L.marker(latlng, { icon: phoneIcon })
            .addTo(mapInstanceRef.current)
            .bindPopup('Phone is here')
            .openPopup();
        } else {
          markerRef.current.setLatLng(latlng);
          mapInstanceRef.current.panTo(latlng);
        }

        if (circleRef.current) {
          circleRef.current.remove();
          circleRef.current = null;
        }

        if (msg.accuracy) {
          circleRef.current = L.circle(latlng, {
            radius: msg.accuracy,
            color: '#6366f1',
            fillOpacity: 0.1,
            weight: 1.5,
          }).addTo(mapInstanceRef.current);
        }
      } else if (msg.type === 'phone_disconnected') {
        setLocData(null);
        if (markerRef.current) {
          markerRef.current.remove();
          markerRef.current = null;
        }
        if (circleRef.current) {
          circleRef.current.remove();
          circleRef.current = null;
        }
        if (mapInstanceRef.current) {
          mapInstanceRef.current.setView([20, 0], 2);
        }
      }
    });
  }, [addListener]);

  if (!selectedDeviceId) {
    return (
      <div className="empty-location-view">
        <AlertCircle size={36} color="var(--amber)" />
        <h2>No Device Selected</h2>
        <p>Please return to the Devices tab and select an Android phone.</p>
        <style>{`
          .empty-location-view {
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
    <div className="location-main">
      <div className="loc-map-wrap">
        {!locData && (
          <div className="loc-waiting">
            <div className="loc-wait-icon">
              <MapPin size={32} />
            </div>
            <div>
              Waiting for location...<br />
              <small>Grant location permission on the phone.</small>
            </div>
          </div>
        )}
        <div id="loc-map" ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {locData && (
        <div className="loc-bar visible">
          <div className="loc-live">
            <div className="loc-live-dot" />
            <span className="loc-live-label">LIVE</span>
          </div>

          <span className="loc-stat">
            Lat: <span>{locData.lat ? locData.lat.toFixed(6) : '—'}</span>
          </span>

          <span className="loc-stat">
            Lng: <span>{locData.lng ? locData.lng.toFixed(6) : '—'}</span>
          </span>

          {locData.accuracy != null && (
            <span className="loc-stat">
              Accuracy: <span>{Math.round(locData.accuracy)}</span> m
            </span>
          )}

          {locData.altitude != null && (
            <span className="loc-stat">
              Alt: <span>{Math.round(locData.altitude)}</span> m
            </span>
          )}

          {locData.timestamp && (
            <span className="loc-stat" style={{ marginLeft: 'auto' }}>
              Updated {new Date(locData.timestamp).toLocaleTimeString()}
            </span>
          )}

          <a
            className="loc-maps-btn"
            href={`https://www.google.com/maps?q=${locData.lat},${locData.lng}`}
            target="_blank"
            rel="noreferrer"
          >
            <span>Google Maps</span>
            <ExternalLink size={12} />
          </a>
        </div>
      )}

      <style>{`
        .location-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .loc-map-wrap {
          flex: 1;
          min-height: 0;
          background: #1a1a2e;
          position: relative;
        }

        .loc-waiting {
          position: absolute;
          inset: 0;
          z-index: 1000;
          background: var(--bg);
          color: var(--muted);
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 14px;
          font-size: 13.5px;
          text-align: center;
          line-height: 1.7;
        }

        .loc-wait-icon {
          width: 64px;
          height: 64px;
          border-radius: 20px;
          background: var(--bg3);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
          margin-bottom: 4px;
        }

        .loc-waiting small {
          color: #4b5563;
          font-size: 12px;
        }

        .loc-bar {
          background: var(--bg2);
          border-top: 1px solid var(--border);
          flex-shrink: 0;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 10px;
          padding: 8px 16px;
        }

        .loc-live {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .loc-live-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--green);
          box-shadow: 0 0 6px #22c55e88;
          animation: pulse 1.5s ease-in-out infinite;
        }

        .loc-live-label {
          color: var(--green);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.5px;
        }

        .loc-stat {
          color: var(--muted);
          font-size: 11.5px;
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 3px 9px;
        }
        .loc-stat span {
          color: var(--text);
          font-weight: 500;
        }

        .loc-maps-btn {
          margin-left: auto;
          flex-shrink: 0;
          background: linear-gradient(135deg, var(--accent), #7c3aed);
          border-radius: 8px;
          color: #fff;
          font-size: 12px;
          font-weight: 600;
          padding: 5px 14px;
          text-decoration: none;
          box-shadow: 0 2px 10px #6366f130;
          transition: all 0.18s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .loc-maps-btn:hover {
          filter: brightness(1.12);
          box-shadow: 0 4px 16px #6366f144;
        }
      `}</style>
    </div>
  );
}
