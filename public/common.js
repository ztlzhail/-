// 공용 유틸 — 메인/관리자 화면에서 함께 사용
window.FX = (() => {
  let offset = 0; // serverNow - clientNow

  async function api(path, { method = 'GET', body, token, raw, contentType } = {}) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (raw) { payload = raw; headers['Content-Type'] = contentType || raw.type || 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(path, { method, headers, body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || '요청 실패'); e.status = res.status; throw e; }
    return data;
  }

  function now() { return Date.now() + offset; }

  // 서버 상태 구독 (주기적 갱신 + 화면 복귀 시 즉시 갱신)
  let onStateCb = null, inflight = false;
  function apply(s) { offset = s.serverNow - Date.now(); if (onStateCb) onStateCb(s); }
  async function refresh() {
    if (inflight) return; inflight = true;
    try { apply(await api('/api/state')); } catch (e) { if (onStateCb && e.status === 503) toast(e.message); }
    finally { inflight = false; }
  }
  function subscribe(onState, ms = 2000) {
    onStateCb = onState;
    refresh();
    setInterval(() => { if (!document.hidden) refresh(); }, ms);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }
  function untilText(ms) {
    if (ms <= 0) return null;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (d ? d + '일 ' : '') + `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }
  function timeLabel(iso) {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
  function roundLen(m) {
    const s = m.roundSeconds;
    return s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ' ' + (s % 60) + '초' : ''}` : `${s}초`;
  }

  // 타이머의 현재 표시값
  function effTimer(m, at) {
    const t = m.timer;
    if (t.status === 'running' && t.endsAt && at >= t.endsAt) {
      if (t.round >= m.rounds) return { status: 'finished', round: t.round, endsAt: null, remainingMs: 0 };
      const br = (m.breakSeconds || 0) * 1000;
      if (br > 0 && at < t.endsAt + br) return { status: 'break', round: t.round, endsAt: t.endsAt + br, remainingMs: br };
      return { status: 'roundEnd', round: t.round, endsAt: null, remainingMs: 0 };
    }
    return t;
  }
  function timerView(m) {
    const t = effTimer(m, now());
    let remaining = t.remainingMs;
    if ((t.status === 'running' || t.status === 'break') && t.endsAt) remaining = Math.max(0, t.endsAt - now());
    const map = {
      idle: `1라운드 대기`,
      running: `${t.round}라운드 진행 중`,
      paused: `${t.round}라운드 일시정지`,
      break: `${t.round}라운드 종료 · 휴식`,
      roundEnd: `${Math.min(t.round + 1, m.rounds)}라운드 대기`,
      finished: `경기 종료`,
    };
    let clock = mmss(remaining);
    if (t.status === 'idle') clock = mmss(m.roundSeconds * 1000);
    if (t.status === 'roundEnd') clock = mmss(m.roundSeconds * 1000);
    if (t.status === 'finished') clock = '0:00';
    return { status: t.status, round: t.round, remaining, clock, label: map[t.status] || '' };
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val); } catch { return null; }
  }

  return { api, now, subscribe, apply, refresh, effTimer, mmss, untilText, timeLabel, roundLen, timerView, esc, toast, store };
})();
