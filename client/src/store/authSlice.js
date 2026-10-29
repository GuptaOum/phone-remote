import { createSlice } from '@reduxjs/toolkit';

const initialToken = localStorage.getItem('pr_token') || '';
const initialEmail = localStorage.getItem('pr_email') || '';

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    token: initialToken,
    email: initialEmail,
    isAuthenticated: Boolean(initialToken),
  },
  reducers: {
    setCredentials: (state, action) => {
      const { token, email } = action.payload;
      state.token = token;
      state.email = email;
      state.isAuthenticated = true;
      localStorage.setItem('pr_token', token);
      localStorage.setItem('pr_email', email);
    },
    logout: (state) => {
      state.token = '';
      state.email = '';
      state.isAuthenticated = false;
      localStorage.removeItem('pr_token');
      localStorage.removeItem('pr_email');
      localStorage.removeItem('pr_device');
    },
  },
});

export const { setCredentials, logout } = authSlice.actions;
export default authSlice.reducer;
