/**
 * PM2 process file — `pm2 start ecosystem.config.js`
 *
 * IMPORTANT: exec_mode must stay 'fork' with a single instance.
 * The signaling layer keeps live WebSocket connections in an in-process
 * map (accounts → phones/browsers). PM2 cluster mode would split phones
 * and browsers across processes that can't see each other. To scale
 * beyond one process later, add a Redis pub/sub relay first.
 */
module.exports = {
  apps: [
    {
      name: 'phone-remote',
      script: 'src/index.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      out_file: 'logs/out.log',
      error_file: 'logs/err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
