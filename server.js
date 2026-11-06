// 격투 승부 예측 서버 — 외부 패키지 없이 Node 18+ 에서 실행: `node server.js`
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_UPLOAD = 300 * 1024 * 1024; // 300MB

// 관리자 비밀번호: 평문은 저장소에 남기지 않고 해시만 둔다. ADMIN_PASSWORD 환경변수로 바꿀 수 있다.
const ADMIN_SALT = '25fa17a062be756d';
const ADMIN_HASH = process.env.ADMIN_PASSWORD
  ? sha256(ADMIN_SALT + process.env.ADMIN_PASSWORD)
  : '11f4b11579cb81e6ae5e17256231440d35f38fc60431fbfb17c3b1296115d677';

const SIGNUP_POINTS = 100;
const CORRECT_POINTS = 20;       // 예측 적중
const UNDERDOG_BONUS = 30;       // 언더독 적중 추가

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function id(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- DB ----------
let db;
function seed() {
  return {
    users: [],
    adminTokens: [],
    matches: [{
      id: 'm' + id(4),
      title: '오늘의 메인 이벤트',
      sport: '킥복싱',
      venue: '인수실',
      startAt: '2026-11-06T12:35:00+09:00',
      rounds: 3,
      roundSeconds: 70,
      breakSeconds: 30,
      poster: null,
      fighters: {
        A: { name: '전재신', photo: null, video: null },
        B: { name: '오승민', photo: null, video: null },
      },
      votingOpen: true,
      votes: {},              // userId -> 'A' | 'B'
      result: null,           // 'A' | 'B' | 'DRAW'
      settledUnderdog: null,
      timer: { status: 'idle', round: 1, endsAt: null, remainingMs: 70000 },
      createdAt: Date.now(),
    }],
  };
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }, 50);
}
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = seed(); save(); }

// ---------- 집계 ----------
function tally(m) {
  let A = 0, B = 0;
  for (const v of Object.values(m.votes)) v === 'A' ? A++ : B++;
  const total = A + B;
  let underdog = null;
  if (total > 0 && A !== B) underdog = A < B ? 'A' : 'B';
  return { A, B, total, pctA: total ? Math.round((A / total) * 1000) / 10 : 0, pctB: total ? Math.round((B / total) * 1000) / 10 : 0, underdog };
}

function publicMatch(m) {
  return {
    id: m.id, title: m.title, sport: m.sport, venue: m.venue, startAt: m.startAt,
    rounds: m.rounds, roundSeconds: m.roundSeconds, breakSeconds: m.breakSeconds,
    poster: m.poster, fighters: m.fighters, votingOpen: m.votingOpen, result: m.result,
    settledUnderdog: m.settledUnderdog,
    tally: tally(m), timer: m.timer, createdAt: m.createdAt,
  };
}

function leaderboard() {
  return [...db.users].sort((a, b) => b.points - a.points || a.createdAt - b.createdAt)
    .slice(0, 10).map(u => ({ nickname: u.nickname, points: u.points }));
}

function publicState() {
  const matches = [...db.matches].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  return { serverNow: Date.now(), matches: matches.map(publicMatch), leaderboard: leaderboard(), userCount: db.users.length };
}

// ---------- 타이머 (서버 기준) ----------
// status: idle | running | paused | break | roundEnd | finished
function tickTimers() {
  const now = Date.now();
  let changed = false;
  for (const m of db.matches) {
    const t = m.timer;
    if ((t.status === 'running' || t.status === 'break') && t.endsAt && now >= t.endsAt) {
      if (t.status === 'running') {
        if (t.round >= m.rounds) {
          Object.assign(t, { status: 'finished', endsAt: null, remainingMs: 0 });
        } else if (m.breakSeconds > 0) {
          Object.assign(t, { status: 'break', endsAt: t.endsAt + m.breakSeconds * 1000, remainingMs: m.breakSeconds * 1000 });
        } else {
          Object.assign(t, { status: 'roundEnd', endsAt: null, remainingMs: 0 });
        }
      } else {
        Object.assign(t, { status: 'roundEnd', endsAt: null, remainingMs: 0 });
      }
      changed = true;
    }
  }
  if (changed) { save(); broadcast(); }
}
setInterval(tickTimers, 250);

