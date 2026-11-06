// API 핸들러 — Vercel 함수(api/index.js)와 로컬 서버(server.js)가 함께 쓴다.
'use strict';
const crypto = require('crypto');
const { getKV } = require('./kv');

// 관리자 비밀번호는 해시만 저장. ADMIN_PASSWORD 환경변수로 교체 가능.
const ADMIN_SALT = '25fa17a062be756d';
const ADMIN_HASH = process.env.ADMIN_PASSWORD
  ? sha256(ADMIN_SALT + process.env.ADMIN_PASSWORD)
  : '11f4b11579cb81e6ae5e17256231440d35f38fc60431fbfb17c3b1296115d677';

const SIGNUP_POINTS = 100;
const CORRECT_POINTS = 20;
const UNDERDOG_BONUS = 30;
const MAX_MEDIA = 4 * 1024 * 1024; // data URL 길이 (Vercel 요청 한도 4.5MB)

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function rid(n = 8) { return crypto.randomBytes(n).toString('hex'); }
function safeEqual(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function cleanText(s, max) { return String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }

function seedMatches() {
  return [{
    id: 'today',
    title: 'UFC 335 메인매치',
    sport: '킥복싱',
    venue: '인수실',
    startAt: '2026-11-06T03:35:00.000Z', // 12:35 KST
    rounds: 3, roundSeconds: 70, breakSeconds: 30,
    poster: '/img/poster.jpg',
    fighters: {
      A: { name: '전재신', photo: '/img/fighter-a.jpg', video: null },
      B: { name: '오승민', photo: '/img/fighter-b.jpg', video: null },
    },
    votingOpen: true, result: null, settledUnderdog: null, awards: {},
    timer: { status: 'idle', round: 1, endsAt: null, remainingMs: 70000 },
    createdAt: Date.now(),
  }];
}

// ---------- 타이머 (저장값 + 현재시각으로 계산) ----------
function effTimer(m, now) {
  const t = m.timer;
  if (t.status === 'running' && t.endsAt && now >= t.endsAt) {
    if (t.round >= m.rounds) return { status: 'finished', round: t.round, endsAt: null, remainingMs: 0 };
    const br = (m.breakSeconds || 0) * 1000;
    if (br > 0 && now < t.endsAt + br) return { status: 'break', round: t.round, endsAt: t.endsAt + br, remainingMs: br };
    return { status: 'roundEnd', round: t.round, endsAt: null, remainingMs: 0 };
  }
  return t;
}
function timerAction(m, action, now) {
  const t = { ...effTimer(m, now) };
  const full = m.roundSeconds * 1000;
  switch (action) {
    case 'start':
      if (!['idle', 'roundEnd', 'break'].includes(t.status)) throw httpError(400, '지금은 라운드를 시작할 수 없습니다');
      if (t.status !== 'idle') t.round = Math.min(t.round + 1, m.rounds);
      Object.assign(t, { status: 'running', endsAt: now + full, remainingMs: full });
      m.votingOpen = false; // 경기 시작 시 투표 자동 마감
      break;
    case 'pause':
      if (t.status !== 'running') throw httpError(400, '진행 중이 아닙니다');
      Object.assign(t, { status: 'paused', remainingMs: Math.max(0, t.endsAt - now), endsAt: null });
      break;
    case 'resume':
      if (t.status !== 'paused') throw httpError(400, '일시정지 상태가 아닙니다');
      Object.assign(t, { status: 'running', endsAt: now + t.remainingMs });
      break;
    case 'endRound':
      Object.assign(t, { status: t.round >= m.rounds ? 'finished' : 'roundEnd', endsAt: null, remainingMs: 0 });
      break;
    case 'reset':
      Object.assign(t, { status: 'idle', round: 1, endsAt: null, remainingMs: full });
      break;
    default: throw httpError(400, '알 수 없는 타이머 동작');
  }
  m.timer = t;
}

// ---------- 저장소 접근 ----------
function kv() {
  const k = getKV();
  if (!k) throw httpError(503, '저장소(Redis)가 연결되지 않았습니다. Vercel → Storage 에서 Upstash Redis 를 연결하세요.');
  return k;
}
async function loadMatches() {
  const [raw] = await kv().pipe([['GET', 'matches']]);
  if (raw) return JSON.parse(raw);
  const s = seedMatches();
  await kv().pipe([['SET', 'matches', JSON.stringify(s)]]);
  return s;
}
async function saveMatches(ms) { await kv().pipe([['SET', 'matches', JSON.stringify(ms)]]); }
function findMatch(ms, id) { const m = ms.find(x => x.id === id); if (!m) throw httpError(404, '경기를 찾을 수 없습니다'); return m; }

function tallyOf(h) {
  const A = Number(h.A) || 0, B = Number(h.B) || 0, total = A + B;
  return {
    A, B, total,
    pctA: total ? Math.round((A / total) * 1000) / 10 : 0,
    pctB: total ? Math.round((B / total) * 1000) / 10 : 0,
    underdog: total > 0 && A !== B ? (A < B ? 'A' : 'B') : null,
  };
}
const pairs = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

async function buildState() {
  const ms = (await loadMatches()).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const res = await kv().pipe([
    ...ms.map(m => ['HGETALL', 'tally:' + m.id]),
    ['ZREVRANGE', 'lb', '0', '9', 'WITHSCORES'],
    ['ZCARD', 'lb'],
  ]);
  const lbRaw = res[ms.length] || [];
  const ids = [], scores = [];
  for (let i = 0; i < lbRaw.length; i += 2) { ids.push(lbRaw[i]); scores.push(Number(lbRaw[i + 1])); }
  const names = ids.length ? (await kv().pipe([['HMGET', 'unames', ...ids]]))[0] : [];
  return {
    serverNow: Date.now(),
    matches: ms.map((m, i) => {
      const { awards, ...pub } = m;
      return { ...pub, tally: tallyOf(pairs(res[i])) };
    }),
    leaderboard: ids.map((_, i) => ({ nickname: names[i] || '?', points: scores[i] })),
    userCount: Number(res[ms.length + 1]) || 0,
  };
}

async function userFromReq(req) {
  const t = bearer(req);
  if (!t) return null;
  const [nick] = await kv().pipe([['HGET', 'tokens', sha256(t)]]);
  if (!nick) return null;
  const [raw] = await kv().pipe([['HGET', 'users', nick]]);
  return raw ? JSON.parse(raw) : null;
}
async function meView(u, ms) {
  ms = ms || await loadMatches();
  const res = await kv().pipe([['ZSCORE', 'lb', u.id], ...ms.map(m => ['HGET', 'votes:' + m.id, u.id])]);
  const votes = {};
  ms.forEach((m, i) => { if (res[i + 1]) votes[m.id] = res[i + 1]; });
  return { nickname: u.nickname, points: Number(res[0]) || 0, votes };
}
async function requireAdmin(req) {
  const t = bearer(req);
  if (t) {
    const [exp] = await kv().pipe([['HGET', 'admintok', sha256(t)]]);
    if (exp && Number(exp) > Date.now()) return;
  }
  throw httpError(401, '관리자 로그인이 필요합니다');
}
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; }

