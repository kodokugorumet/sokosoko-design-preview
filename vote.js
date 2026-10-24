// In-page design voting backed by the free Abacus counter API (no login).
//
// Duplicate protection, strongest first:
//  1. Device+network registry: a SHA-256 hash of stable device signals plus the
//     visitor's IP is kept as its own counter ("vtr-<hash>") holding how many
//     votes that device/network has used. Private windows, other browsers and
//     cleared storage on the same device and network all map to the same hash.
//  2. Local markers in localStorage and a cookie (which design was voted).
//  3. A "ballots" counter incremented first with every legitimate vote, so votes
//     pushed straight to the API (bypassing this page) show up as a mismatch.
// Nothing here can stop a determined user who changes network and spoofs
// device signals; only an account-based backend can.
(() => {
  const API = 'https://abacus.jasoncameron.dev';
  const NS = 'kodokugorumet-sokosoko-design';
  const MAX = 3;
  const GRACE_SEC = 3;
  const SALT = 'sokosoko-design-vote-2026';
  const MINE_KEY = 'soko-design-votes-v1';
  const COOKIE = 'soko_dv';
  const IDS = ['1a', '1b', '1c', '1d', '1e', '1f', '2a', '2b', '2c', '2d', '2e', '2f', '2g', '2h', '2i', '2j', '3a', '3b', '3c', '3d', '3e', '3f'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- local markers ------------------------------------------------------
  function readCookie() {
    const m = document.cookie.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]).split('.').filter(Boolean) : [];
  }

  function mine() {
    let ls = [];
    try {
      const v = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
      if (Array.isArray(v)) ls = v;
    } catch {}
    return [...new Set([...ls, ...readCookie()])].filter((x) => IDS.includes(x));
  }

  function saveMine(list) {
    try {
      localStorage.setItem(MINE_KEY, JSON.stringify(list));
    } catch {}
    document.cookie = `${COOKIE}=${encodeURIComponent(list.join('.'))}; max-age=31536000; path=/; SameSite=Lax; Secure`;
  }


  // GET with polite retries when the API rate-limits (30 req / 10 s per IP).
  async function call(path) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(API + path, { cache: 'no-store', keepalive: true });
      if (res.status === 404) return { value: 0 };
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const m = /(\d+)s/.exec(body.error || '');
        await sleep(((m ? Number(m[1]) : 2) + 0.5) * 1000);
        continue;
      }
      if (!res.ok) throw new Error('vote api ' + res.status);
      return res.json();
    }
    throw new Error('vote api rate limited');
  }

  // ---- device + network registry -----------------------------------------
  // Signals chosen to stay the same across browsers and private windows on one
  // device (no canvas: Safari randomizes it in private mode).
  function deviceSignals() {
    const s = window.screen || {};
    const dims = [s.width || 0, s.height || 0].sort((a, b) => a - b).join('x');
    return [
      dims,
      window.devicePixelRatio || 1,
      s.colorDepth || 0,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.hardwareConcurrency || 0,
      navigator.maxTouchPoints || 0,
      navigator.platform || '',
    ].join('|');
  }

  async function publicIp() {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      const b = await res.json();
      return b.ip || 'noip';
    } catch {
      return 'noip';
    }
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  let voterKey = null;
  let serverUsed = 0;
  let checkedAt = 0;
  const ready = (async () => {
    try {
      const ip = await publicIp();
      voterKey = 'vtr-' + (await sha256(`${SALT}|${deviceSignals()}|${ip}`)).slice(0, 40);
      serverUsed = Number((await call(`/get/${NS}/${voterKey}`)).value) || 0;
      checkedAt = Date.now();
    } catch {
      // Registry unavailable: fall back to local markers only.
    }
    return { used: used(), mine: mine() };
  })();

  function used() {
    return Math.min(MAX, Math.max(mine().length, serverUsed));
  }


  // Votes go out one at a time: parallel casts would race on the local list
  // and burst past the API rate limit.
  let queue = Promise.resolve();
  function cast(id) {
    const run = queue.then(() => castNow(id));
    queue = run.catch(() => {});
    return run;
  }

  async function castNow(id) {
    await ready;
    const list = mine();
    if (list.includes(id)) return { ok: false, reason: 'already' };
    if (voterKey && Date.now() - checkedAt > 20000) {
      // Re-check the registry in case another browser on this device/network
      // voted since the last read.
      serverUsed = Number((await call(`/get/${NS}/${voterKey}`)).value) || 0;
      checkedAt = Date.now();
    }
    if (used() >= MAX) return { ok: false, reason: 'limit' };
    // Ballot first: if anything after it is lost, ballots >= votes still holds,
    // so only votes pushed straight to the API show up as a mismatch.
    await call(`/hit/${NS}/ballots`);
    await call(`/hit/${NS}/vote-${id}`);
    saveMine([...list, id]);
    if (voterKey) {
      const v = await call(`/hit/${NS}/${voterKey}`).catch(() => null);
      if (v) serverUsed = Number(v.value) || serverUsed + 1;
    }
    return { ok: true };
  }

  const LIMIT_MSG = `이 기기·네트워크에서는 이미 ${MAX}표를 모두 사용했어요.`;
  window.SokoVote = { IDS, MAX, GRACE_SEC, LIMIT_MSG, ready, mine, used, cast };

  // ---- Floating widget on individual design pages -------------------------
  const me = document.currentScript;
  const pageId = me && me.dataset.voteId;
  // ?nowidget keeps the floating bar out of preview screenshots.
  if (!pageId || new URLSearchParams(location.search).has('nowidget')) return;

  const css = `
  .sv-bar{position:fixed;right:24px;bottom:24px;z-index:2147483000;display:flex;align-items:center;gap:12px;
    padding:10px 12px 10px 18px;background:#fff;color:#1a1a18;border:1.5px solid #111;border-radius:999px;
    box-shadow:3px 3px 0 #111;font:500 14px/1.4 'Noto Sans KR','Noto Sans JP',system-ui,sans-serif}
  .sv-bar b{font-weight:700;color:#111}
  .sv-msg{color:#5c5c58;font-size:13px}
  .sv-btn{min-height:40px;padding:0 16px;border-radius:999px;border:1.5px solid #111;background:#111;color:#fff;
    font-family:inherit;font-size:14px;font-weight:700;line-height:1;cursor:pointer}
  .sv-btn[data-state="pending"]{background:#fff;color:#111}
  .sv-btn[data-state="voted"]{background:#b23a5c;border-color:#b23a5c;cursor:default}
  .sv-btn:disabled:not([data-state="voted"]){background:#f5f5f2;color:#5c5c58;border-color:#c9c9c4;cursor:default}
  .sv-link{color:#b23a5c;font-weight:700;text-decoration:underline}
  .sv-link:hover{color:#111}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const bar = document.createElement('div');
  bar.className = 'sv-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '이 시안에 투표');
  bar.innerHTML = `<span><b>${pageId}</b> <span class="sv-msg" aria-live="polite"></span></span>
    <button type="button" class="sv-btn"></button>
    <a class="sv-link" href="./">시안 목록</a>`;
  document.body.append(bar);
  const msgEl = bar.querySelector('.sv-msg');
  const btn = bar.querySelector('.sv-btn');
  let timer = null;

  function render(state, left) {
    btn.dataset.state = state;
    btn.disabled = state === 'voted' || state === 'limit';
    btn.setAttribute('aria-pressed', state === 'voted' ? 'true' : 'false');
    btn.title = state === 'limit' ? LIMIT_MSG : '';
    btn.textContent =
      state === 'voted' ? '투표했어요' : state === 'limit' ? '남은 표 없음' : state === 'pending' ? `취소 (${left})` : `투표하기 · 남은 ${MAX - used()}표`;
  }

  function idle() {
    render(mine().includes(pageId) ? 'voted' : used() >= MAX ? 'limit' : 'ready');
  }


  btn.addEventListener('click', () => {
    if (btn.dataset.state === 'pending') {
      clearInterval(timer);
      timer = null;
      idle();
      return;
    }
    let left = GRACE_SEC;
    render('pending', left);
    timer = setInterval(async () => {
      left -= 1;
      if (left > 0) return render('pending', left);
      clearInterval(timer);
      timer = null;
      btn.disabled = true;
      btn.textContent = '보내는 중…';
      try {
        const r = await cast(pageId);
        if (!r.ok && r.reason === 'limit') msgEl.textContent = LIMIT_MSG;
      } catch {
        msgEl.textContent = '투표를 보내지 못했어요. 다시 눌러 주세요';
      }
      idle();
    }, 1000);
  });

  idle();
  ready.then(idle);
})();