function timerAction(m, action) {
  const t = m.timer;
  const now = Date.now();
  const full = m.roundSeconds * 1000;
  switch (action) {
    case 'start': // 현재 라운드 시작 (idle/roundEnd/break 에서)
      if (t.status === 'roundEnd' || t.status === 'break') t.round = Math.min(t.round + 1, m.rounds);
      Object.assign(t, { status: 'running', endsAt: now + full, remainingMs: full });
      if (m.votingOpen) m.votingOpen = false; // 경기 시작 시 투표 자동 마감
      break;
    case 'pause':
      if (t.status === 'running') Object.assign(t, { status: 'paused', remainingMs: Math.max(0, t.endsAt - now), endsAt: null });
      break;
    case 'resume':
      if (t.status === 'paused') Object.assign(t, { status: 'running', endsAt: now + t.remainingMs });
      break;
    case 'endRound':
      if (t.round >= m.rounds) Object.assign(t, { status: 'finished', endsAt: null, remainingMs: 0 });
      else Object.assign(t, { status: 'roundEnd', endsAt: null, remainingMs: 0 });
      break;
    case 'reset':
      m.timer = { status: 'idle', round: 1, endsAt: null, remainingMs: full };
      break;
    default: throw httpError(400, '알 수 없는 타이머 동작');
  }
}

// ---------- 결과 정산 ----------
function settle(m, result) {
  if (m.result) throw httpError(400, '이미 결과가 등록된 경기입니다. 먼저 결과를 취소하세요.');
  const { underdog } = tally(m);
  m.result = result;
  m.settledUnderdog = underdog;
  m.votingOpen = false;
  m.awards = {};
  if (result === 'A' || result === 'B') {
    for (const [uid, pick] of Object.entries(m.votes)) {
      if (pick !== result) continue;
      const u = db.users.find(x => x.id === uid);
      if (!u) continue;
      const gain = CORRECT_POINTS + (underdog === result ? UNDERDOG_BONUS : 0);
      u.points += gain;
      m.awards[uid] = gain;
    }
  }
}
function unsettle(m) {
  for (const [uid, gain] of Object.entries(m.awards || {})) {
    const u = db.users.find(x => x.id === uid);
    if (u) u.points -= gain;
  }
  m.awards = {};
  m.result = null;
  m.settledUnderdog = null;
}

// ---------- SSE ----------
const clients = new Set();
function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(payload);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000);