// ---------- 결과 정산 ----------
async function settle(m, result) {
  if (m.result) throw httpError(400, '이미 결과가 등록된 경기입니다. 먼저 결과를 취소하세요.');
  const [tRaw, vRaw] = await kv().pipe([['HGETALL', 'tally:' + m.id], ['HGETALL', 'votes:' + m.id]]);
  const underdog = tallyOf(pairs(tRaw)).underdog;
  m.result = result; m.settledUnderdog = underdog; m.votingOpen = false; m.awards = {};
  if (result === 'A' || result === 'B') {
    const gain = CORRECT_POINTS + (underdog === result ? UNDERDOG_BONUS : 0);
    const cmds = [];
    for (const [uid, pick] of Object.entries(pairs(vRaw))) {
      if (pick === result) { m.awards[uid] = gain; cmds.push(['ZINCRBY', 'lb', gain, uid]); }
    }
    if (cmds.length) await kv().pipe(cmds);
  }
}
async function unsettle(m) {
  const cmds = Object.entries(m.awards || {}).map(([uid, g]) => ['ZINCRBY', 'lb', -g, uid]);
  if (cmds.length) await kv().pipe(cmds);
  m.awards = {}; m.result = null; m.settledUnderdog = null;
}

function applyMatchFields(m, b) {
  if (b.title !== undefined) m.title = cleanText(b.title, 40);
  if (b.sport !== undefined) m.sport = cleanText(b.sport, 20);
  if (b.venue !== undefined) m.venue = cleanText(b.venue, 30);
  if (b.startAt !== undefined) { const d = new Date(b.startAt); if (isNaN(d)) throw httpError(400, '경기 시간이 올바르지 않습니다'); m.startAt = d.toISOString(); }
  if (b.rounds !== undefined) m.rounds = Math.min(12, Math.max(1, parseInt(b.rounds, 10) || 3));
  if (b.roundSeconds !== undefined) m.roundSeconds = Math.min(3600, Math.max(5, parseInt(b.roundSeconds, 10) || 70));
  if (b.breakSeconds !== undefined) m.breakSeconds = Math.min(600, Math.max(0, parseInt(b.breakSeconds, 10) || 0));
  if (b.nameA !== undefined) m.fighters.A.name = cleanText(b.nameA, 20);
  if (b.nameB !== undefined) m.fighters.B.name = cleanText(b.nameB, 20);
}

