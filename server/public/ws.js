/**
 * Shared WebSocket helper + auth guard for device-control pages.
 *
 * Usage:
 *   const ws = createWS(onMessage, onBinary);
 *   ws.send({ type: 'control', action: 'tap', x: .5, y: .5 });
 *   ws.destroy();   // call on page unload if needed
 *
 * Auth model:
 *   - JWT stored in localStorage 'pr_token' (set by /login)
 *   - Device being controlled comes from ?device=<id> (falls back to
 *     localStorage 'pr_device'); persisted so tab nav keeps working
 *   - No token, or auth_error from server → redirect to /login
 *
 * The helper:
 *  - Connects using ws:// or wss:// based on current protocol
 *  - Sends { type:'auth', token }, then { type:'register', role:'browser', deviceId }
 *  - Reconnects every 2 s on close
 *  - Updates #dot + #status-text in the header automatically
 *  - Rewrites .tab-btn nav links to carry the ?device= param
 */

const PR = {
  token: localStorage.getItem('pr_token') || '',
  device: new URLSearchParams(location.search).get('device') || localStorage.getItem('pr_device') || '',
  logout() {
    localStorage.removeItem('pr_token');
    localStorage.removeItem('pr_device');
    location.href = '/login';
  },
  api(path, opts = {}) {
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + PR.token }, opts.headers || {});
    return fetch(path, opts).then((r) => {
      if (r.status === 401) { PR.logout(); throw new Error('unauthorized'); }
      return r;
    });
  },
  // For <a href> downloads that can't send headers
  urlWithToken(path) {
    return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(PR.token);
  },
};

// Control pages require both a login and a selected device
(function guard() {
  if (!PR.token) { location.href = '/login'; return; }
  if (!PR.device) {
    document.addEventListener('DOMContentLoaded', () => {
      const status = document.getElementById('status-text');
      if (status) status.textContent = 'No device selected';
      const dot = document.getElementById('dot');
      if (dot) dot.className = 'status-dot';
      const overlay = document.getElementById('overlay');
      const title = document.getElementById('overlay-title');
      const sub = document.getElementById('overlay-sub');
      const btn = document.getElementById('stream-btn');
      if (overlay) overlay.classList.remove('gone');
      if (title) title.textContent = 'No device selected';
      if (sub) sub.textContent = 'Go back to the dashboard and click a phone card.';
      if (btn) btn.style.display = 'none';
    });
    return;
  }
  localStorage.setItem('pr_device', PR.device);

  // Carry ?device= through tab navigation + add a Devices link
  addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a.tab-btn').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('/') && !href.includes('device=')) {
        a.setAttribute('href', href + '?device=' + encodeURIComponent(PR.device));
      }
    });
    const bar = document.querySelector('.tab-bar');
    if (bar && !document.getElementById('nav-devices')) {
      const a = document.createElement('a');
      a.id = 'nav-devices';
      a.className = 'tab-btn';
      a.href = '/dashboard';
      a.textContent = '⊞ Devices';
      bar.insertBefore(a, bar.firstChild);
    }
  });
})();

function createWS(onMessage, onBinary) {
  let socket = null;
  let dead = false;

  const dot    = document.getElementById('dot');
  const status = document.getElementById('status-text');

  function setUI(state, text) {
    if (dot) {
      dot.className = 'status-dot' + (state ? ' ' + state : '');
    }
    if (status) status.textContent = text;
  }

  function connect() {
    if (dead) return;
    setUI('waiting', 'Connecting...');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(proto + '//' + location.host);
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'auth', token: PR.token }));
    };

    socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        onBinary && onBinary(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'auth_error') {
        dead = true;
        PR.logout();
        return;
      }

      if (msg.type === 'device_removed') {
        localStorage.removeItem('pr_device');
        if (location.pathname !== '/dashboard') {
          location.href = '/dashboard';
          return;
        }
      }

      if (msg.type === 'auth_ok') {
        socket.send(JSON.stringify({ type: 'register', role: 'browser', deviceId: PR.device }));
        setUI('waiting', 'Waiting for phone...');
        return;
      }

      if (msg.type === 'phone_connected') {
        const label = msg.model ? msg.model : 'Phone connected';
        setUI('connected', label);
      }

      if (msg.type === 'phone_disconnected' || msg.type === 'device_offline') {
        setUI('waiting', 'Phone disconnected — waiting...');
      }

      onMessage(msg);
    };

    socket.onclose = () => {
      if (!dead) {
        setUI('', 'Reconnecting...');
        setTimeout(connect, 2000);
      }
    };
  }

  connect();

  return {
    send(msg) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    destroy() {
      dead = true;
      socket && socket.close();
    }
  };
}
