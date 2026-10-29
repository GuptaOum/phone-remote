import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import { Smartphone, Camera, Folder, MapPin, Terminal, Grid, LogOut } from 'lucide-react';

export function Header() {
  const { email, logout } = useAuth();
  const { devices, selectedDeviceId, setSelectedDeviceId, wsStatus, phoneOnline } = useDevice();

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  let statusText = 'Disconnected';
  let statusClass = 'disconnected';
  if (wsStatus === 'connected') {
    if (phoneOnline) {
      statusText = selectedDevice ? `${selectedDevice.name || 'Phone'} Connected` : 'Phone Connected';
      statusClass = 'connected';
    } else {
      statusText = 'Phone Offline';
      statusClass = 'connecting';
    }
  } else if (wsStatus === 'connecting') {
    statusText = 'Connecting...';
    statusClass = 'connecting';
  }

  return (
    <header className="app-header">
      <div className="header-brand">
        <Smartphone className="brand-icon" size={20} />
        <span className="brand-name">Phone Remote</span>
      </div>

      <nav className="header-nav">
        <NavLink to="/dashboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Grid size={16} />
          <span>Devices</span>
        </NavLink>
        <NavLink to="/mirror" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Smartphone size={16} />
          <span>Mirror</span>
        </NavLink>
        <NavLink to="/camera" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Camera size={16} />
          <span>Camera</span>
        </NavLink>
        <NavLink to="/files" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Folder size={16} />
          <span>Files</span>
        </NavLink>
        <NavLink to="/location" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <MapPin size={16} />
          <span>Location</span>
        </NavLink>
        <NavLink to="/mcp-test" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
          <Terminal size={16} />
          <span>MCP Test</span>
        </NavLink>
      </nav>

      <div className="header-actions">
        {devices.length > 1 && (
          <select
            className="device-select"
            value={selectedDeviceId}
            onChange={(e) => setSelectedDeviceId(e.target.value)}
          >
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name || d.model || 'Device'} ({d.online ? 'Online' : 'Offline'})
              </option>
            ))}
          </select>
        )}

        <div className="status-indicator" title={statusText}>
          <span className={`status-dot ${statusClass}`}></span>
          <span className="status-label">{statusText}</span>
        </div>

        <span className="user-email">{email}</span>

        <button className="btn danger btn-sm" onClick={logout} title="Log Out">
          <LogOut size={14} />
          <span>Exit</span>
        </button>
      </div>

      <style>{`
        .app-header {
          background: var(--bg2);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
          height: 54px;
          padding: 0 18px;
          flex-shrink: 0;
          gap: 16px;
        }
        .header-brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 15px;
          letter-spacing: -0.2px;
          color: #fff;
        }
        .brand-icon {
          color: var(--accent);
        }
        .header-nav {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .nav-item {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--muted);
          text-decoration: none;
          font-size: 13px;
          font-weight: 500;
          padding: 6px 12px;
          border-radius: 8px;
          transition: all 0.15s ease;
        }
        .nav-item:hover {
          color: var(--text);
          background: var(--bg3);
        }
        .nav-item.active {
          color: #fff;
          background: var(--bg3);
          border: 1px solid var(--border);
        }
        .header-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .device-select {
          background: var(--bg3);
          border: 1px solid var(--border);
          color: var(--text);
          font-size: 12px;
          padding: 4px 8px;
          border-radius: 6px;
          outline: none;
        }
        .status-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg3);
          padding: 4px 10px;
          border-radius: 20px;
          border: 1px solid var(--border);
          font-size: 11.5px;
          color: var(--muted);
        }
        .user-email {
          color: var(--muted);
          font-size: 12px;
        }
        .btn-sm {
          padding: 5px 10px;
          font-size: 12px;
        }
      `}</style>
    </header>
  );
}
