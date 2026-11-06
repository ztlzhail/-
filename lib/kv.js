// 저장소: Vercel 에서는 Upstash Redis(REST), 로컬에서는 파일에 저장되는 메모리 Redis 흉내.
// 둘 다 `pipe([[cmd, ...args], ...])` 하나로 쓴다.
'use strict';
const fs = require('fs');
const path = require('path');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function upstash() {
  return {
    kind: 'redis',
    async pipe(cmds) {
      const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.map(c => c.map(String))),
      });
      if (!r.ok) throw new Error('저장소 오류 ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const out = await r.json();
      return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
    },
  };
}

function memory(file) {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let t = null;
  const persist = () => {
    if (!file) return;
    clearTimeout(t);
    t = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(d));
      fs.renameSync(file + '.tmp', file);
    }, 50);
  };
  const H = k => (d[k] && typeof d[k] === 'object' ? d[k] : (d[k] = {}));
  const flat = o => Object.entries(o).flat();
  const ops = {
    GET: k => (typeof d[k] === 'string' ? d[k] : null),
    SET: (k, v) => { d[k] = String(v); return 'OK'; },
    DEL: (...ks) => ks.reduce((n, k) => n + (k in d ? (delete d[k], 1) : 0), 0),
    EXISTS: k => (k in d ? 1 : 0),
    HGET: (k, f) => (H(k)[f] ?? null),
    HSET: (k, ...fv) => { const h = H(k); let n = 0; for (let i = 0; i < fv.length; i += 2) { if (!(fv[i] in h)) n++; h[fv[i]] = String(fv[i + 1]); } return n; },
    HSETNX: (k, f, v) => { const h = H(k); if (f in h) return 0; h[f] = String(v); return 1; },
    HDEL: (k, ...fs_) => { const h = H(k); let n = 0; for (const f of fs_) if (f in h) { delete h[f]; n++; } return n; },
    HGETALL: k => flat(H(k)),
    HMGET: (k, ...fs_) => fs_.map(f => H(k)[f] ?? null),
    HLEN: k => Object.keys(H(k)).length,
    HINCRBY: (k, f, by) => { const h = H(k); h[f] = String((parseInt(h[f], 10) || 0) + Number(by)); return Number(h[f]); },
    ZINCRBY: (k, by, m) => { const h = H(k); h[m] = String((Number(h[m]) || 0) + Number(by)); return h[m]; },
    ZSCORE: (k, m) => (H(k)[m] ?? null),
    ZCARD: k => Object.keys(H(k)).length,
    ZREVRANGE: (k, a, b) => {
      const arr = Object.entries(H(k)).sort((x, y) => Number(y[1]) - Number(x[1]));
      const end = Number(b) < 0 ? arr.length + Number(b) : Number(b);
      return arr.slice(Number(a), end + 1).flat();
    },
  };
  return {
    kind: 'memory',
    async pipe(cmds) {
      const out = cmds.map(([c, ...a]) => {
        const f = ops[String(c).toUpperCase()];
        if (!f) throw new Error('지원하지 않는 명령 ' + c);
        return f(...a.map(String));
      });
      if (cmds.some(c => !/^(GET|HGET|HMGET|HGETALL|HLEN|ZSCORE|ZCARD|ZREVRANGE|EXISTS)$/i.test(c[0]))) persist();
      return out;
    },
  };
}

let kv;
function getKV() {
  if (kv) return kv;
  if (URL_ && TOKEN) kv = upstash();
  else if (process.env.VERCEL) kv = null; // 저장소 미연결
  else kv = memory(path.join(__dirname, '..', 'data', 'kv.json'));
  return kv;
}
module.exports = { getKV };
