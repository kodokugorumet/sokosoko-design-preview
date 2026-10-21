// In-page design voting backed by the free Abacus counter API (no login).
// One browser may vote for up to MAX different designs; a vote can be undone
// during a short grace period before it is sent. The limit is enforced only in
// localStorage, so it is a courtesy limit, not an anti-fraud measure.
(() => {
  const API = 'https://abacus.jasoncameron.dev';
  const NS = 'kodokugorumet-sokosoko-design';
  const MAX = 3;
  const GRACE_SEC = 3;
  const MINE_KEY = 'soko-design-votes-v1';
  const CACHE_KEY = 'soko-design-counts-v1';
  const CACHE_MS = 15000;
  const IDS = ['1a', '1b', '1c', '1d', '1e', '1f', '2a', '2b', '2c', '2d', '2e', '2f', '2g', '2h', '2i', '2j'];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function mine() {
    try {
      const v = JSON.parse(localStorage.getItem(MINE_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => IDS.includes(x)) : [];
    } catch {
      return [];
    }
  }

  function saveMine(list) {
    localStorage.setItem(MINE_KEY, JSON.stringify(list));
  }

  function readCache() {
    try {
      const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      return c && typeof c === 'object' && c.counts ? c : null;
    } catch {
      return null;
    }
  }

  function writeCache(counts) {
    const prev = readCache();
    const merged = Object.assign({}, prev ? prev.counts : {}, counts);
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), counts: merged }));
    return merged;
  }

  // GET with one polite retry when the API rate-limits (30 req / 10 s per IP).
  async function call(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(API + path, { cache: 'no-store' });
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

  async function fetchCounts(ids, { fresh = false } = {}) {
    const cache = readCache();
    if (!fresh && cache && Date.now() - cache.t < CACHE_MS && ids.every((id) => id in cache.counts)) {
      return cache.counts;
    }
    const out = {};
    // Two waves of eight keep a single page load well under the rate limit.
    for (let i = 0; i < ids.length; i += 8) {
      const wave = ids.slice(i, i + 8);
      const vals = await Promise.all(
        wave.map((id) =>
          call(`/get/${NS}/vote-${id}`)
            .then((b) => Number(b.value) || 0)
            .catch(() => null),
        ),
      );
      wave.forEach((id, k) => {
        if (vals[k] !== null) out[id] = vals[k];
      });
    }
    return writeCache(out);
  }

  async function cast(id) {
    const list = mine();
    if (list.includes(id)) return { ok: false, reason: 'already' };
    if (list.length >= MAX) return { ok: false, reason: 'limit' };
    const b = await call(`/hit/${NS}/vote-${id}`);
    saveMine([...list, id]);
    writeCache({ [id]: Number(b.value) || 0 });
    return { ok: true, value: Number(b.value) || 0 };
  }

  window.SokoVote = { IDS, MAX, GRACE_SEC, mine, fetchCounts, cast };

  // ---- Floating widget on individual design pages -------------------------
  const me = document.currentScript;
  const pageId = me && me.dataset.voteId;
  if (!pageId) return;

  const css = `
  .sv-bar{position:fixed;right:24px;bottom:24px;z-index:2147483000;display:flex;align-items:center;gap:12px;
    padding:10px 12px 10px 18px;background:#fff;color:#1a1a18;border:1.5px solid #111;border-radius:999px;
    box-shadow:3px 3px 0 #111;font:500 14px/1.4 'Noto Sans KR','Noto Sans JP',system-ui,sans-serif}
  .sv-bar b{font-weight:700;color:#111}
  .sv-count{font-variant-numeric:tabular-nums;color:#5c5c58}
  .sv-btn{min-height:40px;padding:0 16px;border-radius:999px;border:1.5px solid #111;background:#111;color:#fff;
    font-family:inherit;font-size:14px;font-weight:700;line-height:1;cursor:pointer}
  .sv-btn[data-state="pending"]{background:#fff;color:#111}
  .sv-btn[data-state="voted"]{background:#b23a5c;border-color:#b23a5c;cursor:default}
  .sv-btn:disabled:not([data-state="voted"]){background:#f5f5f2;color:#5c5c58;border-color:#c9c9c4;cursor:default}
  .sv-link{color:#b23a5c;font-weight:700;text-decoration:underline}
  .sv-link:hover{color:#111}
  .sv-note{font-size:12px;color:#5c5c58}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const bar = document.createElement('div');
  bar.className = 'sv-bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', '이 시안에 투표');
  bar.innerHTML = `<span><b>${pageId}</b> <span class="sv-count" aria-live="polite">…</span></span>
    <button type="button" class="sv-btn"></button>
    <a class="sv-link" href="./#vote">전체 순위</a>`;
  document.body.append(bar);
  const countEl = bar.querySelector('.sv-count');
  const btn = bar.querySelector('.sv-btn');
  let timer = null;

  function render(state, left) {
    btn.dataset.state = state;
    btn.disabled = state === 'voted' || state === 'limit';
    btn.setAttribute('aria-pressed', state === 'voted' ? 'true' : 'false');
    btn.textContent =
      state === 'voted' ? '투표했어요' : state === 'limit' ? '남은 표 없음' : state === 'pending' ? `취소 (${left})` : `투표하기 · 남은 ${MAX - mine().length}표`;
  }

  function idle() {
    const list = mine();
    render(list.includes(pageId) ? 'voted' : list.length >= MAX ? 'limit' : 'ready');
  }

  function showCount(n) {
    countEl.textContent = n == null ? '' : `${n}표`;
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
        if (r.ok) showCount(r.value);
      } catch {
        countEl.textContent = '투표를 보내지 못했어요. 다시 눌러 주세요';
      }
      idle();
    }, 1000);
  });

  idle();
  fetchCounts([pageId])
    .then((c) => showCount(c[pageId]))
    .catch(() => showCount(null));
})();
