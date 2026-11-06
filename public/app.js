(() => {
  const { api, subscribe, apply, esc, toast, store, timerView, effTimer, untilText, timeLabel, roundLen, now } = FX;
  const isFileVideo = u => /^\/api\/media\/|\.(mp4|webm|mov|m4v)(\?|$)/i.test(u || '');
  const params = new URLSearchParams(location.search);
  if (params.has('display')) document.body.classList.add('display');

  let state = null;
  let me = null;
  let token = store('fx_token');
  let selectedId = params.get('match') || null;
  let pendingPick = null;
  let structKey = '';

  const $ = s => document.querySelector(s);
  const feature = $('#feature');

  // ---------- 사용자 ----------
  async function loadMe() {
    if (!token) { me = null; return renderUser(); }
    try { me = await api('/api/me', { token }); }
    catch (e) { if (e.status === 401) { token = null; store('fx_token', null); me = null; } }
    renderUser();
    render(true);
  }
  function renderUser() {
    const el = $('#userArea');
    if (me) el.innerHTML = `<span class="chip">${esc(me.nickname)} · <span class="pts">${me.points.toLocaleString()} P</span></span>`;
    else el.innerHTML = `<button class="btn sm" id="joinBtn">가입하고 100P 받기</button>`;
    const jb = $('#joinBtn'); if (jb) jb.onclick = () => openModal('signupModal');
  }

  function openModal(id) { const m = document.getElementById(id); m.classList.add('open'); const i = m.querySelector('input'); if (i) setTimeout(() => i.focus(), 50); }
  function closeModal(m) { m.classList.remove('open'); const v = m.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } }
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m || e.target.hasAttribute('data-close')) { closeModal(m); if (m.id === 'signupModal') pendingPick = null; } });
  });

  $('#pin').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('#signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#signupErr'); err.textContent = '';
    try {
      const r = await api('/api/signup', { method: 'POST', body: { nickname: $('#nick').value, pin: $('#pin').value } });
      token = r.token; store('fx_token', token); me = r.me;
      closeModal($('#signupModal'));
      renderUser();
      toast(`${me.nickname}님 환영해요! 현재 ${me.points}P`);
      if (pendingPick) { const p = pendingPick; pendingPick = null; await vote(p.mid, p.pick); }
      else render(true);
    } catch (ex) { err.textContent = ex.message; }
  });

  async function vote(mid, pick) {
    if (!me) { pendingPick = { mid, pick }; return openModal('signupModal'); }
    const m = state.matches.find(x => x.id === mid);
    const name = m.fighters[pick].name;
    if (me.votes[mid]) return toast('이미 투표했어요');
    if (!confirm(`${name} 선수에게 투표할까요?\n1인 1표, 투표 후 변경할 수 없어요.`)) return;
    try {
      const r = await api(`/api/matches/${mid}/vote`, { method: 'POST', body: { pick }, token });
      me = r.me;
      toast(`${name} 선수 응원 완료! 🔥`);
      structKey = '';
      apply(r.state);
    } catch (e) { toast(e.message); }
  }

  // ---------- 화면 ----------
  function pickFeatured() {
    const ms = state.matches;
    if (!ms.length) return null;
    if (selectedId) { const s = ms.find(m => m.id === selectedId); if (s) return s; }
    const live = ms.find(m => ['running', 'paused', 'break', 'roundEnd'].includes(effTimer(m, now()).status) && !m.result);
    return live || ms.find(m => !m.result) || ms[ms.length - 1];
  }

  function media(f, side) {
    if (f.photo) return `<img src="${esc(f.photo)}" alt="${esc(f.name)} 선수">`;
    if (f.video && isFileVideo(f.video)) return `<video src="${esc(f.video)}" muted autoplay loop playsinline></video>`;
    return `<div class="placeholder">${esc(f.name.slice(0, 1) || side)}</div>`;
  }

  function fighterHtml(m, side) {
    const f = m.fighters[side];
    const myPick = me && me.votes[m.id];
    const canVote = m.votingOpen && !m.result && !myPick;
    const cls = ['fighter', side];
    if (myPick === side) cls.push('mine');
    if (m.result === side) cls.push('winner');
    if (m.result && m.result !== 'DRAW' && m.result !== side) cls.push('loser');
    let action = '';
    if (canVote) action = `<button class="btn vote-btn" data-vote="${side}">${esc(f.name)} 승리 예측</button>`;
    else if (myPick === side) action = `<div class="voted-note">✔ 내 선택</div>`;
    return `
      <article class="${cls.join(' ')}">
        <div class="photo">
          ${media(f, side)}
          <span class="corner">${side === 'A' ? 'RED' : 'WHITE'}</span>
          <span class="badge" data-badge="${side}"></span>
          <div class="nameplate">
            <div class="name">${esc(f.name)}</div>
            <div class="pct" data-pct="${side}">–</div>
            <div class="cnt" data-cnt="${side}"></div>
          </div>
        </div>
        ${(action || f.video) ? `<div class="factions">${action}${f.video ? `<button class="btn ghost sm video-btn" data-video="${esc(f.video)}">▶ 영상 보기</button>` : ''}</div>` : ''}
      </article>`;
  }

  function render(force) {
    if (!state) return;
    const m = pickFeatured();
    if (!m) { feature.innerHTML = `<p class="notice">등록된 경기가 없습니다.</p>`; structKey = ''; return; }
    const key = JSON.stringify([m.id, m.title, m.sport, m.venue, m.startAt, m.rounds, m.roundSeconds, m.poster, m.fighters, m.votingOpen, m.result, me && me.votes[m.id], !!me]);
    if (force || key !== structKey) {
      structKey = key;
      feature.innerHTML = `
        <div class="match" data-mid="${m.id}">
          <div class="meta">
            <span class="tag red">${esc(m.sport || '경기')}</span>
            <span class="tag">📍 ${esc(m.venue || '장소 미정')}</span>
            <span class="tag">🕐 ${esc(timeLabel(m.startAt))}</span>
            <span class="tag">⏱ ${m.rounds}R × ${roundLen(m)}</span>
          </div>
          <h1 class="match-title hide-in-display">${esc(m.title || `${m.fighters.A.name} vs ${m.fighters.B.name}`)}</h1>
          <div class="countdown hide-in-display"><div class="label" id="cdLabel"></div><div class="val" id="cdVal"></div></div>
          <div class="timer" id="fightTimer">
            <div class="rounds" id="pips"></div>
            <div class="status" id="tStatus"></div>
            <div class="clock" id="tClock"></div>
            <div class="sub">라운드당 ${roundLen(m)} · ${m.rounds}라운드${m.breakSeconds ? ` · 휴식 ${m.breakSeconds}초` : ''}</div>
          </div>
          <div class="arena">
            ${fighterHtml(m, 'A')}
            <div class="vs">VS</div>
            ${fighterHtml(m, 'B')}
          </div>
          <div class="hide-in-display">
            <div class="bar" id="bar"><div class="a" id="barA"></div><div class="b" id="barB"></div></div>
            <div class="bar-legend"><span class="live">실시간 지지율</span><span id="total"></span></div>
            <p class="notice ${m.result ? 'strong' : ''}" id="note"></p>
            ${m.poster ? `<div class="poster"><img src="${esc(m.poster)}" alt="경기 포스터"></div>` : ''}
          </div>
        </div>`;
      feature.querySelectorAll('[data-vote]').forEach(b => b.onclick = () => vote(m.id, b.dataset.vote));
      feature.querySelectorAll('[data-video]').forEach(b => b.onclick = () => {
        const u = b.dataset.video;
        if (!isFileVideo(u)) return window.open(u, '_blank', 'noopener');
        const v = $('#videoEl'); v.src = u; openModal('videoModal'); v.play().catch(() => {});
      });
    }
    updateDynamic(m);
    renderOthers(m);
    renderBoard();
  }

  function updateDynamic(m) {
    const t = m.tally;
    const has = t.total > 0;
    for (const s of ['A', 'B']) {
      const pctEl = feature.querySelector(`[data-pct="${s}"]`);
      const cntEl = feature.querySelector(`[data-cnt="${s}"]`);
      const badge = feature.querySelector(`[data-badge="${s}"]`);
      if (pctEl) pctEl.textContent = has ? `${s === 'A' ? t.pctA : t.pctB}%` : '–';
      if (cntEl) cntEl.textContent = has ? `${(s === 'A' ? t.A : t.B).toLocaleString()}표` : '';
      if (badge) {
        const ud = m.result ? m.settledUnderdog : t.underdog;
        if (m.result === s) { badge.className = 'badge win'; badge.textContent = '🏆 승리'; }
        else if (!has && !m.result) { badge.className = 'badge'; badge.textContent = '집계 전'; }
        else if (ud === s) { badge.className = 'badge underdog'; badge.textContent = '🐺 UNDERDOG'; }
        else { badge.className = 'badge'; badge.textContent = ''; badge.style.display = 'none'; continue; }
        badge.style.display = '';
      }
    }
    const bar = $('#bar');
    if (bar) {
      bar.classList.toggle('empty', !has);
      $('#barA').style.width = (has ? t.pctA : 50) + '%';
      $('#barB').style.width = (has ? t.pctB : 50) + '%';
      $('#total').textContent = has ? `총 ${t.total.toLocaleString()}표` : '집계 전 · 첫 표를 던져보세요';
    }
    const note = $('#note');
    if (note) {
      const myPick = me && me.votes[m.id];
      if (m.result === 'DRAW') note.textContent = '결과: 무승부';
      else if (m.result) {
        const w = m.fighters[m.result].name;
        let extra = '';
        if (myPick) extra = myPick === m.result ? ` · 예측 적중! +${20 + (m.settledUnderdog === m.result ? 30 : 0)}P` : ' · 아쉽게 빗나갔어요';
        note.textContent = `결과: ${w} 승리${m.settledUnderdog === m.result ? ' (언더독의 반란!)' : ''}${extra}`;
      } else if (!m.votingOpen) note.textContent = myPick ? '투표 마감 · 결과를 기다리는 중' : '투표가 마감되었습니다';
      else if (myPick) note.textContent = `${m.fighters[myPick].name} 선수에게 투표했어요. 적중하면 +20P, 언더독이면 +30P 추가!`;
      else note.textContent = me ? '이길 것 같은 선수를 골라주세요 (1인 1표)' : '가입하면 바로 투표할 수 있어요';
    }
    tick();
  }

  function tick() {
    if (!state) return;
    const m = pickFeatured();
    if (!m || !document.getElementById('tClock')) return;
    const tv = timerView(m);
    const el = $('#fightTimer');
    el.className = 'timer' + (tv.status === 'running' ? ' running' : '') + (tv.status === 'break' ? ' break' : '') +
      (tv.status === 'running' && tv.remaining <= 10000 ? ' warn' : '');
    $('#tStatus').textContent = tv.label;
    $('#tClock').textContent = tv.clock;
    const pips = [];
    for (let i = 1; i <= m.rounds; i++) {
      let c = 'pip';
      const cur = tv.status === 'roundEnd' ? tv.round + 1 : tv.round;
      if (tv.status === 'finished' || i < cur || (i === cur && tv.status === 'break')) c += ' done';
      else if (i === cur && ['running', 'paused'].includes(tv.status)) c += ' now';
      pips.push(`<span class="${c}"></span>`);
    }
    const pipHtml = pips.join('');
    if ($('#pips').innerHTML !== pipHtml) $('#pips').innerHTML = pipHtml;

    const cdL = $('#cdLabel'), cdV = $('#cdVal');
    if (cdL) {
      const left = new Date(m.startAt).getTime() - now();
      const started = m.timer.status !== 'idle';
      if (m.result || m.timer.status === 'finished') { cdL.textContent = 'FIGHT'; cdV.textContent = '경기 종료'; cdV.className = 'val'; }
      else if (started) { cdL.textContent = 'NOW'; cdV.textContent = 'LIVE'; cdV.className = 'val live'; }
      else if (left > 0) { cdL.textContent = '경기 시작까지'; cdV.textContent = untilText(left); cdV.className = 'val'; }
      else { cdL.textContent = '곧 시작'; cdV.textContent = '입장 중'; cdV.className = 'val live'; }
    }
  }
  setInterval(tick, 200);

  function renderOthers(featured) {
    const wrap = $('#othersWrap');
    if (state.matches.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const html = state.matches.map(m => `
      <button class="mini ${m.id === featured.id ? 'active' : ''}" data-mid="${m.id}">
        <span><b>${esc(m.fighters.A.name)}</b> vs <b>${esc(m.fighters.B.name)}</b><br><small>${esc(m.sport)} · ${esc(m.venue)} · ${esc(timeLabel(m.startAt))}</small></span>
        <small>${m.result ? '종료' : m.votingOpen ? '투표 중' : '마감'}</small>
      </button>`).join('');
    const box = $('#others');
    if (box.innerHTML !== html) {
      box.innerHTML = html;
      box.querySelectorAll('[data-mid]').forEach(b => b.onclick = () => { selectedId = b.dataset.mid; render(true); scrollTo({ top: 0, behavior: 'smooth' }); });
    }
  }

  function renderBoard() {
    const b = state.leaderboard;
    const html = b.length
      ? b.map((u, i) => `<div class="row"><span class="rank">${i + 1}</span><span class="who">${esc(u.nickname)}${me && me.nickname === u.nickname ? ' (나)' : ''}</span><span class="p">${u.points.toLocaleString()} P</span></div>`).join('')
      : `<div class="empty-msg">아직 참가자가 없어요. 첫 번째로 가입해보세요!</div>`;
    const el = $('#board');
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  let lastResults = '';
  subscribe(s => {
    state = s;
    // 결과가 새로 나오면 내 포인트 갱신
    const rk = s.matches.map(m => m.id + ':' + m.result).join('|');
    if (me && lastResults && rk !== lastResults) loadMe();
    lastResults = rk;
    render(false);
  });
  loadMe();
})();
