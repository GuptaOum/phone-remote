import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from './AuthContext';

const DeviceContext = createContext(null);

export function DeviceProvider({ children }) {
  const { token, api } = useAuth();
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    // Check URL param first, then localStorage
    const params = new URLSearchParams(window.location.search);
    return params.get('device') || localStorage.getItem('pr_device') || '';
  });
  const [wsStatus, setWsStatus] = useState('disconnected');
  const [phoneOnline, setPhoneOnline] = useState(false);
  const [screenSize, setScreenSize] = useState({ width: 1080, height: 1920 });
  const [latestFrame, setLatestFrame] = useState(null);

  const socketRef = useRef(null);
  const listenersRef = useRef(new Set());

  // Save selected device in localStorage & update URL if needed
  useEffect(() => {
    if (selectedDeviceId) {
      localStorage.setItem('pr_device', selectedDeviceId);
    }
  }, [selectedDeviceId]);

  // Fetch devices list
  const refreshDevices = useCallback(async () => {
    if (!token) return [];
    try {
      const res = await api('/api/devices');
      const data = await res.json();
      setDevices(data.devices || []);
      
      // If no selected device yet, select first active one
      if (!selectedDeviceId && data.devices && data.devices.length > 0) {
        setSelectedDeviceId(data.devices[0].id);
      }
      return data.devices || [];
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
    if (!token || !selectedDeviceId) {
      setWsStatus('disconnected');
      return;
    }

    let active = true;
    let reconnectTimeout = null;

    const connect = () => {
      if (!active) return;
      setWsStatus('connecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      socketRef.current = ws;

      ws.onopen = () => {
        if (!active) return;
        setWsStatus('connected');
        // Authenticate & register
        ws.send(JSON.stringify({ type: 'auth', token }));
        ws.send(JSON.stringify({ type: 'register', role: 'browser', deviceId: selectedDeviceId }));
      };

      ws.onmessage = (event) => {
        if (!active) return;
        if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          const typeByte = bytes[0];
          const payload = bytes.subarray(1);
          const blob = new Blob([payload], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);

          if (typeByte === 0x01) {
            setLatestFrame(url);
          }
          listenersRef.current.forEach((fn) =>
            fn({ type: 'binary_frame', typeByte, buffer: event.data, payload, blob, url })
          );
          return;
        }

        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'phone_connected') {
            setPhoneOnline(true);
            if (msg.screenW && msg.screenH) {
              setScreenSize({ width: msg.screenW, height: msg.screenH });
            }
          } else if (msg.type === 'phone_disconnected') {
            setPhoneOnline(false);
          }
          listenersRef.current.forEach((fn) => fn(msg));
        } catch (e) {
          console.error('WebSocket parse error:', e);
        }
      };

      ws.onclose = () => {
        if (!active) return;
        setWsStatus('disconnected');
        setPhoneOnline(false);
        reconnectTimeout = setTimeout(connect, 2500);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        ws.close();
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (socketRef.current) socketRef.current.close();
    };
  }, [token, selectedDeviceId]);

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
    }
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
        latestFrame,
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
