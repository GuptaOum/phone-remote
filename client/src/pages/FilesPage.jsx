import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import { Folder, File, Download, Trash2, ArrowUp, Upload, FolderPlus, RefreshCw, AlertCircle } from 'lucide-react';

export function FilesPage() {
  const { api } = useAuth();
  const { selectedDeviceId } = useDevice();
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const fetchFiles = useCallback(async (path = '') => {
    if (!selectedDeviceId) return;
    setLoading(true);
    try {
      const res = await api(`/api/files?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      setEntries(data.entries || []);
      setCurrentPath(data.path || path);
    } catch (e) {
      console.error('Failed to load files:', e);
    } finally {
      setLoading(false);
    }
  }, [api, selectedDeviceId]);

  useEffect(() => {
    fetchFiles('');
  }, [fetchFiles]);

  const handleOpenDir = (dirPath) => {
    fetchFiles(dirPath);
  };

  const handleGoUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    fetchFiles(parts.join('/'));
  };

  const handleDownload = (filePath) => {
    window.open(`/api/files/download?path=${encodeURIComponent(filePath)}`, '_blank');
  };

  const handleDelete = async (filePath) => {
    if (!window.confirm(`Delete "${filePath}"?`)) return;
    try {
      await api(`/api/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
      fetchFiles(currentPath);
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  };

  const handleUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    try {
      const res = await fetch(`/api/files/upload?path=${encodeURIComponent(currentPath)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('pr_token')}`,
        },
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      fetchFiles(currentPath);
    } catch (err) {
      alert(`Upload error: ${err.message}`);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleMkdir = async () => {
    const name = window.prompt('New folder name:');
    if (!name) return;
    const newPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await api('/api/files/mkdir', {
        method: 'POST',
        body: JSON.stringify({ path: newPath }),
      });
      fetchFiles(currentPath);
    } catch (err) {
      alert(`Failed to create directory: ${err.message}`);
    }
  };

  if (!selectedDeviceId) {
    return (
      <div className="empty-files-view">
        <AlertCircle size={36} color="var(--amber)" />
        <h2>No Device Selected</h2>
        <p>Please select an Android phone from the Devices tab.</p>
      </div>
    );
  }

  return (
    <div className="files-page-container">
      <div className="files-header">
        <div className="breadcrumbs">
          <button className="btn" onClick={() => fetchFiles('')} title="Root">
            <Folder size={14} />
            <span>Root</span>
          </button>
          {currentPath.split('/').filter(Boolean).map((part, idx, arr) => (
            <React.Fragment key={idx}>
              <span className="crumb-separator">/</span>
              <button
                className="btn breadcrumb-btn"
                onClick={() => fetchFiles(arr.slice(0, idx + 1).join('/'))}
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="files-actions">
          {currentPath && (
            <button className="btn" onClick={handleGoUp} title="Go up one folder">
              <ArrowUp size={14} />
              <span>Up</span>
            </button>
          )}
          <button className="btn" onClick={handleMkdir}>
            <FolderPlus size={14} />
            <span>New Folder</span>
          </button>
          <label className="btn primary upload-label">
            <Upload size={14} />
            <span>{uploading ? 'Uploading...' : 'Upload'}</span>
            <input type="file" multiple onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
          </label>
          <button className="btn" onClick={() => fetchFiles(currentPath)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="files-table-wrapper">
        <table className="files-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-table">
                  {loading ? 'Loading directory...' : 'Folder is empty'}
                </td>
              </tr>
            ) : (
              entries.map((item) => (
                <tr key={item.path} className="file-row">
                  <td
                    className="name-cell"
                    onClick={() => item.type === 'dir' && handleOpenDir(item.path)}
                  >
                    {item.type === 'dir' ? (
                      <Folder size={16} className="folder-icon" />
                    ) : (
                      <File size={16} className="file-icon" />
                    )}
                    <span className={item.type === 'dir' ? 'dir-name' : 'file-name'}>{item.name}</span>
                  </td>
                  <td className="meta-cell">{item.type === 'dir' ? 'Folder' : item.mime || 'File'}</td>
                  <td className="meta-cell">
                    {item.size != null ? `${(item.size / 1024).toFixed(1)} KB` : '—'}
                  </td>
                  <td className="actions-cell">
                    {item.type !== 'dir' && (
                      <button className="row-action-btn" onClick={() => handleDownload(item.path)} title="Download">
                        <Download size={14} />
                      </button>
                    )}
                    <button
                      className="row-action-btn danger"
                      onClick={() => handleDelete(item.path)}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <style>{`
        .files-page-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 24px;
          max-width: 1040px;
          margin: 0 auto;
          width: 100%;
        }
        .files-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 20px;
          gap: 16px;
        }
        .breadcrumbs {
          display: flex;
          align-items: center;
          gap: 6px;
          overflow-x: auto;
        }
        .crumb-separator {
          color: var(--muted);
          font-size: 13px;
        }
        .breadcrumb-btn {
          padding: 6px 10px;
          font-size: 12.5px;
        }
        .files-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .upload-label {
          cursor: pointer;
        }
        .files-table-wrapper {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: 14px;
          overflow: hidden;
        }
        .files-table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
        }
        .files-table th {
          background: var(--bg3);
          color: var(--muted);
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          padding: 12px 18px;
          border-bottom: 1px solid var(--border);
        }
        .files-table td {
          padding: 12px 18px;
          border-bottom: 1px solid var(--border);
          font-size: 13.5px;
        }
        .file-row:hover td {
          background: rgba(255, 255, 255, 0.02);
        }
        .name-cell {
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
        }
        .folder-icon {
          color: var(--amber);
        }
        .file-icon {
          color: var(--accent2);
        }
        .dir-name {
          font-weight: 600;
          color: #fff;
        }
        .dir-name:hover {
          text-decoration: underline;
        }
        .meta-cell {
          color: var(--muted);
          font-size: 12px;
        }
        .actions-cell {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .row-action-btn {
          background: var(--bg3);
          border: 1px solid var(--border);
          color: var(--text);
          padding: 6px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .row-action-btn:hover {
          color: #fff;
          border-color: var(--accent);
        }
        .row-action-btn.danger:hover {
          color: var(--red);
          border-color: var(--red);
          background: rgba(239, 68, 68, 0.1);
        }
        .empty-table {
          text-align: center;
          color: var(--muted);
          padding: 40px !important;
        }
        .empty-files-view {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          gap: 12px;
          padding: 40px;
        }
      `}</style>
    </div>
  );
}

export default FilesPage;
