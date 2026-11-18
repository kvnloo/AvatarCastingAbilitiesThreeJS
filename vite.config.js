import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

/**
 * Dev-only bridges for Force mode. Both run server-side so secrets never reach
 * page JavaScript:
 *   /neuro/*          → the local NeuroSkill daemon (Muse EEG), bearer token attached here
 *   /oura/readiness   → today's Oura readiness score, if OURA_TOKEN is set
 */
const NEURO_URL = process.env.NEUROSKILL_URL ?? 'http://127.0.0.1:8765';
const NEURO_TOKEN_FILE =
  process.env.NEUROSKILL_TOKEN_FILE ??
  '/mnt/zer0models/workspace/zer0/services/neuroskill/home/.config/skill/daemon/auth.token';

function neuroToken() {
  try {
    return readFileSync(NEURO_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function ouraReadiness() {
  return {
    name: 'oura-readiness',
    configureServer(server) {
      server.middlewares.use('/oura/readiness', async (_req, res) => {
        const token = process.env.OURA_TOKEN;
        res.setHeader('content-type', 'application/json');
        // No token is a normal setup, not an error: the HUD falls back to manual entry.
        if (!token) return res.end('{"score":null,"reason":"OURA_TOKEN not set"}');
        try {
          const day = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
          const r = await fetch(
            `https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=${day}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const data = (await r.json()).data ?? [];
          res.end(JSON.stringify({ score: data.at(-1)?.score ?? null, day: data.at(-1)?.day ?? null }));
        } catch (err) {
          res.statusCode = 502;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    }
  };
}

export default defineConfig({
  base: './',
  plugins: [ouraReadiness()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
    proxy: {
      '/neuro': {
        target: NEURO_URL,
        ws: true,
        rewrite: (path) => path.replace(/^\/neuro/, ''),
        configure: (proxy) => {
          const auth = (proxyReq) => proxyReq.setHeader('Authorization', `Bearer ${neuroToken()}`);
          proxy.on('proxyReq', auth);
          proxy.on('proxyReqWs', auth);
        }
      }
    }
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000
  },
  // Large binary assets (FBX / HDR) live in /public and are served untouched.
  assetsInclude: ['**/*.fbx', '**/*.hdr']
});