// ---------- HTTP helpers ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpError(413, '요청이 너무 큽니다')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, '잘못된 JSON')); } });
    req.on('error', reject);
  });
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }
function currentUser(req) { const t = bearer(req); return t ? db.users.find(u => u.tokenHash === sha256(t)) : null; }
function requireAdmin(req) {
  const t = bearer(req);
  if (!t || !db.adminTokens.includes(sha256(t))) throw httpError(401, '관리자 로그인이 필요합니다');
}
function findMatch(mid) { const m = db.matches.find(x => x.id === mid); if (!m) throw httpError(404, '경기를 찾을 수 없습니다'); return m; }
function meView(u) {
  const votes = {};
  for (const m of db.matches) if (m.votes[u.id]) votes[m.id] = m.votes[u.id];
  return { nickname: u.nickname, points: u.points, votes };
}
function cleanText(s, max) { return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.ico': 'image/x-icon',
};
const UPLOAD_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v' };

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const isUpload = file.startsWith(UPLOAD_DIR);
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': isUpload ? 'public, max-age=31536000, immutable' : 'no-cache' };
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
      if (start < 0 || start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- 라우팅 ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const M = req.method;

  if (M === 'GET' && p === '/api/state') return send(res, 200, publicState());

  if (M === 'GET' && p === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 2000\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 회원가입 / 로그인 — 닉네임 + 숫자 4자리
  if (M === 'POST' && p === '/api/signup') {
    const { nickname, pin } = await readJson(req);
    const nick = cleanText(nickname, 16);
    if (nick.length < 1) throw httpError(400, '닉네임을 입력하세요');
    if (!/^\d{4}$/.test(String(pin || ''))) throw httpError(400, '숫자 4자리 PIN을 입력하세요');
    let u = db.users.find(x => x.nickname.toLowerCase() === nick.toLowerCase());
    if (u) {
      if (!safeEqual(u.pinHash, sha256(u.salt + pin))) throw httpError(409, '이미 사용 중인 닉네임입니다. 본인이라면 PIN을 확인하세요.');
    } else {
      const salt = id(8);
      u = { id: 'u' + id(6), nickname: nick, salt, pinHash: sha256(salt + pin), tokenHash: '', points: SIGNUP_POINTS, createdAt: Date.now() };
      db.users.push(u);
    }
    const token = id(24);
    u.tokenHash = sha256(token);
    save(); broadcast();
    return send(res, 200, { token, me: meView(u) });
  }

  if (M === 'GET' && p === '/api/me') {
    const u = currentUser(req);
    if (!u) throw httpError(401, '로그인이 필요합니다');
    return send(res, 200, meView(u));
  }

  const voteMatch = M === 'POST' && /^\/api\/matches\/([\w-]+)\/vote$/.exec(p);
  if (voteMatch) {
    const u = currentUser(req);
    if (!u) throw httpError(401, '먼저 가입하세요');
    const m = findMatch(voteMatch[1]);
    if (!m.votingOpen || m.result) throw httpError(400, '투표가 마감되었습니다');
    if (m.votes[u.id]) throw httpError(400, '이미 투표했습니다 (1인 1표)');
    const { pick } = await readJson(req);
    if (pick !== 'A' && pick !== 'B') throw httpError(400, '선수를 선택하세요');
    m.votes[u.id] = pick;
    save(); broadcast();
    return send(res, 200, meView(u));
  }

  // ----- 관리자 -----
  if (M === 'POST' && p === '/api/admin/login') {
    const { password } = await readJson(req);
    if (!password || !safeEqual(sha256(ADMIN_SALT + String(password)), ADMIN_HASH)) {
      await new Promise(r => setTimeout(r, 600));
      throw httpError(401, '비밀번호가 틀렸습니다');
    }
    const token = id(24);
    db.adminTokens = [...db.adminTokens.slice(-19), sha256(token)];
    save();
    return send(res, 200, { token });
  }

  if (p.startsWith('/api/admin/')) {
    requireAdmin(req);

    if (M === 'GET' && p === '/api/admin/check') return send(res, 200, { ok: true });

    if (M === 'POST' && p === '/api/admin/matches') {
      const b = await readJson(req);
      const m = {
        id: 'm' + id(4), poster: null, votes: {}, result: null, settledUnderdog: null, votingOpen: true, createdAt: Date.now(),
        fighters: { A: { name: '', photo: null, video: null }, B: { name: '', photo: null, video: null } },
      };
      applyMatchFields(m, b);
      if (!m.fighters.A.name || !m.fighters.B.name) throw httpError(400, '두 선수 이름을 입력하세요');
      m.timer = { status: 'idle', round: 1, endsAt: null, remainingMs: m.roundSeconds * 1000 };
      db.matches.push(m);
      save(); broadcast();
      return send(res, 200, publicMatch(m));
    }

    const mm = /^\/api\/admin\/matches\/([\w-]+)(?:\/(\w+))?$/.exec(p);
    if (mm) {
      const m = findMatch(mm[1]);
      const sub = mm[2];
      if (M === 'PATCH' && !sub) {
        applyMatchFields(m, await readJson(req));
        if (m.timer.status === 'idle') m.timer.remainingMs = m.roundSeconds * 1000;
      } else if (M === 'DELETE' && !sub) {
        if (m.result) unsettle(m);
        db.matches = db.matches.filter(x => x !== m);
      } else if (M === 'POST' && sub === 'voting') {
        const { open } = await readJson(req);
        if (open && m.result) throw httpError(400, '결과가 등록된 경기는 투표를 열 수 없습니다');
        m.votingOpen = !!open;
      } else if (M === 'POST' && sub === 'result') {
        const { result } = await readJson(req);
        if (result === null) unsettle(m);
        else if (['A', 'B', 'DRAW'].includes(result)) settle(m, result);
        else throw httpError(400, '결과 값이 올바르지 않습니다');
      } else if (M === 'POST' && sub === 'timer') {
        const { action } = await readJson(req);
        timerAction(m, action);
      } else if (M === 'POST' && sub === 'upload') {
        const slot = url.searchParams.get('slot');
        const valid = ['poster', 'photoA', 'photoB', 'videoA', 'videoB'];
        if (!valid.includes(slot)) throw httpError(400, '업로드 위치가 올바르지 않습니다');
        const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const ext = UPLOAD_EXT[type];
        const wantVideo = slot.startsWith('video');
        if (!ext || type.startsWith('video') !== wantVideo) throw httpError(400, wantVideo ? '영상 파일(mp4/webm/mov)만 가능합니다' : '이미지 파일(jpg/png/webp/gif)만 가능합니다');
        const name = id(10) + ext;
        await receiveFile(req, path.join(UPLOAD_DIR, name));
        const urlPath = '/uploads/' + name;
        if (slot === 'poster') m.poster = urlPath;
        else m.fighters[slot.slice(-1)][wantVideo ? 'video' : 'photo'] = urlPath;
      } else if (M === 'POST' && sub === 'clearMedia') {
        const { slot } = await readJson(req);
        if (slot === 'poster') m.poster = null;
        else if (/^(photo|video)[AB]$/.test(slot)) m.fighters[slot.slice(-1)][slot.slice(0, 5)] = null;
      } else {
        throw httpError(404, 'Not found');
      }
      save(); broadcast();
      return send(res, 200, db.matches.includes(m) ? publicMatch(m) : { ok: true });
    }
  }

  throw httpError(404, 'Not found');
}

function applyMatchFields(m, b) {
  if (b.title !== undefined) m.title = cleanText(b.title, 40);
  if (b.sport !== undefined) m.sport = cleanText(b.sport, 20);
  if (b.venue !== undefined) m.venue = cleanText(b.venue, 30);
  if (b.startAt !== undefined) {
    const d = new Date(b.startAt);
    if (isNaN(d)) throw httpError(400, '경기 시간이 올바르지 않습니다');
    m.startAt = d.toISOString();
  }
  if (b.rounds !== undefined) m.rounds = Math.min(12, Math.max(1, parseInt(b.rounds, 10) || 3));
  if (b.roundSeconds !== undefined) m.roundSeconds = Math.min(3600, Math.max(5, parseInt(b.roundSeconds, 10) || 70));
  if (b.breakSeconds !== undefined) m.breakSeconds = Math.min(600, Math.max(0, parseInt(b.breakSeconds, 10) || 0));
  if (b.nameA !== undefined) m.fighters.A.name = cleanText(b.nameA, 20);
  if (b.nameB !== undefined) m.fighters.B.name = cleanText(b.nameB, 20);
  m.title ??= ''; m.sport ??= ''; m.venue ??= '';
  m.rounds ??= 3; m.roundSeconds ??= 70; m.breakSeconds ??= 30;
  if (!m.startAt) m.startAt = new Date().toISOString();
}

function receiveFile(req, dest) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_UPLOAD) { req.resume(); return reject(httpError(413, '파일이 너무 큽니다 (최대 300MB)')); }
    let size = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', c => {
      size += c.length;
      if (size > MAX_UPLOAD) { req.unpipe(out); out.destroy(); fs.rm(dest, () => {}); reject(httpError(413, '파일이 너무 큽니다 (최대 300MB)')); req.destroy(); }
    });
    req.pipe(out);
    out.on('finish', () => size > 0 ? resolve() : (fs.rm(dest, () => {}), reject(httpError(400, '빈 파일입니다'))));
    out.on('error', reject);
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/uploads/')) {
      const name = path.basename(url.pathname);
      return serveFile(req, res, path.join(UPLOAD_DIR, name));
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/admin') rel = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    serveFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '서버 오류' });
    if (!e.status) console.error(e);
  }
});

server.listen(PORT, () => {
  console.log(`\n  🥊 승부 예측 서버 실행 중`);
  console.log(`     이 컴퓨터:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`     같은 와이파이: http://${a.address}:${PORT}`);
  }
  console.log(`     관리자 화면: http://localhost:${PORT}/admin\n`);
});
