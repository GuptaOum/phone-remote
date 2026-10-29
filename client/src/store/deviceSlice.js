import { createSlice } from '@reduxjs/toolkit';

const initialDeviceId = new URLSearchParams(window.location.search).get('device') || localStorage.getItem('pr_device') || '';

const deviceSlice = createSlice({
  name: 'device',
  initialState: {
    devices: [],
    selectedDeviceId: initialDeviceId,
    phoneOnline: false,
    wsStatus: 'disconnected', // 'connected' | 'connecting' | 'disconnected'
    screenSize: { width: 1080, height: 1920 },
    isStreaming: sessionStorage.getItem('pr_streaming') === 'true',
    latestFrameUrl: null,
  },
  reducers: {
    setDevices: (state, action) => {
      state.devices = action.payload;
      if (!state.selectedDeviceId && action.payload.length > 0) {
        state.selectedDeviceId = action.payload[0].id;
        localStorage.setItem('pr_device', action.payload[0].id);
      }
    },
    setSelectedDeviceId: (state, action) => {
      state.selectedDeviceId = action.payload;
      if (action.payload) {
        localStorage.setItem('pr_device', action.payload);
      }
    },
    setPhoneOnline: (state, action) => {
      state.phoneOnline = action.payload;
    },
    setWsStatus: (state, action) => {
      state.wsStatus = action.payload;
    },
    setScreenSize: (state, action) => {
      state.screenSize = action.payload;
    },
    setIsStreaming: (state, action) => {
      state.isStreaming = action.payload;
      if (action.payload) {
        sessionStorage.setItem('pr_streaming', 'true');
      } else {
        sessionStorage.removeItem('pr_streaming');
      }
    },
    setLatestFrameUrl: (state, action) => {
      state.latestFrameUrl = action.payload;
    },
  },
});

export const {
  setDevices,
  setSelectedDeviceId,
  setPhoneOnline,
  setWsStatus,
  setScreenSize,
  setIsStreaming,
  setLatestFrameUrl,
} = deviceSlice.actions;

export default deviceSlice.reducer;
