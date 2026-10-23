/* `npm run mobile`: opens a free Cloudflare tunnel, then starts the server with the Telegram Mini App menu button pointing at it. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.CABINSCOUT_PORT || 3000;
const exe = ['cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe'].find((p) => p === 'cloudflared' || fs.existsSync(p));
const tunnel = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let started = false, server;

const onOut = (b) => {
  const m = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(b.toString());
  if (!m || started) return;
  started = true;
  console.log(`  Tunnel up: https://${m[1]}`);
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit', env: { ...process.env, ALLOW_HOST: m[1], PUBLIC_URL: 'https://' + m[1] } });
  server.on('exit', () => tunnel.kill());
};
tunnel.stdout.on('data', onOut);
tunnel.stderr.on('data', onOut);
tunnel.on('error', () => { console.error('cloudflared not found. Install it: winget install Cloudflare.cloudflared (Windows), brew install cloudflared (Mac), or see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads'); process.exit(1); });
tunnel.on('exit', () => { if (server) server.kill(); process.exit(0); });
process.on('SIGINT', () => { tunnel.kill(); process.exit(0); });