// ---------- HTTP ----------
async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch { throw httpError(400, '잘못된 JSON'); } }
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    return req.body || {};
  }
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 6e6) throw httpError(413, '요청이 너무 큽니다'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, '잘못된 JSON'); }
}
function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const forwarded = url.searchParams.get('__p');
  const p = forwarded !== null ? '/api/' + forwarded.replace(/^\/+/, '') : url.pathname.replace(/\/+$/, '');
  const M = req.method;
  const now = Date.now();

  if (M === 'GET' && p === '/api/state') {
    return send(res, 200, await buildState(), { 'Cache-Control': 'public, max-age=0, must-revalidate', 'Vercel-CDN-Cache-Control': 'max-age=1' });
  }

  const media = M === 'GET' && /^\/api\/media\/([a-f0-9]+)$/.exec(p);
  if (media) {
    const [raw] = await kv().pipe([['GET', 'media:' + media[1]]]);
    const mm = raw && /^data:([\w/+.-]+);base64,(.*)$/s.exec(raw);
    if (!mm) throw httpError(404, '파일 없음');
    const buf = Buffer.from(mm[2], 'base64');
    res.statusCode = 200;
    res.setHeader('Content-Type', mm[1]);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(buf);
  }

  if (M === 'POST' && p === '/api/signup') {
    const { nickname, pin } = await readBody(req);
    const nick = cleanText(nickname, 16);
    if (!nick) throw httpError(400, '닉네임을 입력하세요');
    if (!/^\d{4}$/.test(String(pin || ''))) throw httpError(400, '숫자 4자리 PIN을 입력하세요');
    const key = nick.toLowerCase();
    const salt = rid(8);
    const fresh = { id: 'u' + rid(6), nickname: nick, salt, pinHash: sha256(salt + pin), createdAt: now };
    const [created] = await kv().pipe([['HSETNX', 'users', key, JSON.stringify(fresh)]]);
    let u = fresh;
    if (created) {
      await kv().pipe([['ZINCRBY', 'lb', SIGNUP_POINTS, u.id], ['HSET', 'unames', u.id, nick]]);
    } else {
      u = JSON.parse((await kv().pipe([['HGET', 'users', key]]))[0]);
      if (!safeEqual(u.pinHash, sha256(u.salt + pin))) throw httpError(409, '이미 사용 중인 닉네임입니다. 본인이라면 PIN을 확인하세요.');
    }
    const token = rid(24);
    await kv().pipe([['HSET', 'tokens', sha256(token), key]]);
    return send(res, 200, { token, me: await meView(u) });
  }

  if (M === 'GET' && p === '/api/me') {
    const u = await userFromReq(req);
    if (!u) throw httpError(401, '로그인이 필요합니다');
    return send(res, 200, await meView(u));
  }

  const vm = M === 'POST' && /^\/api\/matches\/([\w-]+)\/vote$/.exec(p);
  if (vm) {
    const u = await userFromReq(req);
    if (!u) throw httpError(401, '먼저 가입하세요');
    const ms = await loadMatches();
    const m = findMatch(ms, vm[1]);
    if (!m.votingOpen || m.result || effTimer(m, now).status !== 'idle') throw httpError(400, '투표가 마감되었습니다');
    const { pick } = await readBody(req);
    if (pick !== 'A' && pick !== 'B') throw httpError(400, '선수를 선택하세요');
    const [ok] = await kv().pipe([['HSETNX', 'votes:' + m.id, u.id, pick]]);
    if (!ok) throw httpError(400, '이미 투표했습니다 (1인 1표)');
    await kv().pipe([['HINCRBY', 'tally:' + m.id, pick, 1]]);
    return send(res, 200, { me: await meView(u, ms), state: await buildState() });
  }

  // ----- 관리자 -----
  if (M === 'POST' && p === '/api/admin/login') {
    const { password } = await readBody(req);
    if (!password || !safeEqual(sha256(ADMIN_SALT + String(password)), ADMIN_HASH)) {
      await new Promise(r => setTimeout(r, 600));
      throw httpError(401, '비밀번호가 틀렸습니다');
    }
    const token = rid(24);
    await kv().pipe([['HSET', 'admintok', sha256(token), now + 3 * 86400e3]]);
    return send(res, 200, { token });
  }

  if (p.startsWith('/api/admin/')) {
    await requireAdmin(req);
    if (M === 'GET' && p === '/api/admin/check') return send(res, 200, { ok: true });

    const ms = await loadMatches();
    if (M === 'POST' && p === '/api/admin/matches') {
      const b = await readBody(req);
      const m = {
        id: 'm' + rid(4), title: '', sport: '', venue: '', startAt: now, rounds: 3, roundSeconds: 70, breakSeconds: 30,
        poster: null, votingOpen: true, result: null, settledUnderdog: null, awards: {}, createdAt: now,
        fighters: { A: { name: '', photo: null, video: null }, B: { name: '', photo: null, video: null } },
      };
      applyMatchFields(m, b);
      m.startAt = new Date(m.startAt).toISOString();
      if (!m.fighters.A.name || !m.fighters.B.name) throw httpError(400, '두 선수 이름을 입력하세요');
      m.timer = { status: 'idle', round: 1, endsAt: null, remainingMs: m.roundSeconds * 1000 };
      ms.push(m);
      await saveMatches(ms);
      return send(res, 200, await buildState());
    }

    const mm = /^\/api\/admin\/matches\/([\w-]+)(?:\/(\w+))?$/.exec(p);
    if (mm) {
      let m = findMatch(ms, mm[1]);
      const sub = mm[2];
      let list = ms;
      if (M === 'PATCH' && !sub) {
        applyMatchFields(m, await readBody(req));
        if (m.timer.status === 'idle') m.timer.remainingMs = m.roundSeconds * 1000;
      } else if (M === 'DELETE' && !sub) {
        if (m.result) await unsettle(m);
        await kv().pipe([['DEL', 'votes:' + m.id, 'tally:' + m.id]]);
        list = ms.filter(x => x !== m);
      } else if (M === 'POST' && sub === 'voting') {
        const { open } = await readBody(req);
        if (open && m.result) throw httpError(400, '결과가 등록된 경기는 투표를 열 수 없습니다');
        m.votingOpen = !!open;
      } else if (M === 'POST' && sub === 'result') {
        const { result } = await readBody(req);
        if (result === null) await unsettle(m);
        else if (['A', 'B', 'DRAW'].includes(result)) await settle(m, result);
        else throw httpError(400, '결과 값이 올바르지 않습니다');
      } else if (M === 'POST' && sub === 'timer') {
        const { action } = await readBody(req);
        timerAction(m, action, now);
      } else if (M === 'POST' && sub === 'media') {
        const { slot, dataUrl, url: link, clear } = await readBody(req);
        if (!/^(poster|photoA|photoB|videoA|videoB)$/.test(slot || '')) throw httpError(400, '위치가 올바르지 않습니다');
        const isVideo = slot.startsWith('video');
        let value = null;
        if (clear) value = null;
        else if (dataUrl) {
          const ok = isVideo ? /^data:video\/(mp4|webm|quicktime);base64,/ : /^data:image\/(jpeg|png|webp|gif);base64,/;
          if (!ok.test(dataUrl)) throw httpError(400, isVideo ? '영상 파일(mp4/webm/mov)만 가능합니다' : '이미지 파일만 가능합니다');
          if (dataUrl.length > MAX_MEDIA) throw httpError(413, '파일이 너무 큽니다. 영상은 3MB 이하 파일이나 유튜브 링크를 쓰세요.');
          const id = rid(10);
          await kv().pipe([['SET', 'media:' + id, dataUrl]]);
          value = '/api/media/' + id;
        } else if (link) {
          if (!/^https?:\/\/\S+$/i.test(link)) throw httpError(400, 'http(s) 링크를 입력하세요');
          value = String(link).slice(0, 500);
        } else throw httpError(400, '파일이나 링크가 없습니다');
        if (slot === 'poster') m.poster = value;
        else m.fighters[slot.slice(-1)][isVideo ? 'video' : 'photo'] = value;
      } else {
        throw httpError(404, 'Not found');
      }
      await saveMatches(list);
      return send(res, 200, await buildState());
    }
  }
  throw httpError(404, 'Not found');
}

async function handler(req, res) {
  try { await route(req, res); }
  catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : '서버 오류: ' + e.message });
  }
}

module.exports = { handler, effTimer };
