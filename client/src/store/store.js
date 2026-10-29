import { configureStore } from '@reduxjs/toolkit';
import authReducer from './authSlice';
import deviceReducer from './deviceSlice';

export const store = configureStore({
  reducer: {
    auth: authReducer,
    device: deviceReducer,
  },
});
