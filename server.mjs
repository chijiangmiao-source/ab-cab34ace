// server.mjs —— 静态页面 + 演练 API + 原子持久化 + /healthz
import http from 'node:http';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSheet, DrillSession, DrillError, assertConverged } from './public/drill.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = existsSync(DIST_DIR) ? DIST_DIR : path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let session = null;

async function persist() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), session: session ? session.toJSON() : null });
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, DATA_FILE);
}

async function restore() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    if (raw.session) session = DrillSession.fromJSON(raw.session);
    console.log(`[restore] 已恢复 ${raw.session?.replicaCount ?? 0} 副本会话，${raw.session?.linesApplied ?? 0} 条动作日志`);
  } catch (err) {
    console.error('[restore] 状态文件损坏，忽略：', err.message);
  }
}

function publicState() {
  if (!session) return null;
  return {
    replicaCount: session.replicaCount,
    linesApplied: session.linesApplied,
    converged: assertConverged(session),
    frames: session.frames,
    snapshots: session.replicas.map((r) => r.snapshot())
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const send = (code, body, headers = {}) => {
    res.writeHead(code, headers);
    res.end(body);
  };
  const sendJson = (code, obj) => send(code, JSON.stringify(obj), { 'Content-Type': MIME['.json'] });

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(200, { ok: true, replicas: session?.replicaCount ?? 0, saved: existsSync(DATA_FILE) });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(200, publicState());
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJson(req);
      const sheet = parseSheet(String(body.sheet ?? ''));
      session = new DrillSession(sheet.replicaCount);
      for (const line of sheet.lines) session.apply(line);
      await persist();
      return sendJson(200, { ok: true, converged: assertConverged(session), state: publicState() });
    }

    if (req.method === 'POST' && url.pathname === '/api/append') {
      if (!session) return sendJson(409, { ok: false, error: '尚无演练单，请先整段执行' });
      const body = await readJson(req);
      const frame = session.applyText(String(body.line ?? ''));
      await persist();
      return sendJson(200, { ok: true, frame, converged: assertConverged(session), state: publicState() });
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      session = null;
      await persist();
      return sendJson(200, { ok: true });
    }

    if (req.method === 'GET') {
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!filePath.startsWith(PUBLIC_DIR)) return send(403, 'Forbidden');
      try {
        const data = await readFile(filePath);
        return send(200, data, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      } catch {
        return send(404, 'Not Found');
      }
    }

    send(405, 'Method Not Allowed');
  } catch (err) {
    if (err instanceof DrillError) return sendJson(400, { ok: false, error: err.message });
    if (err instanceof SyntaxError) return sendJson(400, { ok: false, error: '请求体不是合法 JSON' });
    console.error(err);
    sendJson(500, { ok: false, error: err.message });
  }
});

restore().finally(() => {
  server.listen(PORT, HOST, () => {
    console.log(`姿控步骤单演练台监听 http://${HOST}:${PORT}（健康检查 /healthz）`);
  });
});
