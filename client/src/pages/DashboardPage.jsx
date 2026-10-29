import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import { Smartphone, RefreshCw, Trash2, PlusCircle, CheckCircle2, XCircle } from 'lucide-react';

function timeAgo(ms) {
  if (!ms) return 'never seen';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function DashboardPage() {
  const { api } = useAuth();
  const { devices, setSelectedDeviceId, refreshDevices } = useDevice();
  const [refreshing, setRefreshing] = useState(false);
  const navigate = useNavigate();

  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshDevices();
    setRefreshing(false);
  };

  const handleSelectDevice = (id) => {
    setSelectedDeviceId(id);
    navigate('/mirror');
  };

  const handleRemoveDevice = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm('Remove this device from your account?')) return;
    try {
      await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refreshDevices();
    } catch (err) {
      alert(`Failed to remove device: ${err.message}`);
    }
  };

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div>
          <h1 className="dashboard-title">Connected Devices</h1>
          <p className="dashboard-subtitle">Select an Android phone to start screen mirroring and remote control.</p>
        </div>
        <button className="btn" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          <span>Refresh</span>
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="empty-devices-card">
          <Smartphone size={48} className="empty-icon" />
          <h3>No Phones Linked Yet</h3>
          <p>
            Install the <strong>Phone Remote</strong> APK on your Android device and sign in with this account.
            Your device will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="devices-grid">
          {devices.map((device) => (
            <div
              key={device.id}
              className={`device-card ${device.online ? 'online' : 'offline'}`}
              onClick={() => handleSelectDevice(device.id)}
            >
              <div className="card-top">
                <div className="phone-icon-box">
                  <Smartphone size={24} />
                </div>
                <div className={`status-badge ${device.online ? 'badge-online' : 'badge-offline'}`}>
                  {device.online ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  <span>{device.online ? 'ONLINE' : 'OFFLINE'}</span>
                </div>
              </div>

              <div className="card-body">
                <h4 className="device-name">{device.name || device.model || 'Android Phone'}</h4>
                <div className="device-meta">
                  <span>{device.model || 'Unknown Model'}</span>
                  <span>•</span>
                  <span>{device.online ? 'Connected now' : timeAgo(device.last_seen)}</span>
                </div>
              </div>

              <div className="card-footer">
                <span className="action-hint">Click to control →</span>
                <button
                  className="btn-delete"
                  title="Remove device"
                  onClick={(e) => handleRemoveDevice(e, device.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .dashboard-container {
          max-width: 980px;
          margin: 0 auto;
          padding: 36px 24px;
          width: 100%;
        }
        .dashboard-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 28px;
        }
        .dashboard-title {
          font-size: 22px;
          font-weight: 700;
          color: #fff;
          letter-spacing: -0.3px;
        }
        .dashboard-subtitle {
          color: var(--muted);
          font-size: 13px;
          margin-top: 4px;
        }
        .spin {
          animation: spin 1s linear infinite;
        }
        .devices-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 18px;
        }
        .device-card {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 20px;
          cursor: pointer;
          transition: all 0.2s var(--ease);
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .device-card:hover {
          border-color: var(--accent);
          transform: translateY(-2px);
          box-shadow: 0 10px 30px rgba(99, 102, 241, 0.12);
        }
        .card-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .phone-icon-box {
          width: 44px;
          height: 44px;
          border-radius: 12px;
          background: var(--bg3);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--accent);
        }
        .status-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 20px;
          letter-spacing: 0.3px;
        }
        .badge-online {
          background: rgba(34, 197, 94, 0.15);
          color: var(--green);
          border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .badge-offline {
          background: rgba(107, 114, 128, 0.15);
          color: var(--muted);
          border: 1px solid var(--border);
        }
        .card-body {
          flex: 1;
        }
        .device-name {
          font-size: 16px;
          font-weight: 600;
          color: #fff;
          margin-bottom: 4px;
        }
        .device-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--muted);
          font-size: 12px;
        }
        .card-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-top: 12px;
          border-top: 1px solid var(--border);
        }
        .action-hint {
          font-size: 12px;
          color: var(--accent2);
          font-weight: 500;
        }
        .btn-delete {
          background: none;
          border: none;
          color: var(--muted);
          cursor: pointer;
          padding: 4px;
          border-radius: 6px;
          transition: all 0.15s ease;
        }
        .btn-delete:hover {
          color: var(--red);
          background: rgba(239, 68, 68, 0.15);
        }
        .empty-devices-card {
          border: 1px dashed var(--border);
          border-radius: 16px;
          padding: 60px 20px;
          text-align: center;
          color: var(--muted);
        }
        .empty-icon {
          color: var(--accent);
          opacity: 0.6;
          margin-bottom: 16px;
        }
        .empty-devices-card h3 {
          font-size: 18px;
          color: #fff;
          margin-bottom: 8px;
        }
        .empty-devices-card p {
          font-size: 13px;
          max-width: 440px;
          margin: 0 auto;
          line-height: 1.6;
        }
      `}</style>
    </div>
  );
}

export default DashboardPage;
