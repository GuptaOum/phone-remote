import React, { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('pr_token') || '');
  const [email, setEmail] = useState(() => localStorage.getItem('pr_email') || '');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      localStorage.setItem('pr_token', token);
    } else {
      localStorage.removeItem('pr_token');
    }
  }, [token]);

  useEffect(() => {
    if (email) {
      localStorage.setItem('pr_email', email);
    } else {
      localStorage.removeItem('pr_email');
    }
    setLoading(false);
  }, [email]);

  const login = async (emailInput, password) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setToken(data.token);
    setEmail(data.email);
    return data;
  };

  const register = async (emailInput, password) => {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailInput, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    setToken(data.token);
    setEmail(data.email);
    return data;
  };

  const logout = () => {
    setToken('');
    setEmail('');
    localStorage.removeItem('pr_token');
    localStorage.removeItem('pr_email');
    localStorage.removeItem('pr_device');
    sessionStorage.removeItem('pr_streaming');
    sessionStorage.removeItem('pr_camera');
  };

  const api = async (path, opts = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      ...opts.headers,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(path, { ...opts, headers });
    if (res.status === 401) {
      logout();
      throw new Error('Unauthorized');
    }
    return res;
  };

  const isAuthenticated = Boolean(token);

  return (
    <AuthContext.Provider value={{ token, email, isAuthenticated, login, register, logout, api, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
