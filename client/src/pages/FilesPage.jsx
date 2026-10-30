import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import {
  Smartphone,
  UploadCloud,
  HardDrive,
  Folder,
  File,
  Download,
  Trash2,
  ArrowUp,
  RefreshCw,
  Search,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FolderPlus,
  ArrowRight,
  FileText,
  Image as ImageIcon,
  Music,
  Video,
  FileArchive,
  ArrowUpDown,
  Send,
} from 'lucide-react';

const PHONE_ROOT = '/storage/emulated/0';

function confinePhonePath(path) {
  let raw = (path || PHONE_ROOT).replace(/\\/g, '/').replace(/\/+/g, '/').trim();
  if (!raw.startsWith('/')) raw = '/' + raw;
  const parts = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const abs = '/' + parts.join('/');
  return abs === PHONE_ROOT || abs.startsWith(PHONE_ROOT + '/') ? abs : PHONE_ROOT;
}

function joinPhonePath(base, name) {
  const safeBase = confinePhonePath(base).replace(/\/$/, '');
  const safeName = (name || 'file').replace(/[\\/]/g, '_').trim() || 'file';
  return safeBase + '/' + safeName;
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(name, isDir) {
  if (isDir) return <Folder size={18} className="icon-dir" />;
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    return <ImageIcon size={18} className="icon-img" />;
  }
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', '3gp'].includes(ext)) {
    return <Video size={18} className="icon-video" />;
  }
  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext)) {
    return <Music size={18} className="icon-audio" />;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'apk'].includes(ext)) {
    return <FileArchive size={18} className="icon-archive" />;
  }
  return <FileText size={18} className="icon-file" />;
}

