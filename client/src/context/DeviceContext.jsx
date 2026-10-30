import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext';

const DeviceContext = createContext(null);

// The server answers {type:'ping'} with a pong and streams frames constantly,
// so a socket that has been silent this long is half-open (sleep, NAT drop).
const PING_INTERVAL_MS = 15000;
const SILENT_SOCKET_MS = 40000;
const RECONNECT_DELAY_MS = 2500;

export function DeviceProvider({ children }) {
  const { token, api, logout } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    // Check URL param first, then localStorage
    const params = new URLSearchParams(window.location.search);
    return params.get('device') || localStorage.getItem('pr_device') || '';
  });
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [phoneOnline, setPhoneOnline] = useState(false);
  const [screenSize, setScreenSize] = useState({ width: 1080, height: 1920 });
  const [lastLocation, setLastLocation] = useState(null);

  const socketRef = useRef(null);
  const listenersRef = useRef(new Set());
  const logoutRef = useRef(logout);
  logoutRef.current = logout;

  // Save selected device in localStorage & update URL if needed
  useEffect(() => {
    if (selectedDeviceId) {
      localStorage.setItem('pr_device', selectedDeviceId);
    } else {
      localStorage.removeItem('pr_device');
    }
  }, [selectedDeviceId]);

  const emit = useCallback((msg) => {
    listenersRef.current.forEach((fn) => fn(msg));
  }, []);

  // Fetch devices list
  const refreshDevices = useCallback(async () => {
    if (!token) return [];
    try {
      const res = await api('/api/devices');
      const data = await res.json();
      const list = data.devices || [];
      setDevices(list);

      // Select the first device when nothing is selected, or when the
      // selected one was removed from the account.
      if (!selectedDeviceId || !list.some((d) => d.id === selectedDeviceId)) {
        setSelectedDeviceId(list.length > 0 ? list[0].id : '');
      }
      return list;
    } catch (e) {
      console.error('Error fetching devices:', e);
      return [];
    }
  }, [token, api, selectedDeviceId]);

  // Initial fetch and poll
  useEffect(() => {
    if (token) {
      refreshDevices();
      const interval = setInterval(refreshDevices, 8000);
      return () => clearInterval(interval);
    }
  }, [token, refreshDevices]);

  // WebSocket Manager
  useEffect(() => {
    // Nothing known about a newly selected device until its socket says so.
    setPhoneOnline(false);
    setLastLocation(null);

    if (!token || !selectedDeviceId) {
      setWsStatus('disconnected');
      return;
    }

    let active = true;
    let reconnectTimeout = null;
    let pingInterval = null;
    let lastMessageAt = Date.now();

    const scheduleReconnect = () => {
      if (!active || reconnectTimeout) return;
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = () => {
      if (!active) return;
      setWsStatus('connecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      socketRef.current = ws;
      lastMessageAt = Date.now();

      ws.onopen = () => {
        if (!active || socketRef.current !== ws) return;
        setWsStatus('connected');
        // Authenticate first
        ws.send(JSON.stringify({ type: 'auth', token }));
      };

      ws.onmessage = (event) => {
        if (!active || socketRef.current !== ws) return;
        lastMessageAt = Date.now();
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const typeByte = bytes[0];
          const payload = bytes.subarray(1);
          const blob = new Blob([payload], { type: 'image/jpeg' });
          emit({ type: 'binary_frame', typeByte, buffer: event.data, payload, blob });
          return;
        }

        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          console.error('WebSocket parse error:', e);
          return;
        }
        if (msg.type === 'auth_ok') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'register', role: 'browser', deviceId: selectedDeviceId }));
          }
        } else if (msg.type === 'auth_error') {
          // Token rejected (expired/revoked) — reconnecting with it would loop forever.
          active = false;
          logoutRef.current?.();
          return;
        } else if (msg.type === 'phone_connected') {
          setPhoneOnline(true);
          if (msg.screenW && msg.screenH) {
            setScreenSize({ width: msg.screenW, height: msg.screenH });
          }
        } else if (msg.type === 'phone_disconnected') {
          setPhoneOnline(false);
          setLastLocation(null);
        } else if (msg.type === 'device_offline') {
          if (!msg.deviceId || msg.deviceId === selectedDeviceId) {
            setPhoneOnline(false);
            setLastLocation(null);
          }
        } else if (msg.type === 'device_online') {
          if (msg.deviceId === selectedDeviceId) {
            setPhoneOnline(true);
          }
        } else if (msg.type === 'location') {
          setLastLocation(msg);
        } else if (msg.type === 'pong') {
          return;
        }
        emit(msg);
      };

      ws.onclose = () => {
        if (!active || socketRef.current !== ws) return;
        setWsStatus('disconnected');
        setPhoneOnline(false);
        emit({ type: '_ws_closed' });
        scheduleReconnect();
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
      };
    };

    pingInterval = setInterval(() => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAt > SILENT_SOCKET_MS) {
        // Half-open: close() would wait for a close handshake that never
        // comes, so report the loss and reconnect ourselves.
        socketRef.current = null;
        try { ws.close(); } catch (_) {}
        setWsStatus('disconnected');
        setPhoneOnline(false);
        emit({ type: '_ws_closed' });
        scheduleReconnect();
        return;
      }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_INTERVAL_MS);

    // Network came back — don't sit out the rest of the reconnect delay.
    const handleOnline = () => {
      const ws = socketRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      connect();
    };
    window.addEventListener('online', handleOnline);

    connect();

    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      clearInterval(pingInterval);
      const ws = socketRef.current;
      socketRef.current = null;
      if (ws) ws.close();
    };
  }, [token, selectedDeviceId, emit]);

  // Send message helper
  const sendControl = useCallback((action, data = {}) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'control',
        action,
        ...data,
      }));
    }
  }, []);

  const sendRaw = useCallback((obj) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }, []);

  // Add message listener for specific pages
  const addListener = useCallback((callback) => {
    listenersRef.current.add(callback);
    return () => listenersRef.current.delete(callback);
  }, []);

  return (
    <DeviceContext.Provider
      value={{
        devices,
        selectedDeviceId,
        setSelectedDeviceId,
        refreshDevices,
        wsStatus,
        phoneOnline,
        screenSize,
        lastLocation,
        sendControl,
        sendRaw,
        addListener,
      }}
    >
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const context = useContext(DeviceContext);
  if (!context) throw new Error('useDevice must be used within a DeviceProvider');
  return context;
}
