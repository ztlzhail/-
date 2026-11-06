(() => {
  const { api, subscribe, esc, toast, store, timerView, roundLen } = FX;
  const $ = s => document.querySelector(s);
  let token = store('fx_admin');
  let state = null;
  const openDetails = new Set();
  let busyUpload = 0;

  function toLocalInput(iso) {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function check() {
    if (!token) return showLogin();
    try { await api('/api/admin/check', { token }); showPanel(); }
    catch { token = null; store('fx_admin', null); showLogin(); }
  }
  function showLogin() { $('#loginCard').hidden = false; $('#panel').hidden = true; $('#logout').hidden = true; }
  function showPanel() { $('#loginCard').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false; render(); }

  $('#loginCard').addEventListener('submit', async e => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try { const r = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } }); token = r.token; store('fx_admin', token); $('#pw').value = ''; showPanel(); }
    catch (ex) { $('#loginErr').textContent = ex.message; }
  });
  $('#logout').onclick = () => { token = null; store('fx_admin', null); showLogin(); };

  const d = new Date(); d.setMinutes(d.getMinutes() + 30, 0, 0);
  $('#newMatch').startAt.value = toLocalInput(d.toISOString());
  $('#newMatch').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, err = $('#newErr'); err.textContent = '';
    const body = Object.fromEntries(new FormData(f));
    body.startAt = new Date(body.startAt).toISOString();
    try { await adm('/api/admin/matches', 'POST', body); f.nameA.value = ''; f.nameB.value = ''; f.title.value = ''; toast('경기를 추가했습니다'); }
    catch (ex) { err.textContent = ex.message; }
  });

  async function adm(path, method, body) {
    try { return await api(path, { method, body, token }); }
    catch (e) { if (e.status === 401) { token = null; store('fx_admin', null); showLogin(); } throw e; }
  }

  function upload(mid, slot, file, progEl) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/admin/matches/${mid}/upload?slot=${slot}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable && progEl) progEl.style.width = (e.loaded / e.total * 100) + '%'; };
      xhr.onload = () => { let r = {}; try { r = JSON.parse(xhr.responseText); } catch {} xhr.status < 300 ? resolve(r) : reject(new Error(r.error || '업로드 실패')); };
      xhr.onerror = () => reject(new Error('네트워크 오류'));
      xhr.send(file);
    });
  }

  function slotHtml(m, slot, label, src, isVideo) {
    return `<div class="slot">
      <b>${label}</b>
      <div class="pv">${src ? (isVideo ? `<video src="${esc(src)}" muted controls playsinline></video>` : `<img src="${esc(src)}" alt="">`) : '없음'}</div>
      <input type="file" accept="${isVideo ? 'video/mp4,video/webm,video/quicktime' : 'image/*'}" data-up="${slot}">
      <div class="prog"><i></i></div>
      ${src ? `<button type="button" class="btn ghost sm" data-clear="${slot}">삭제</button>` : ''}
    </div>`;
  }

  function matchCard(m) {
    const t = m.tally;
    const tv = timerView(m);
    const st = m.timer.status;
    const A = m.fighters.A.name, B = m.fighters.B.name;
    const nextRound = st === 'roundEnd' || st === 'break' ? Math.min(m.timer.round + 1, m.rounds) : m.timer.round;
    return `<section class="card" data-mid="${m.id}">
      <h3><span>${esc(A)} <span style="color:var(--red)">vs</span> ${esc(B)}</span>
        <span class="tag ${m.result ? '' : m.votingOpen ? 'red' : ''}">${m.result ? '결과 등록됨' : m.votingOpen ? '투표 진행 중' : '투표 마감'}</span></h3>
      <div class="stat">${esc(m.sport)} · ${esc(m.venue)} · ${esc(new Date(m.startAt).toLocaleString('ko-KR'))} · ${m.rounds}R × ${roundLen(m)}<br>
        투표: <b>${esc(A)} ${t.A}표 (${t.pctA}%)</b> / <b>${esc(B)} ${t.B}표 (${t.pctB}%)</b> · 총 ${t.total}표 ·
        언더독: <b>${t.total ? (t.underdog ? esc(m.fighters[t.underdog].name) : '동률') : '집계 전'}</b></div>

      <div class="group"><h4>라운드 타이머</h4>
        <div class="admin-timer" data-clock>${tv.clock}</div>
        <div class="stat" data-tlabel>${tv.label}</div>
        <div class="row-btns">
          ${['idle', 'roundEnd', 'break'].includes(st) ? `<button class="btn" data-timer="start">▶ ${nextRound}라운드 시작</button>` : ''}
          ${st === 'running' ? `<button class="btn white" data-timer="pause">❚❚ 일시정지</button><button class="btn ghost" data-timer="endRound">라운드 즉시 종료</button>` : ''}
          ${st === 'paused' ? `<button class="btn" data-timer="resume">▶ 재개</button><button class="btn ghost" data-timer="endRound">라운드 즉시 종료</button>` : ''}
          ${st !== 'idle' ? `<button class="btn ghost" data-timer="reset">초기화</button>` : ''}
        </div>
        <div class="stat" style="font-size:12px;color:#777">1라운드를 시작하면 투표가 자동으로 마감됩니다. 라운드가 끝나면 휴식(${m.breakSeconds}초) 카운트 후 다음 라운드 대기 상태가 됩니다.</div>
      </div>

      <div class="group"><h4>투표 · 결과</h4>
        <div class="row-btns">
          ${m.result ? '' : m.votingOpen ? `<button class="btn" data-voting="0">투표 마감</button>` : `<button class="btn ghost" data-voting="1">투표 다시 열기</button>`}
        </div>
        <div class="row-btns">
          ${m.result
            ? `<span class="stat">결과: <b>${m.result === 'DRAW' ? '무승부' : esc(m.fighters[m.result].name) + ' 승리'}</b></span><button class="btn ghost sm" data-result="null">결과 취소(포인트 회수)</button>`
            : `<button class="btn" data-result="A">${esc(A)} 승리</button><button class="btn white" data-result="B">${esc(B)} 승리</button><button class="btn ghost" data-result="DRAW">무승부</button>`}
        </div>
      </div>

      <div class="group"><h4>사진 · 영상 · 포스터</h4>
        <div class="media-grid">
          ${slotHtml(m, 'photoA', `${esc(A)} 사진`, m.fighters.A.photo)}
          ${slotHtml(m, 'photoB', `${esc(B)} 사진`, m.fighters.B.photo)}
          ${slotHtml(m, 'videoA', `${esc(A)} 영상`, m.fighters.A.video, true)}
          ${slotHtml(m, 'videoB', `${esc(B)} 영상`, m.fighters.B.video, true)}
          ${slotHtml(m, 'poster', '경기 포스터', m.poster)}
        </div>
      </div>

      <details class="group" data-details ${openDetails.has(m.id) ? 'open' : ''}><summary>경기 정보 수정 / 삭제</summary>
        <form data-edit style="margin-top:12px">
          <div class="grid2">
            <div class="field"><label>RED 선수</label><input name="nameA" value="${esc(A)}"></div>
            <div class="field"><label>WHITE 선수</label><input name="nameB" value="${esc(B)}"></div>
          </div>
          <div class="grid2">
            <div class="field"><label>제목</label><input name="title" value="${esc(m.title)}"></div>
            <div class="field"><label>종목</label><input name="sport" value="${esc(m.sport)}"></div>
          </div>
          <div class="grid2">
            <div class="field"><label>장소</label><input name="venue" value="${esc(m.venue)}"></div>
            <div class="field"><label>시작 시각</label><input name="startAt" type="datetime-local" value="${toLocalInput(m.startAt)}"></div>
          </div>
          <div class="grid3">
            <div class="field"><label>라운드 수</label><input name="rounds" type="number" min="1" max="12" value="${m.rounds}"></div>
            <div class="field"><label>라운드(초)</label><input name="roundSeconds" type="number" min="5" value="${m.roundSeconds}"></div>
            <div class="field"><label>휴식(초)</label><input name="breakSeconds" type="number" min="0" value="${m.breakSeconds}"></div>
          </div>
          <div class="row-btns"><button class="btn">저장</button><button type="button" class="btn ghost" data-delete>경기 삭제</button></div>
        </form>
      </details>
    </section>`;
  }

  let lastHtml = '';
  function render() {
    if (!state || $('#panel').hidden || busyUpload) return;
    if (document.activeElement && document.activeElement.closest('[data-edit]')) return; // 수정 중엔 다시 그리지 않음
    const html = state.matches.map(matchCard).join('') || '<div class="card"><p class="notice">경기가 없습니다. 아래에서 추가하세요.</p></div>';
    if (html === lastHtml) return;
    lastHtml = html;
    const box = $('#matches');
    box.innerHTML = html;
    box.querySelectorAll('[data-mid]').forEach(card => bind(card, card.dataset.mid));
  }

  function bind(card, mid) {
    const base = `/api/admin/matches/${mid}`;
    const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); } catch (e) { toast(e.message); } };
    card.querySelectorAll('[data-timer]').forEach(b => b.onclick = () => run(() => adm(base + '/timer', 'POST', { action: b.dataset.timer })));
    card.querySelectorAll('[data-voting]').forEach(b => b.onclick = () => run(() => adm(base + '/voting', 'POST', { open: b.dataset.voting === '1' }), b.dataset.voting === '1' ? '투표를 열었습니다' : '투표를 마감했습니다'));
    card.querySelectorAll('[data-result]').forEach(b => b.onclick = () => {
      const r = b.dataset.result === 'null' ? null : b.dataset.result;
      const label = r === null ? '결과를 취소하고 지급한 포인트를 회수할까요?' : `${b.textContent.trim()}(으)로 결과를 등록할까요?\n적중자에게 포인트가 지급됩니다.`;
      if (confirm(label)) run(() => adm(base + '/result', 'POST', { result: r }), r === null ? '결과를 취소했습니다' : '결과를 등록했습니다');
    });
    card.querySelectorAll('[data-up]').forEach(inp => inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      busyUpload++;
      try { await upload(mid, inp.dataset.up, file, inp.parentElement.querySelector('.prog i')); toast('업로드 완료'); }
      catch (e) { toast(e.message); }
      finally { busyUpload--; lastHtml = ''; render(); }
    });
    card.querySelectorAll('[data-clear]').forEach(b => b.onclick = () => run(() => adm(base + '/clearMedia', 'POST', { slot: b.dataset.clear })));
    const det = card.querySelector('[data-details]');
    det.ontoggle = () => det.open ? openDetails.add(mid) : openDetails.delete(mid);
    const form = card.querySelector('[data-edit]');
    form.onsubmit = e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      body.startAt = new Date(body.startAt).toISOString();
      document.activeElement.blur();
      run(() => adm(base, 'PATCH', body), '저장했습니다');
    };
    card.querySelector('[data-delete]').onclick = () => { if (confirm('이 경기를 삭제할까요? 투표와 지급된 포인트도 사라집니다.')) run(() => adm(base, 'DELETE'), '삭제했습니다'); };
  }

  // 타이머 시계만 매 프레임 갱신
  setInterval(() => {
    if (!state) return;
    for (const m of state.matches) {
      const card = document.querySelector(`[data-mid="${m.id}"]`);
      if (!card) continue;
      const tv = timerView(m);
      const c = card.querySelector('[data-clock]'); if (c) c.textContent = tv.clock;
      const l = card.querySelector('[data-tlabel]'); if (l) l.textContent = tv.label;
    }
  }, 200);

  subscribe(s => { state = s; render(); });
  check();
})();
