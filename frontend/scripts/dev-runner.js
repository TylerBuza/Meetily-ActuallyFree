#!/usr/bin/env node
/**
 * dev-runner.js
 * Next.js dev server supervisor with:
 * 1. Stale port cleanup to prevent port collision/zombie processes.
 * 2. Background pre-warming of initial chunks (app/layout, app/page, etc.) while Tauri/Cargo builds.
 * 3. Graceful shutdown propagation.
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const PORT = 3118;
const DEV_URL = `http://localhost:${PORT}`;

// 1. Clean up stale process on PORT if needed (Windows)
if (os.platform() === 'win32') {
  try {
    const netstatOut = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = netstatOut.trim().split('\n');
    const pids = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pidStr = parts[parts.length - 1];
      const pidNum = Number(pidStr);
      if (pidNum && pidNum > 0 && pidNum !== process.pid) {
        pids.add(pidNum);
      }
    }
    for (const pid of pids) {
      console.log(`🧹 [Dev-Runner] Cleaning up stale process PID ${pid} on port ${PORT}...`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {}
    }
  } catch (_) {
    // Port not in use, continue cleanly
  }
}

// 2. Spawn Next.js dev server
const nextBin = path.resolve(__dirname, '../node_modules/next/dist/bin/next');
console.log(`🚀 [Dev-Runner] Starting Next.js dev server on port ${PORT}...`);

const nextProcess = spawn(process.execPath, [nextBin, 'dev', '-p', String(PORT)], {
  stdio: 'inherit',
  cwd: path.resolve(__dirname, '..'),
  env: process.env,
});

nextProcess.on('exit', (code) => {
  process.exit(code || 0);
});

['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    try {
      nextProcess.kill(sig);
    } catch (_) {}
    process.exit(0);
  });
});

// 3. Pre-warm frontend chunks while Cargo / Tauri builds Rust
function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function prewarm() {
  // Poll until Next.js HTTP server starts listening
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetchUrl(`${DEV_URL}/`);
    if (res && res.status === 200) {
      console.log('⚡ [Dev-Runner] Next.js dev server is ready. Pre-warming compilation chunks...');

      // Find all script tags pointing to static chunks in HTML response
      const scriptRegex = /<script[^>]+src=["'](\/_next\/static\/chunks\/[^"']+)["']/g;
      const chunks = [];
      let match;
      while ((match = scriptRegex.exec(res.body)) !== null) {
        chunks.push(match[1]);
      }

      // Also trigger /index.html rewrite check
      chunks.push('/index.html');

      // Fetch all chunks in parallel so Next.js dev compiler builds and caches them
      await Promise.all(
        chunks.map(async (chunkPath) => {
          const chunkUrl = chunkPath.startsWith('http') ? chunkPath : `${DEV_URL}${chunkPath}`;
          try {
            await fetchUrl(chunkUrl);
          } catch (_) {}
        })
      );

      console.log(`✅ [Dev-Runner] Pre-warmed ${chunks.length} chunks. Ready for WebView2!`);
      break;
    }
  }
}

prewarm();