export default function FilesPage() {
  const { token, api } = useAuth();
  const { selectedDeviceId, phoneOnline, sendRaw, addListener } = useDevice();

  // Primary navigation: two segregated main sections
  // 'phone-explorer' = Phone Storage Explorer
  // 'transfer-hub' = PC-to-Phone Transfer & Upload Hub
  // 'pc-cloud' = PC/Server Cloud Storage
  const [activeTab, setActiveTab] = useState(() => sessionStorage.getItem('pr_files_tab') || 'phone-explorer');

  // Phone Explorer State
  const [phonePath, setPhonePath] = useState(() => confinePhonePath(sessionStorage.getItem('pr_phone_path')));
  const [phoneFiles, setPhoneFiles] = useState([]);
  const [loadingPhone, setLoadingPhone] = useState(false);
  const [phoneSearch, setPhoneSearch] = useState('');
  const [phoneSort, setPhoneSort] = useState({ by: 'name', dir: 1 });
  const [downloadProgress, setDownloadProgress] = useState(null); // { id, name, percent }

  // PC-to-Phone Transfer Hub State
  const [targetPhoneDir, setTargetPhoneDir] = useState('/storage/emulated/0/Download');
  const [customDirInput, setCustomDirInput] = useState('');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [transfers, setTransfers] = useState([]); // Array of { id, name, size, dest, progress, status, error, timestamp }
  const fileInputRef = useRef(null);

  // PC Cloud Storage State
  const [pcPath, setPcPath] = useState('');
  const [pcFiles, setPcFiles] = useState([]);
  const [loadingPc, setLoadingPc] = useState(false);
  const [pcUploading, setPcUploading] = useState(false);

  const activeDownloadsRef = useRef(new Map());

  // Save active tab
  const handleTabChange = (tab) => {
    setActiveTab(tab);
    sessionStorage.setItem('pr_files_tab', tab);
  };

  // ── Phone File System Operations ──────────────────────────────────────────

  const requestPhoneFiles = useCallback((path) => {
    if (!selectedDeviceId || !phoneOnline) return;
    const safe = confinePhonePath(path);
    setLoadingPhone(true);
    const id = Math.random().toString(36).slice(2);
    sendRaw({ type: 'pf_list', path: safe, id });
  }, [selectedDeviceId, phoneOnline, sendRaw]);

  // Request phone files when tab becomes phone-explorer or path changes
  useEffect(() => {
    if (activeTab === 'phone-explorer') {
      requestPhoneFiles(phonePath);
    }
  }, [activeTab, phonePath, requestPhoneFiles]);

  const handlePhoneNavigate = (newPath) => {
    const safe = confinePhonePath(newPath);
    setPhonePath(safe);
    sessionStorage.setItem('pr_phone_path', safe);
    requestPhoneFiles(safe);
  };

  const handlePhoneGoUp = () => {
    if (phonePath === PHONE_ROOT) return;
    const parts = phonePath.split('/').filter(Boolean);
    parts.pop();
    const upPath = '/' + parts.join('/');
    handlePhoneNavigate(upPath);
  };

  const handlePhoneDownload = (entry) => {
    const id = Math.random().toString(36).slice(2);
    activeDownloadsRef.current.set(id, { name: entry.name, parts: [], total: 1 });
    setDownloadProgress({ id, name: entry.name, percent: 0 });
    sendRaw({ type: 'pf_download', path: entry.path, id });
  };

  const handlePhoneDelete = (entry) => {
    if (!window.confirm(`Delete "${entry.name}" from phone storage?`)) return;
    const id = Math.random().toString(36).slice(2);
    sendRaw({ type: 'pf_delete', path: entry.path, id });
  };

  // WebSocket message listener for phone file responses
  useEffect(() => {
    return addListener((msg) => {
      switch (msg.type) {
        case 'phone_connected':
          if (activeTab === 'phone-explorer') {
            requestPhoneFiles(phonePath);
          }
          break;

        case 'device_offline':
          if (msg.deviceId && msg.deviceId !== selectedDeviceId) break;
        // falls through
        case 'phone_disconnected':
        case '_ws_closed':
          setLoadingPhone(false);
          setPhoneFiles([]);
          setDownloadProgress(null);
          activeDownloadsRef.current.clear();
          break;

        case 'pf_list_result':
          if (msg.path === phonePath || msg.path === confinePhonePath(phonePath)) {
            setPhoneFiles(msg.entries || []);
            setLoadingPhone(false);
          }
          break;

        case 'pf_delete_ok':
          requestPhoneFiles(phonePath);
          break;

        case 'pf_chunk': {
          const dl = activeDownloadsRef.current.get(msg.id);
          if (dl) {
            dl.parts[msg.index] = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
            dl.total = msg.total || 1;
            const pct = Math.round(((msg.index + 1) / dl.total) * 100);
            setDownloadProgress({ id: msg.id, name: dl.name, percent: pct });

            if (msg.done) {
              const totalLen = dl.parts.reduce((sum, p) => sum + (p ? p.length : 0), 0);
              const bytes = new Uint8Array(totalLen);
              let offset = 0;
              for (const p of dl.parts) {
                if (p) {
                  bytes.set(p, offset);
                  offset += p.length;
                }
              }
              const blob = new Blob([bytes]);
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = dl.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setTimeout(() => URL.revokeObjectURL(url), 10000);

              activeDownloadsRef.current.delete(msg.id);
              setDownloadProgress(null);
            }
          }
          break;
        }

        case 'pf_error':
          setLoadingPhone(false);
          if (activeDownloadsRef.current.has(msg.id)) {
            activeDownloadsRef.current.delete(msg.id);
            setDownloadProgress(null);
          }
          alert(`Phone file error: ${msg.error || 'Operation failed'}`);
          break;

        default:
          break;
      }
    });
  }, [addListener, phonePath, activeTab, requestPhoneFiles, selectedDeviceId]);

  // Leaving the page: stop the phone from streaming downloads nobody will save.
  useEffect(() => {
    const downloads = activeDownloadsRef.current;
    return () => {
      for (const id of downloads.keys()) sendRaw({ type: 'pf_download_cancel', id });
      downloads.clear();
    };
  }, [sendRaw]);

  // ── PC-to-Phone File Upload & Transfer Hub ────────────────────────────────

  const uploadFileToPhone = async (file, destDirectory) => {
    const destPath = joinPhonePath(destDirectory, file.name);
    const transferId = Math.random().toString(36).slice(2);

    const newTransfer = {
      id: transferId,
      name: file.name,
      size: file.size,
      dest: destPath,
      progress: 0,
      status: 'uploading',
      error: null,
      timestamp: Date.now(),
    };

    setTransfers((prev) => [newTransfer, ...prev]);

    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `/api/phone-files/upload?deviceId=${encodeURIComponent(selectedDeviceId)}&path=${encodeURIComponent(destPath)}&token=${encodeURIComponent(token)}`;
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setTransfers((prev) =>
              prev.map((t) => (t.id === transferId ? { ...t, progress: pct } : t))
            );
          }
        };

        xhr.onload = () => {
          let resJson = {};
          try {
            resJson = JSON.parse(xhr.responseText);
          } catch {}
          if (xhr.status === 200 && resJson.ok) {
            resolve(resJson);
          } else {
            reject(new Error(resJson.error || `HTTP ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network connection error'));
        xhr.send(file);
      });

      setTransfers((prev) =>
        prev.map((t) => (t.id === transferId ? { ...t, progress: 100, status: 'completed' } : t))
      );

      // If uploading to current explorer directory, refresh it
      if (phonePath === destDirectory) {
        requestPhoneFiles(phonePath);
      }
    } catch (err) {
      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId ? { ...t, status: 'failed', error: err.message } : t
        )
      );
    }
  };

  const handleFilesSelected = (files) => {
    if (!files || files.length === 0) return;
    const dest = customDirInput.trim() || targetPhoneDir;
    for (let i = 0; i < files.length; i++) {
      uploadFileToPhone(files[i], dest);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (!phoneOnline) {
      alert('Phone must be online to upload files.');
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = () => {
    setIsDraggingOver(false);
  };

  const clearCompletedTransfers = () => {
    setTransfers((prev) => prev.filter((t) => t.status === 'uploading'));
  };

  // ── PC Server Storage Operations ──────────────────────────────────────────

  const fetchPcFiles = useCallback(async (path = '') => {
    setLoadingPc(true);
    try {
      const res = await api(`/api/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setPcFiles(data.entries || []);
      setPcPath(data.path || path);
    } catch (e) {
      console.error('Failed to load PC files:', e);
    } finally {
      setLoadingPc(false);
    }
  }, [api]);

  useEffect(() => {
    if (activeTab === 'pc-cloud') {
      fetchPcFiles(pcPath);
    }
  }, [activeTab, pcPath, fetchPcFiles]);

  const handlePcUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setPcUploading(true);
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }
    try {
      const res = await fetch(`/api/files/upload?path=${encodeURIComponent(pcPath)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('pr_token')}` },
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      fetchPcFiles(pcPath);
    } catch (err) {
      alert(`Upload error: ${err.message}`);
    } finally {
      setPcUploading(false);
      e.target.value = '';
    }
  };

  const handlePcDelete = async (filePath) => {
    if (!window.confirm(`Delete "${filePath}" from PC storage?`)) return;
    try {
      await api(`/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
      fetchPcFiles(pcPath);
    } catch (err) {
      alert(`Delete error: ${err.message}`);
    }
  };

  // ── Filter and Sort Phone Files ───────────────────────────────────────────

  const filteredPhoneFiles = phoneFiles
    .filter((f) => f.name.toLowerCase().includes(phoneSearch.toLowerCase()))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      if (phoneSort.by === 'size') {
        return (a.size - b.size) * phoneSort.dir;
      }
      if (phoneSort.by === 'date') {
        return (a.modified - b.modified) * phoneSort.dir;
      }
      return a.name.localeCompare(b.name) * phoneSort.dir;
    });

  if (!selectedDeviceId) {
    return (
      <div className="empty-files-container">
        <AlertCircle size={38} color="var(--amber)" />
        <h2>No Device Selected</h2>
        <p>Please select an Android phone from the Devices dashboard to manage files.</p>
      </div>
    );
  }

  return (
    <div className="files-page-layout">
      {/* Top Segregation Tab Bar */}
      <div className="files-tab-header">
        <div className="tab-buttons-wrap">
          <button
            className={`seg-tab-btn ${activeTab === 'phone-explorer' ? 'active' : ''}`}
            onClick={() => handleTabChange('phone-explorer')}
          >
            <Smartphone size={16} />
            <span>Phone Device Explorer</span>
            <span className={`status-badge ${phoneOnline ? 'online' : 'offline'}`}>
              {phoneOnline ? 'Connected' : 'Offline'}
            </span>
          </button>

          <button
            className={`seg-tab-btn ${activeTab === 'transfer-hub' ? 'active' : ''}`}
            onClick={() => handleTabChange('transfer-hub')}
          >
            <UploadCloud size={16} />
            <span>PC-to-Phone Transfer Hub</span>
            {transfers.filter((t) => t.status === 'uploading').length > 0 && (
              <span className="badge-pulse">
                {transfers.filter((t) => t.status === 'uploading').length} active
              </span>
            )}
          </button>

          <button
            className={`seg-tab-btn ${activeTab === 'pc-cloud' ? 'active' : ''}`}
            onClick={() => handleTabChange('pc-cloud')}
          >
            <HardDrive size={16} />
            <span>PC Server Storage</span>
          </button>
        </div>
      </div>

      {/* ── SECTION 1: Phone Device Explorer ────────────────────────────── */}
      {activeTab === 'phone-explorer' && (
        <div className="explorer-section">
          {/* Toolbar */}
          <div className="explorer-toolbar">
            <div className="nav-controls">
              <button
                className="btn btn-icon"
                onClick={handlePhoneGoUp}
                disabled={phonePath === PHONE_ROOT || !phoneOnline}
                title="Go Up"
              >
                <ArrowUp size={16} />
              </button>
              <button
                className="btn btn-icon"
                onClick={() => requestPhoneFiles(phonePath)}
                disabled={loadingPhone || !phoneOnline}
                title="Refresh Folder"
              >
                <RefreshCw size={16} className={loadingPhone ? 'spin' : ''} />
              </button>
            </div>

            {/* Breadcrumb Path */}
            <div className="phone-breadcrumbs">
              <span className="root-tag" onClick={() => handlePhoneNavigate(PHONE_ROOT)}>
                📱 /storage/emulated/0
              </span>
              {phonePath
                .replace(PHONE_ROOT, '')
                .split('/')
                .filter(Boolean)
                .map((seg, idx, arr) => (
                  <React.Fragment key={idx}>
                    <span className="path-sep">/</span>
                    <span
                      className="crumb-link"
                      onClick={() =>
                        handlePhoneNavigate(PHONE_ROOT + '/' + arr.slice(0, idx + 1).join('/'))
                      }
                    >
                      {seg}
                    </span>
                  </React.Fragment>
                ))}
            </div>

            {/* Search and Sort */}
            <div className="search-sort-bar">
              <div className="search-input-box">
                <Search size={14} className="search-icon" />
                <input
                  type="text"
                  placeholder="Filter files..."
                  value={phoneSearch}
                  onChange={(e) => setPhoneSearch(e.target.value)}
                />
              </div>

              <button
                className="btn"
                onClick={() =>
                  setPhoneSort((prev) => ({
                    by: prev.by === 'name' ? 'size' : prev.by === 'size' ? 'date' : 'name',
                    dir: prev.dir === 1 ? -1 : 1,
                  }))
                }
                title="Sort Files"
              >
                <ArrowUpDown size={14} />
                <span>Sort: {phoneSort.by}</span>
              </button>
            </div>
          </div>

          {/* Download in progress banner */}
          {downloadProgress && (
            <div className="download-active-banner">
              <Download size={16} className="spin" />
              <span>Downloading "{downloadProgress.name}" from phone... {downloadProgress.percent}%</span>
              <div className="banner-progress-bar">
                <div
                  className="banner-progress-fill"
                  style={{ width: `${downloadProgress.percent}%` }}
                ></div>
              </div>
            </div>
          )}

          {/* Files List View */}
          <div className="file-list-view">
            {!phoneOnline ? (
              <div className="center-empty-state">
                <Smartphone size={40} color="var(--muted)" />
                <h3>Phone is Offline</h3>
                <p>Ensure the Phone Remote companion app is active and connected on your device.</p>
              </div>
            ) : loadingPhone && phoneFiles.length === 0 ? (
              <div className="center-empty-state">
                <RefreshCw size={32} className="spin" color="var(--accent)" />
                <p>Loading files from phone...</p>
              </div>
            ) : filteredPhoneFiles.length === 0 ? (
              <div className="center-empty-state">
                <Folder size={36} color="var(--muted)" />
                <p>{phoneSearch ? 'No files match your search filter.' : 'This directory is empty.'}</p>
              </div>
            ) : (
              <table className="files-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Modified</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPhoneFiles.map((entry) => (
                    <tr
                      key={entry.path}
                      className={`file-row ${entry.type === 'dir' ? 'row-dir' : 'row-file'}`}
                      onDoubleClick={() => {
                        if (entry.type === 'dir') handlePhoneNavigate(entry.path);
                        else handlePhoneDownload(entry);
                      }}
                    >
                      <td className="cell-name">
                        {getFileIcon(entry.name, entry.type === 'dir')}
                        <span
                          className="file-name-text"
                          onClick={() => {
                            if (entry.type === 'dir') handlePhoneNavigate(entry.path);
                          }}
                        >
                          {entry.name}
                        </span>
                      </td>
                      <td className="cell-size">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</td>
                      <td className="cell-date">{formatDate(entry.modified)}</td>
                      <td className="cell-actions">
                        {entry.type !== 'dir' && (
                          <button
                            className="btn-icon-small"
                            onClick={() => handlePhoneDownload(entry)}
                            title="Download to PC"
                          >
                            <Download size={14} />
                          </button>
                        )}
                        <button
                          className="btn-icon-small danger"
                          onClick={() => handlePhoneDelete(entry)}
                          title="Delete from phone"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── SECTION 2: PC-to-Phone Upload & File Transfer Hub ────────────── */}
      {activeTab === 'transfer-hub' && (
        <div className="transfer-hub-section">
          {/* Target destination selector */}
          <div className="dest-selector-card">
            <div className="dest-header">
              <span className="dest-title">Phone Destination Directory:</span>
              <div className="quick-presets">
                <button
                  className={`preset-btn ${targetPhoneDir === '/storage/emulated/0/Download' ? 'active' : ''}`}
                  onClick={() => {
                    setTargetPhoneDir('/storage/emulated/0/Download');
                    setCustomDirInput('');
                  }}
                >
                  Downloads
                </button>
                <button
                  className={`preset-btn ${targetPhoneDir === '/storage/emulated/0/DCIM/Camera' ? 'active' : ''}`}
                  onClick={() => {
                    setTargetPhoneDir('/storage/emulated/0/DCIM/Camera');
                    setCustomDirInput('');
                  }}
                >
                  Camera (DCIM)
                </button>
                <button
                  className={`preset-btn ${targetPhoneDir === '/storage/emulated/0/Documents' ? 'active' : ''}`}
                  onClick={() => {
                    setTargetPhoneDir('/storage/emulated/0/Documents');
                    setCustomDirInput('');
                  }}
                >
                  Documents
                </button>
                <button
                  className={`preset-btn ${targetPhoneDir === phonePath ? 'active' : ''}`}
                  onClick={() => {
                    setTargetPhoneDir(phonePath);
                    setCustomDirInput('');
                  }}
                >
                  Current Explorer Folder
                </button>
              </div>
            </div>

            <div className="path-display-row">
              <span className="label-icon">📂</span>
              <input
                type="text"
                className="input path-input"
                placeholder="/storage/emulated/0/Download"
                value={customDirInput || targetPhoneDir}
                onChange={(e) => setCustomDirInput(e.target.value)}
              />
            </div>
          </div>

          {/* Drag & Drop Upload Zone */}
          <div
            className={`drop-zone-large ${isDraggingOver ? 'dragging-over' : ''} ${!phoneOnline ? 'disabled' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadCloud size={48} className="drop-icon" />
            <h3>Drag & Drop Files Here to Send to Phone</h3>
            <p>Or click to browse files from your computer</p>
            <span className="sub-hint">
              Directly streams to {customDirInput || targetPhoneDir} via WebSocket streaming
            </span>
            <input
              type="file"
              multiple
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={(e) => handleFilesSelected(e.target.files)}
              disabled={!phoneOnline}
            />
          </div>

          {/* Active Transfers Queue */}
          <div className="transfer-queue-card">
            <div className="queue-header">
              <div className="queue-title-wrap">
                <h3>Transfer Queue & History</h3>
                <span className="count-tag">{transfers.length} items</span>
              </div>
              {transfers.length > 0 && (
                <button className="btn btn-sm" onClick={clearCompletedTransfers}>
                  Clear Completed
                </button>
              )}
            </div>

            {transfers.length === 0 ? (
              <div className="queue-empty">
                <Send size={24} color="var(--muted)" />
                <p>No transfers yet. Drop files above to send them directly to your phone.</p>
              </div>
            ) : (
              <div className="transfer-items-list">
                {transfers.map((item) => (
                  <div key={item.id} className="transfer-item-row">
                    <div className="item-icon-wrap">{getFileIcon(item.name, false)}</div>
                    <div className="item-info">
                      <div className="item-top-line">
                        <span className="item-name" title={item.name}>
                          {item.name}
                        </span>
                        <span className="item-size">{formatBytes(item.size)}</span>
                      </div>
                      <div className="item-dest-line">
                        <ArrowRight size={12} />
                        <span className="item-dest">{item.dest}</span>
                      </div>
                      {item.status === 'uploading' && (
                        <div className="item-progress-track">
                          <div
                            className="item-progress-bar"
                            style={{ width: `${item.progress}%` }}
                          ></div>
                        </div>
                      )}
                    </div>
                    <div className="item-status-wrap">
                      {item.status === 'uploading' && (
                        <span className="status-pill uploading">{item.progress}%</span>
                      )}
                      {item.status === 'completed' && (
                        <span className="status-pill completed">
                          <CheckCircle2 size={13} /> Completed
                        </span>
                      )}
                      {item.status === 'failed' && (
                        <span className="status-pill failed" title={item.error}>
                          <XCircle size={13} /> Failed
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SECTION 3: PC Server Storage ─────────────────────────────────── */}
      {activeTab === 'pc-cloud' && (
        <div className="explorer-section">
          <div className="explorer-toolbar">
            <div className="nav-controls">
              <button
                className="btn btn-icon"
                onClick={() => {
                  const parts = pcPath.split('/').filter(Boolean);
                  parts.pop();
                  fetchPcFiles(parts.join('/'));
                }}
                disabled={!pcPath}
                title="Go Up"
              >
                <ArrowUp size={16} />
              </button>
              <button
                className="btn btn-icon"
                onClick={() => fetchPcFiles(pcPath)}
                disabled={loadingPc}
                title="Refresh"
              >
                <RefreshCw size={16} className={loadingPc ? 'spin' : ''} />
              </button>
            </div>

            <div className="phone-breadcrumbs">
              <span className="root-tag" onClick={() => fetchPcFiles('')}>
                💻 PC Root (/api/files)
              </span>
              {pcPath
                .split('/')
                .filter(Boolean)
                .map((seg, idx, arr) => (
                  <React.Fragment key={idx}>
                    <span className="path-sep">/</span>
                    <span
                      className="crumb-link"
                      onClick={() => fetchPcFiles(arr.slice(0, idx + 1).join('/'))}
                    >
                      {seg}
                    </span>
                  </React.Fragment>
                ))}
            </div>

            <div className="search-sort-bar">
              <label className="btn primary" style={{ cursor: 'pointer' }}>
                <UploadCloud size={14} />
                <span>{pcUploading ? 'Uploading...' : 'Upload to PC'}</span>
                <input
                  type="file"
                  multiple
                  onChange={handlePcUpload}
                  style={{ display: 'none' }}
                  disabled={pcUploading}
                />
              </label>
            </div>
          </div>

          <div className="file-list-view">
            {loadingPc && pcFiles.length === 0 ? (
              <div className="center-empty-state">
                <RefreshCw size={32} className="spin" color="var(--accent)" />
                <p>Loading files from PC server...</p>
              </div>
            ) : pcFiles.length === 0 ? (
              <div className="center-empty-state">
                <HardDrive size={36} color="var(--muted)" />
                <p>No files in this PC folder. Upload files using the button above.</p>
              </div>
            ) : (
              <table className="files-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Size</th>
                    <th>Modified</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pcFiles.map((entry) => (
                    <tr
                      key={entry.path}
                      className={`file-row ${entry.type === 'dir' ? 'row-dir' : 'row-file'}`}
                      onDoubleClick={() => {
                        if (entry.type === 'dir') fetchPcFiles(entry.path);
                        else
                          window.open(
                            `/api/files/download?path=${encodeURIComponent(entry.path)}`,
                            '_blank'
                          );
                      }}
                    >
                      <td className="cell-name">
                        {getFileIcon(entry.name, entry.type === 'dir')}
                        <span
                          className="file-name-text"
                          onClick={() => {
                            if (entry.type === 'dir') fetchPcFiles(entry.path);
                          }}
                        >
                          {entry.name}
                        </span>
                      </td>
                      <td className="cell-size">{entry.type === 'dir' ? '—' : formatBytes(entry.size)}</td>
                      <td className="cell-date">{formatDate(entry.modified)}</td>
                      <td className="cell-actions">
                        {entry.type !== 'dir' && (
                          <button
                            className="btn-icon-small"
                            onClick={() =>
                              window.open(
                                `/api/files/download?path=${encodeURIComponent(entry.path)}`,
                                '_blank'
                              )
                            }
                            title="Download"
                          >
                            <Download size={14} />
                          </button>
                        )}
                        <button
                          className="btn-icon-small danger"
                          onClick={() => handlePcDelete(entry.path)}
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Integrated Page CSS */}
      <style>{`
        .files-page-layout {
          flex: 1;
          display: flex;
          flex-direction: column;
          background: var(--bg);
          overflow: hidden;
        }

        /* Top Segregation Tab Bar */
        .files-tab-header {
          background: var(--bg2);
          border-bottom: 1px solid var(--border);
          padding: 8px 18px 0 18px;
          flex-shrink: 0;
        }
        .tab-buttons-wrap {
          display: flex;
          gap: 6px;
        }
        .seg-tab-btn {
          display: flex;
          align-items: center;
          gap: 8px;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--muted);
          padding: 10px 16px;
          font-size: 13.5px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .seg-tab-btn:hover {
          color: var(--text);
        }
        .seg-tab-btn.active {
          color: var(--accent2);
          border-bottom-color: var(--accent);
          font-weight: 600;
        }
        .status-badge {
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 12px;
          font-weight: 600;
          text-transform: uppercase;
        }
        .status-badge.online {
          background: rgba(34, 197, 94, 0.15);
          color: var(--green);
          border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .status-badge.offline {
          background: rgba(239, 68, 68, 0.15);
          color: var(--red);
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .badge-pulse {
          font-size: 10.5px;
          background: var(--accent);
          color: #fff;
          padding: 2px 7px;
          border-radius: 12px;
          font-weight: 600;
        }

        /* Explorer Section */
        .explorer-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .explorer-toolbar {
          background: var(--bg2);
          border-bottom: 1px solid var(--border);
          padding: 10px 16px;
          display: flex;
          align-items: center;
          gap: 12px;
          flex-shrink: 0;
        }
        .nav-controls {
          display: flex;
          gap: 6px;
        }
        .btn-icon {
          padding: 8px 10px;
        }
        .phone-breadcrumbs {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 6px;
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 6px 12px;
          font-size: 12.5px;
          overflow-x: auto;
          white-space: nowrap;
        }
        .root-tag {
          font-weight: 600;
          color: var(--accent2);
          cursor: pointer;
        }
        .root-tag:hover, .crumb-link:hover {
          text-decoration: underline;
        }
        .crumb-link {
          color: var(--text);
          cursor: pointer;
        }
        .path-sep {
          color: var(--muted);
        }
        .search-sort-bar {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .search-input-box {
          display: flex;
          align-items: center;
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 0 10px;
        }
        .search-input-box input {
          background: transparent;
          border: none;
          color: var(--text);
          font-size: 12.5px;
          padding: 6px 6px;
          outline: none;
          width: 140px;
        }
        .search-icon {
          color: var(--muted);
        }

        /* Download Active Banner */
        .download-active-banner {
          background: rgba(99, 102, 241, 0.12);
          border-bottom: 1px solid var(--accent);
          padding: 8px 16px;
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 12.5px;
          color: var(--accent2);
        }
        .banner-progress-bar {
          flex: 1;
          height: 6px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
          overflow: hidden;
          margin-left: 12px;
        }
        .banner-progress-fill {
          height: 100%;
          background: var(--accent);
          transition: width 0.2s ease;
        }

        /* Files Table */
        .file-list-view {
          flex: 1;
          overflow-y: auto;
          padding: 8px 16px;
        }
        .files-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
        }
        .files-table th {
          text-align: left;
          padding: 10px 12px;
          color: var(--muted);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid var(--border);
        }
        .file-row {
          border-bottom: 1px solid var(--border);
          transition: background 0.15s ease;
          user-select: none;
        }
        .file-row:hover {
          background: var(--bg3);
        }
        .file-row td {
          padding: 10px 12px;
        }
        .cell-name {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .file-name-text {
          cursor: pointer;
          color: var(--text);
          font-weight: 500;
        }
        .row-dir .file-name-text {
          color: #fff;
          font-weight: 600;
        }
        .cell-size, .cell-date {
          color: var(--muted);
          font-size: 12px;
          white-space: nowrap;
        }
        .cell-actions {
          text-align: right;
          white-space: nowrap;
        }
        .btn-icon-small {
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 6px;
          color: var(--muted);
          padding: 5px 8px;
          cursor: pointer;
          margin-left: 6px;
          transition: all 0.15s ease;
        }
        .btn-icon-small:hover {
          color: var(--accent2);
          border-color: var(--accent);
          background: var(--accent-glow);
        }
        .btn-icon-small.danger:hover {
          color: var(--red);
          border-color: var(--red);
          background: rgba(239, 68, 68, 0.15);
        }
        .icon-dir { color: #f59e0b; }
        .icon-img { color: #10b981; }
        .icon-video { color: #8b5cf6; }
        .icon-audio { color: #ec4899; }
        .icon-archive { color: #f97316; }
        .icon-file { color: var(--muted); }

        /* Transfer Hub Layout */
        .transfer-hub-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 20px 24px;
          overflow-y: auto;
        }
        .dest-selector-card {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .dest-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 10px;
        }
        .dest-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text);
        }
        .quick-presets {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .preset-btn {
          background: var(--bg3);
          border: 1px solid var(--border);
          color: var(--muted);
          border-radius: 6px;
          padding: 4px 10px;
          font-size: 11.5px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .preset-btn:hover {
          color: var(--text);
          border-color: var(--accent);
        }
        .preset-btn.active {
          background: var(--accent-glow);
          color: var(--accent2);
          border-color: var(--accent);
          font-weight: 600;
        }
        .path-display-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .path-input {
          font-family: monospace;
          font-size: 12.5px;
        }

        /* Drop Zone */
        .drop-zone-large {
          border: 2px dashed var(--border);
          border-radius: 16px;
          background: rgba(19, 21, 31, 0.6);
          padding: 40px 24px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .drop-zone-large:hover, .drop-zone-large.dragging-over {
          border-color: var(--accent);
          background: rgba(99, 102, 241, 0.08);
          transform: scale(1.005);
        }
        .drop-zone-large.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .drop-icon {
          color: var(--accent2);
          margin-bottom: 12px;
        }
        .drop-zone-large h3 {
          font-size: 17px;
          color: #fff;
          margin-bottom: 6px;
        }
        .drop-zone-large p {
          color: var(--muted);
          font-size: 13.5px;
          margin-bottom: 8px;
        }
        .sub-hint {
          font-size: 11.5px;
          color: var(--accent2);
          font-family: monospace;
        }

        /* Transfer Queue */
        .transfer-queue-card {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .queue-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
          padding-bottom: 10px;
        }
        .queue-title-wrap {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .queue-title-wrap h3 {
          font-size: 14px;
          font-weight: 600;
          color: #fff;
        }
        .count-tag {
          font-size: 11px;
          background: var(--bg3);
          border: 1px solid var(--border);
          color: var(--muted);
          padding: 2px 8px;
          border-radius: 10px;
        }
        .queue-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 30px;
          gap: 10px;
          color: var(--muted);
          font-size: 13px;
        }
        .transfer-items-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-height: 320px;
          overflow-y: auto;
        }
        .transfer-item-row {
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 14px;
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .item-icon-wrap {
          flex-shrink: 0;
        }
        .item-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }
        .item-top-line {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .item-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .item-size {
          font-size: 11.5px;
          color: var(--muted);
          flex-shrink: 0;
        }
        .item-dest-line {
          display: flex;
          align-items: center;
          gap: 6px;
          color: var(--muted);
          font-size: 11px;
          font-family: monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .item-progress-track {
          height: 4px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 2px;
          overflow: hidden;
          margin-top: 4px;
        }
        .item-progress-bar {
          height: 100%;
          background: var(--accent);
          transition: width 0.15s ease;
        }
        .status-pill {
          font-size: 11px;
          font-weight: 600;
          padding: 4px 10px;
          border-radius: 20px;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .status-pill.uploading {
          background: rgba(99, 102, 241, 0.15);
          color: var(--accent2);
          border: 1px solid rgba(99, 102, 241, 0.3);
        }
        .status-pill.completed {
          background: rgba(34, 197, 94, 0.15);
          color: var(--green);
          border: 1px solid rgba(34, 197, 94, 0.3);
        }
        .status-pill.failed {
          background: rgba(239, 68, 68, 0.15);
          color: var(--red);
          border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .center-empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 60px 20px;
          text-align: center;
          gap: 12px;
          color: var(--muted);
        }
        .center-empty-state h3 {
          color: #fff;
          font-size: 16px;
        }
        .empty-files-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 40px;
          text-align: center;
          gap: 12px;
        }
        .btn-sm {
          padding: 4px 10px;
          font-size: 11.5px;
        }
      `}</style>
    </div>
  );
}
