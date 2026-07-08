/**
 * Shared WebSocket helper.
 *
 * Usage:
 *   const ws = createWS(onMessage);
 *   ws.send({ type: 'control', action: 'tap', x: .5, y: .5 });
 *   ws.destroy();   // call on page unload if needed
 *
 * The helper:
 *  - Connects using ws:// or wss:// based on current protocol
 *  - Sends { type:'auth' } on open, then { type:'register', role:'browser' } on auth_ok
 *  - Reconnects every 2 s on close
 *  - Updates #dot + #status-text in the header automatically
 *  - Calls onMessage(msg) for every message AFTER auth_ok
 */
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
      socket.send(JSON.stringify({ type: 'auth' }));
    };

    socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        onBinary && onBinary(data);
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'auth_ok') {
        socket.send(JSON.stringify({ type: 'register', role: 'browser' }));
        setUI('waiting', 'Waiting for phone...');
        return;
      }

      if (msg.type === 'phone_connected') {
        const label = msg.model ? msg.model : 'Phone connected';
        setUI('connected', label);
      }

      if (msg.type === 'phone_disconnected') {
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
