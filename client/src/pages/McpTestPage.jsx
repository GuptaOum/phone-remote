import React, { useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevice } from '../context/DeviceContext';
import { Play, Check, X, Loader2, AlertCircle } from 'lucide-react';

const TESTS = [
  { name: 'list_devices', tool: 'list_devices', getArgs: () => ({}) },
  { name: 'get_device_status', tool: 'get_device_status', getArgs: (id) => ({ deviceId: id }) },
  { name: 'get_foreground_app', tool: 'get_foreground_app', getArgs: (id) => ({ deviceId: id }) },
  { name: 'get_ui_tree', tool: 'get_ui_tree', getArgs: (id) => ({ deviceId: id }) },
  { name: 'list_apps', tool: 'list_apps', getArgs: (id) => ({ deviceId: id, filter: 'settings' }) },
  { name: 'list_files', tool: 'list_files', getArgs: (id) => ({ deviceId: id }) },
  { name: 'read_notifications', tool: 'read_notifications', getArgs: (id) => ({ deviceId: id, limit: 3 }) },
  {
    name: 'press_key "home" (silent, reversible)',
    tool: 'press_key',
    getArgs: (id) => ({ deviceId: id, key: 'home' }),
  },
];

export default function McpTestPage() {
  const { token } = useAuth();
  const { selectedDeviceId } = useDevice();
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState(() =>
    TESTS.map((t) => ({
      name: t.name,
      status: 'pending', // 'pending' | 'running' | 'pass' | 'fail'
      detail: '',
      ms: null,
    }))
  );

  const rpcIdRef = useRef(1);

  const callTool = async (name, args) => {
    const res = await fetch('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcIdRef.current++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    if (res.status === 401) {
      throw new Error('Unauthorized - please re-login');
    }

    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    const r = body.result || {};
    const text = (r.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (r.isError) throw new Error(text || 'Tool reported an error');
    return text;
  };

  const handleRunAll = async () => {
    if (isRunning) return;
    setIsRunning(true);

    // Reset results
    const initial = TESTS.map((t) => ({
      name: t.name,
      status: 'pending',
      detail: '',
      ms: null,
    }));
    setResults(initial);

    for (let i = 0; i < TESTS.length; i++) {
      const t = TESTS[i];

      // Mark current as running
      setResults((prev) => {
        const copy = [...prev];
        copy[i] = { ...copy[i], status: 'running' };
        return copy;
      });

      const started = performance.now();
      try {
        const text = await callTool(t.tool, t.getArgs(selectedDeviceId));
        const elapsed = Math.round(performance.now() - started);

        setResults((prev) => {
          const copy = [...prev];
          copy[i] = {
            ...copy[i],
            status: 'pass',
            detail: (text || '(empty response)').slice(0, 300),
            ms: elapsed,
          };
          return copy;
        });
      } catch (e) {
        const elapsed = Math.round(performance.now() - started);
        setResults((prev) => {
          const copy = [...prev];
          copy[i] = {
            ...copy[i],
            status: 'fail',
            detail: e.message || 'Error executing tool',
            ms: elapsed,
          };
          return copy;
        });
      }
    }

    setIsRunning(false);
  };

  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  const executedCount = passCount + failCount;

  return (
    <div className="mcp-main">
      <div className="mcp-intro">
        Calls your <code>/mcp</code> endpoint directly over plain HTTP — the same JSON-RPC calls an
        MCP client like Claude or Antigravity would make — using your existing login. No AI model is
        involved, so running this costs nothing beyond a normal page load. Only read-only tools plus
        one silent, reversible action (<code>press_key home</code>) are run; nothing is sent, posted,
        or changed on your phone.
      </div>

      {!selectedDeviceId && (
        <div className="mcp-no-device">
          <AlertCircle size={16} />
          <span>
            No device selected — open the Devices dashboard and pick a phone first, or select a
            device from the header dropdown.
          </span>
        </div>
      )}

      <div className="mcp-toolbar">
        <button
          className="mcp-run-btn"
          onClick={handleRunAll}
          disabled={isRunning || !selectedDeviceId}
        >
          {isRunning ? <Loader2 size={15} className="spin" /> : <Play size={14} fill="currentColor" />}
          <span>{isRunning ? 'Running tests...' : 'Run tests'}</span>
        </button>

        {executedCount > 0 && (
          <span className="mcp-summary">
            <b>{executedCount}/{TESTS.length}</b> run —{' '}
            <span className="ok">{passCount} passed</span>,{' '}
            <span className={failCount > 0 ? 'bad' : ''}>{failCount} failed</span>
          </span>
        )}
      </div>

      <div className="mcp-list">
        {results.map((res, i) => (
          <div key={i} className="mcp-row">
            <div className={`mcp-row-icon ${res.status}`}>
              {res.status === 'pending' && '·'}
              {res.status === 'running' && <Loader2 size={12} className="spin" />}
              {res.status === 'pass' && <Check size={12} />}
              {res.status === 'fail' && <X size={12} />}
            </div>

            <div className="mcp-row-body">
              <div className="mcp-row-name">{res.name}</div>
              {res.detail && (
                <div className={`mcp-row-detail ${res.status === 'fail' ? 'bad' : ''}`}>
                  {res.detail}
                </div>
              )}
            </div>

            {res.ms !== null && <div className="mcp-row-ms">{res.ms}ms</div>}
          </div>
        ))}
      </div>

      <style>{`
        .mcp-main {
          flex: 1;
          overflow-y: auto;
          padding: 24px;
        }

        .mcp-intro {
          color: var(--muted);
          font-size: 13px;
          line-height: 1.6;
          max-width: 680px;
          margin-bottom: 20px;
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 14px 18px;
        }
        .mcp-intro code {
          background: var(--bg3);
          padding: 2px 5px;
          border-radius: 4px;
          color: var(--text);
          font-size: 12px;
        }

        .mcp-no-device {
          display: flex;
          align-items: center;
          gap: 10px;
          color: var(--amber);
          font-size: 13px;
          background: #f59e0b14;
          border: 1px solid #f59e0b33;
          border-radius: var(--radius);
          padding: 12px 16px;
          max-width: 680px;
          margin-bottom: 20px;
        }

        .mcp-toolbar {
          display: flex;
          align-items: center;
          gap: 14px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }

        .mcp-run-btn {
          background: linear-gradient(135deg, var(--accent), #7c3aed);
          border: none;
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          padding: 9px 20px;
          cursor: pointer;
          box-shadow: 0 2px 10px #6366f130;
          transition: all 0.18s;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .mcp-run-btn:hover:not(:disabled) {
          filter: brightness(1.12);
          box-shadow: 0 4px 16px #6366f144;
        }
        .mcp-run-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .mcp-summary {
          font-size: 13px;
          color: var(--muted);
        }
        .mcp-summary b {
          color: var(--text);
        }
        .mcp-summary .ok {
          color: var(--green);
        }
        .mcp-summary .bad {
          color: var(--red);
        }

        .mcp-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-width: 720px;
        }

        .mcp-row {
          background: var(--bg2);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 12px 16px;
          display: flex;
          align-items: flex-start;
          gap: 14px;
          transition: border-color 0.15s;
        }
        .mcp-row:hover {
          border-color: rgba(255, 255, 255, 0.15);
        }

        .mcp-row-icon {
          flex-shrink: 0;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          margin-top: 1px;
        }
        .mcp-row-icon.pending {
          background: var(--bg3);
          color: var(--muted);
        }
        .mcp-row-icon.running {
          background: #f59e0b22;
          color: var(--amber);
        }
        .mcp-row-icon.pass {
          background: #22c55e22;
          color: var(--green);
        }
        .mcp-row-icon.fail {
          background: #ef444422;
          color: var(--red);
        }

        .mcp-row-body {
          flex: 1;
          min-width: 0;
        }
        .mcp-row-name {
          font-size: 13.5px;
          font-weight: 600;
          color: var(--text);
        }
        .mcp-row-detail {
          font-size: 12px;
          color: var(--muted);
          margin-top: 5px;
          line-height: 1.5;
          word-break: break-word;
          white-space: pre-wrap;
          font-family: monospace;
          background: rgba(0, 0, 0, 0.2);
          padding: 6px 10px;
          border-radius: 6px;
        }
        .mcp-row-detail.bad {
          color: #f87171;
          background: #ef444411;
        }

        .mcp-row-ms {
          flex-shrink: 0;
          font-size: 11px;
          color: var(--muted);
          background: var(--bg3);
          border-radius: 5px;
          padding: 2px 7px;
          margin-top: 1px;
        }

        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
