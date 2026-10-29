import React from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Header } from './components/Header';

import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import MirrorPage from './pages/MirrorPage';
import CameraPage from './pages/CameraPage';
import FilesPage from './pages/FilesPage';
import LocationPage from './pages/LocationPage';
import McpTestPage from './pages/McpTestPage';

function ProtectedLayout() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <span className="spinner" style={{ width: '28px', height: '28px' }}></span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-shell" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <Header />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/mirror" element={<MirrorPage />} />
        <Route path="/camera" element={<CameraPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/location" element={<LocationPage />} />
        <Route path="/mcp-test" element={<McpTestPage />} />
      </Route>

      {/* Fallback to dashboard */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
