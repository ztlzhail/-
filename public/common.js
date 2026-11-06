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

  // 서버 실시간 상태 구독 (SSE + 끊기면 폴링 대체)
  function subscribe(onState) {
    let es, pollTimer;
    const apply = s => { offset = s.serverNow - Date.now(); onState(s); };
    const poll = async () => { try { apply(await api('/api/state')); } catch {} };
    function connect() {
      es = new EventSource('/api/stream');
      es.onmessage = e => { clearInterval(pollTimer); pollTimer = null; apply(JSON.parse(e.data)); };
      es.onerror = () => { if (!pollTimer) pollTimer = setInterval(poll, 3000); };
    }
    connect();
    poll();
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
  function timerView(m) {
    const t = m.timer;
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

  return { api, now, subscribe, mmss, untilText, timeLabel, roundLen, timerView, esc, toast, store };
})();
