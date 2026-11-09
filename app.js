(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const API = (window.VINYL_CONFIG && window.VINYL_CONFIG.API_URL) || '';
  const SHELF_COLORS = ['#e8a24a', '#e0664f', '#b48ce0', '#4fc1c9', '#ef7fa8', '#9ccf6a', '#d8c27a', '#7f9be8'];

  const state = {
    records: [], covers: {}, shelves: [],
    shelf: 0, q: '', decade: '', tempo: '', sort: 'shelf',
    mood: null, current: null, view: 'catalog', isStaff: false,
    favs: [], // короткие хеши пластинок, новые в начале
  };
  const col = (no) => (no > 0 ? SHELF_COLORS[(no - 1) % SHELF_COLORS.length] : '#6b5f55');
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = (r) => `${r.artist}|${r.album}`;
  const haptic = (t) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.selectionChanged(); } catch (e) {} };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------- Telegram ----------
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#14110f'); tg.setBackgroundColor('#14110f'); tg.setBottomBarColor && tg.setBottomBarColor('#14110f'); } catch (e) {}
    tg.BackButton.onClick(() => closeSheet());
  }

  // ---------- Data ----------
  function parseBpm(s) {
    const m = String(s || '').match(/(\d+)\D+(\d+)/);
    if (m) return [Number(m[1]), Number(m[2])];
    const one = String(s || '').match(/\d+/);
    return one ? [Number(one[0]), Number(one[0])] : null;
  }
  function prep(list) {
    return list.filter((r) => r.artist || r.album).map((r, i) => {
      const bpm = parseBpm(r.bpm);
      const shelfName = r.shelf || 'Без полки';
      return {
        ...r, id: i, shelf: shelfName,
        bpmMin: bpm && bpm[0], bpmMax: bpm && bpm[1],
        tags: String(r.genre || '').split('/').map((t) => t.trim()).filter(Boolean),
        hay: `${r.artist} ${r.album} ${r.genre} ${r.year || ''} ${shelfName}`.toLowerCase(),
        unsure: /уточнить|\?/.test(`${r.artist}${r.album}`),
      };
    });
  }

  // Сначала показываем сохранённую копию (мгновенно), потом тихо обновляем из таблицы:
  // Google Apps Script после простоя «просыпается» до 10 секунд.
  async function loadLocalCatalog() {
    const cached = store.get('catalog', null);
    if (cached && cached.length) return cached;
    const res = await fetch('data/vinyl.json');
    return res.json();
  }
  async function loadFreshCatalog() {
    if (!API) return null;
    try {
      const res = await fetch(API, { redirect: 'follow' });
      const d = await res.json();
      if (d.ok && d.records && d.records.length) { store.set('catalog', d.records); return d.records; }
    } catch (e) { /* остаёмся на копии */ }
    return null;
  }
  async function loadCovers() {
    try { const r = await fetch('data/covers.json'); return await r.json(); } catch (e) { return {}; }
  }

  // ---------- Избранное ----------
  // Хранится в облаке Telegram (видно на всех устройствах гостя) и дублируется в браузере.
  const FAV_KEY = 'favs';
  const cloud = tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
  function favId(r) {
    let h = 5381;
    const s = keyOf(r);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  const isFav = (r) => state.favs.includes(favId(r));
  function loadFavs() {
    state.favs = store.get(FAV_KEY, []);
    if (!cloud) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        cloud.getItem(FAV_KEY, (err, val) => {
          if (!err && val) {
            const remote = val.split(',').filter(Boolean);
            const merged = [...new Set([...state.favs, ...remote])];
            state.favs = merged;
            store.set(FAV_KEY, merged);
          }
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }
  function saveFavs() {
    store.set(FAV_KEY, state.favs);
    if (cloud) { try { cloud.setItem(FAV_KEY, state.favs.join(',').slice(0, 4000)); } catch (e) {} }
  }
  function toggleFav(r) {
    const id = favId(r);
    const on = !state.favs.includes(id);
    state.favs = on ? [id, ...state.favs] : state.favs.filter((x) => x !== id);
    saveFavs();
    try { tg && tg.HapticFeedback.impactOccurred(on ? 'medium' : 'light'); } catch (e) {}
    document.querySelectorAll(`.cover[data-key="${CSS.escape(keyOf(r))}"]`).forEach((el) => el.classList.toggle('fav', on));
    updateFavUI();
    if (state.view === 'favs') renderFavs();
    return on;
  }

  // ---------- Covers ----------
  const liveCovers = store.get('liveCovers', {});
  const pendingLookups = new Map();
  function coverUrl(r) {
    const k = keyOf(r);
    return state.covers[k] || liveCovers[k] || '';
  }
  async function lookupCover(r) {
    const k = keyOf(r);
    if (k in state.covers || k in liveCovers || r.unsure) return '';
    if (pendingLookups.has(k)) return pendingLookups.get(k);
    const p = (async () => {
      try {
        const term = encodeURIComponent(`${r.artist} ${r.album.replace(/\(.*?\)/g, '')}`);
        const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=album&limit=5`);
        const d = await res.json();
        const a = r.artist.toLowerCase();
        const hit = (d.results || []).find((x) => (x.artistName || '').toLowerCase().includes(a.split(' ')[0]));
        const url = hit ? hit.artworkUrl100.replace('100x100bb', '600x600bb') : '';
        liveCovers[k] = url;
        store.set('liveCovers', liveCovers);
        return url;
      } catch (e) { return ''; }
    })();
    pendingLookups.set(k, p);
    return p;
  }

  function coverHTML(r, opts = {}) {
    const c = col(r.shelfNo);
    const url = coverUrl(r);
    const initials = esc((r.artist || '?').replace(/^the\s+/i, '').slice(0, 10));
    return `<div class="cover${isFav(r) ? ' fav' : ''}" style="--c:${c}" data-key="${esc(keyOf(r))}">
      <i class="heart" aria-hidden="true"></i>
      <div class="ph"><span>${initials}</span></div>
      ${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">` : ''}
      ${opts.year && r.year ? `<span class="year">${r.year}</span>` : ''}
    </div>`;
  }
  function wireCovers(root) {
    root.querySelectorAll('.cover img').forEach((img) => {
      if (img.complete && img.naturalWidth) img.classList.add('loaded');
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
    });
    const missing = [...root.querySelectorAll('.cover:not(:has(img))')];
    if (!missing.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach(async (en) => {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        const r = state.records.find((x) => keyOf(x) === en.target.dataset.key);
        if (!r) return;
        const url = await lookupCover(r);
        if (url && !en.target.querySelector('img')) {
          const img = new Image();
          img.alt = '';
          img.onload = () => img.classList.add('loaded');
          img.src = url;
          en.target.insertBefore(img, en.target.querySelector('.year'));
        }
      });
    }, { rootMargin: '200px' });
    missing.forEach((el) => io.observe(el));
  }

  // ---------- Catalog ----------
  function buildShelves() {
    const map = new Map();
    state.records.forEach((r) => {
      if (!map.has(r.shelfNo)) map.set(r.shelfNo, { no: r.shelfNo, name: r.shelf, count: 0 });
      map.get(r.shelfNo).count++;
    });
    state.shelves = [...map.values()].sort((a, b) => a.no - b.no);
    const chips = [`<button class="chip" role="tab" data-shelf="0" aria-selected="true">Все <span class="num">${state.records.length}</span></button>`]
      .concat(state.shelves.map((s) => `<button class="chip" role="tab" data-shelf="${s.no}" aria-selected="false" style="--c:${col(s.no)}"><i class="dot"></i>${esc(s.name)} <span class="num">${s.count}</span></button>`));
    $('#shelf-chips').innerHTML = chips.join('');

    const decades = [...new Set(state.records.filter((r) => r.year).map((r) => Math.floor(r.year / 10) * 10))].sort();
    $('#f-decade').innerHTML = '<option value="">Все годы</option>' + decades.map((d) => `<option value="${d}">${d}-е</option>`).join('');
    $('#count-line').textContent = `${state.records.length} пластинок на ${state.shelves.length} полках`;
  }

  function tempoOk(r, t) {
    if (!t) return true;
    if (r.bpmMin == null) return false;
    const mid = (r.bpmMin + r.bpmMax) / 2;
    if (t === 'slow') return mid < 95;
    if (t === 'mid') return mid >= 95 && mid <= 120;
    return mid > 120;
  }

  function filtered() {
    const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let list = state.records.filter((r) =>
      (!state.shelf || r.shelfNo === state.shelf) &&
      (!state.decade || (r.year && Math.floor(r.year / 10) * 10 === Number(state.decade))) &&
      tempoOk(r, state.tempo) &&
      words.every((w) => r.hay.includes(w)));
    const byArtist = (a, b) => a.artist.replace(/^the\s+/i, '').localeCompare(b.artist.replace(/^the\s+/i, ''), 'ru');
    if (state.sort === 'year') list = list.slice().sort((a, b) => (a.year || 9999) - (b.year || 9999) || byArtist(a, b));
    else if (state.sort === 'artist') list = list.slice().sort(byArtist);
    return list;
  }

  function recHTML(r, showYear = true) {
    return `<button class="rec" data-id="${r.id}">${coverHTML(r, { year: showYear })}<div class="t">${esc(r.album)}</div><div class="a">${esc(r.artist)}</div></button>`;
  }

  function renderGrid() {
    const list = filtered();
    const grid = $('#grid');
    let html = '';
    if (state.sort === 'shelf' && !state.shelf) {
      let last = null;
      list.forEach((r) => {
        if (r.shelfNo !== last) {
          last = r.shelfNo;
          html += `<div class="shelf-head" style="--c:${col(r.shelfNo)}">${esc(r.shelf)}</div>`;
        }
        html += recHTML(r);
      });
    } else {
      html = list.map((r) => recHTML(r)).join('');
    }
    grid.innerHTML = html;
    $('#empty').hidden = list.length > 0;
    wireCovers(grid);
  }

  // ---------- Detail sheet ----------
  function openSheet(r) {
    state.current = r;
    haptic();
    $('#d-cover').innerHTML = coverHTML(r);
    $('#d-album').textContent = r.album;
    $('#d-artist').textContent = r.artist;
    $('#d-meta').innerHTML = [
      ['Год', r.year || '—'], ['BPM', r.bpm || '—'], ['Полка', r.shelfNo || '—'],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
    $('#d-tags').innerHTML = `<span class="tag" style="border-color:${col(r.shelfNo)}">📦 ${esc(r.shelf)}</span>` +
      r.tags.map((t) => `<button class="tag" data-tag="${esc(t)}">${esc(t)}</button>`).join('');
    updateFavUI();

    const sim = similar(r);
    $('#d-similar-wrap').hidden = !sim.length;
    $('#d-similar').innerHTML = sim.map((x) => recHTML(x, false)).join('');

    $('#sheet').hidden = false;
    document.body.style.overflow = 'hidden';
    $('.sheet').scrollTop = 0;
    wireCovers($('#sheet'));
    if (tg) tg.BackButton.show();
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    document.body.style.overflow = '';
    state.current = null;
    if (tg) tg.BackButton.hide();
  }
  function similar(r) {
    const mine = new Set(r.tags.map((t) => t.toLowerCase()));
    return state.records
      .filter((x) => x.id !== r.id)
      .map((x) => {
        let s = x.tags.reduce((n, t) => n + (mine.has(t.toLowerCase()) ? 2 : 0), 0);
        if (x.shelfNo === r.shelfNo) s += 0.5;
        if (x.artist === r.artist) s += 1;
        if (r.bpmMin != null && x.bpmMin != null && Math.abs((x.bpmMin + x.bpmMax) - (r.bpmMin + r.bpmMax)) < 30) s += 0.5;
        return [x, s];
      })
      .filter(([, s]) => s >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([x]) => x);
  }

  function updateFavUI() {
    const r = state.current;
    if (r) {
      const on = isFav(r);
      const b = $('#d-fav');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.querySelector('span').textContent = on ? 'В избранном' : 'В избранное';
    }
    const badge = $('#fav-badge');
    badge.hidden = !state.favs.length;
    badge.textContent = state.favs.length;
  }

  // ---------- Что поставить ----------
  const has = (r, re) => re.test(`${r.genre} ${r.album} ${r.shelf}`);
  const mid = (r) => (r.bpmMin != null ? (r.bpmMin + r.bpmMax) / 2 : null);
  const MOODS = [
    { id: 'calm', e: '☕', name: 'Тихий фон', hint: 'Разговоры, день, мягко', why: 'спокойно и не мешает разговору',
      test: (r) => mid(r) != null && mid(r) <= 105 && !has(r, /metal|punk|hard rock|grunge|metalcore/i) && has(r, /ambient|jazz|soul|city pop|folk|chanson|downtempo|lo-fi|acoustic|singer|bolero|minimal|new age|neo-soul|smooth/i) },
    { id: 'dinner', e: '🍷', name: 'Под ужин', hint: 'Тепло, бархатно, со вкусом', why: 'тёплый звук под бокал',
      test: (r) => mid(r) != null && mid(r) <= 118 && has(r, /jazz|soul|chanson|city pop|bolero|latin|flamenco|smooth|r&b|art pop|soft rock|aor/i) && !has(r, /hip-hop|rap|metal/i) },
    { id: 'drive', e: '🔥', name: 'Раскачать зал', hint: 'Гитары, драйв, громко', why: 'драйв и гитары',
      test: (r) => mid(r) != null && mid(r) >= 112 && has(r, /rock|punk|garage|britpop|mod|blues rock|ska/i) && !has(r, /soft rock/i) },
    { id: 'dance', e: '🪩', name: 'Танцпол', hint: 'Диско, фанк, хаус', why: 'ровный танцевальный грув',
      test: (r) => mid(r) != null && mid(r) >= 105 && has(r, /disco|funk|house|dance|eurodisco|eurobeat|synth-pop|techno|garage|italo|balearic|electropop/i) },
    { id: 'retro', e: '📻', name: 'Ностальгия', hint: 'Мелодия, Балкантон, эстрада', why: 'тот самый винил из детства',
      test: (r) => has(r, /мелодия|сов\.|balkanton|эстрад|schlager|бард|chanson|scandinavian|чешск/i) || (r.year && r.year < 1972 && !has(r, /metal|hard rock/i)) },
    { id: 'odd', e: '🌀', name: 'Удиви меня', hint: 'Странное и редкое', why: 'нечасто такое услышишь',
      test: (r) => has(r, /experimental|avant|idm|minimalism|percussive|electroacoustic|city pop|japanese|afrobeat|shoegaze|contemporary|film score/i) },
    { id: 'hiphop', e: '🎤', name: 'Хип-хоп вечер', hint: 'Бит, рэп, нео-соул', why: 'качает головой весь зал',
      test: (r) => has(r, /hip-hop|rap|trip-hop|хип-хоп/i) },
    { id: 'any', e: '🎲', name: 'Наугад', hint: 'Пусть решит судьба', why: 'просто повезло',
      test: () => true },
  ];
  function renderMoods() {
    $('#moods').innerHTML = MOODS.map((m) => `<button class="mood" data-mood="${m.id}" aria-pressed="${state.mood === m.id}"><span class="e">${m.e}</span><b>${m.name}</b><small>${m.hint}</small></button>`).join('');
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function pickFor(moodId) {
    const m = MOODS.find((x) => x.id === moodId);
    const pool = shuffle(state.records.filter((r) => !r.unsure && m.test(r)));
    const out = [], artists = new Set();
    for (const r of pool) {
      if (artists.has(r.artist)) continue;
      artists.add(r.artist);
      out.push(r);
      if (out.length === 3) break;
    }
    return { m, out, total: pool.length };
  }
  function renderPick() {
    if (!state.mood) { $('#pick-result').innerHTML = ''; return; }
    const { m, out, total } = pickFor(state.mood);
    $('#pick-result').innerHTML = `
      <div class="pick-head"><h2>${m.e} ${m.name}</h2><button class="btn small" id="reroll">Ещё варианты ↻</button></div>
      <div class="pick-list">${out.map((r) => `
        <button class="pick" data-id="${r.id}">${coverHTML(r)}
          <div><div class="t">${esc(r.album)}</div><div class="a">${esc(r.artist)}${r.year ? ' · ' + r.year : ''}</div>
          <div class="why">${esc(r.bpm ? r.bpm + ' BPM · ' : '')}${m.why}</div>
          <div class="a">📦 ${esc(r.shelf)}</div></div>
        </button>`).join('') || '<p class="empty">Под это настроение пока ничего нет</p>'}</div>
      <p class="note">Подходит ${total} из ${state.records.length} пластинок</p>`;
    wireCovers($('#pick-result'));
  }

  // ---------- Избранное: вкладка ----------
  function renderFavs() {
    const byId = new Map(state.records.map((r) => [favId(r), r]));
    const list = state.favs.map((id) => byId.get(id)).filter(Boolean);
    $('#fav-sub').textContent = list.length
      ? `${list.length} ${plural(list.length, 'пластинка', 'пластинки', 'пластинок')}. Сохраняется в твоём Telegram.`
      : 'Нажми ♡ в карточке пластинки, и она появится здесь.';
    $('#fav-grid').innerHTML = list.map((r) => recHTML(r)).join('');
    $('#fav-empty').hidden = list.length > 0;
    wireCovers($('#fav-grid'));
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // ---------- Бар: что поставить сейчас (только сотрудникам) ----------
  // Время смены: всё до 6 утра считается продолжением вчерашнего вечера.
  const SLOTS = [
    { id: 'day', from: 6, to: 16, icon: '☀️', name: 'День',
      tip: 'Фон для разговоров и обеда. Негромко и мягко, без резкого вокала.',
      bpm: [70, 105],
      like: /jazz|soul|city pop|bossa|folk|acoustic|smooth|ambient|downtempo|lo-fi|chanson|bolero|latin|singer|neo-soul|soft rock|aor|flamenco|new age|dream pop/i,
      avoid: /metal|punk|hard rock|grunge|techno|metalcore|industrial|rap|big room|eurodisco/i },
    { id: 'after', from: 16, to: 19, icon: '🌇', name: 'После работы',
      tip: 'Люди приходят выдохнуть. Тёплый грув, средний темп.',
      bpm: [85, 115],
      like: /soul|funk|city pop|neo-soul|r&b|soft rock|aor|indie|jazz|art pop|dream pop|psychedelic pop|britpop|folk rock|bossa|balearic/i,
      avoid: /metal|punk|techno|metalcore|industrial|big room|ambient|experimental/i },
    { id: 'evening', from: 19, to: 22, icon: '🍷', name: 'Вечер',
      tip: 'Зал заполняется. Узнаваемые альбомы, классика рока и соула, грув.',
      bpm: [95, 125],
      like: /funk|soul|disco|rock|synth-pop|new wave|art rock|britpop|r&b|city pop|psychedelic|glam|mod|blues/i,
      avoid: /ambient|experimental|metalcore|minimal|new age|бард|electroacoustic/i },
    { id: 'peak', from: 22, to: 25, icon: '🔥', name: 'Пик',
      tip: 'Самое людное время. Энергия и ритм, можно громче.',
      bpm: [110, 140],
      like: /disco|funk|house|dance|rock|britpop|garage|punk|hip-hop|eurodisco|italo|electro|synth-pop|big beat|mod|glam|eurobeat|ska/i,
      avoid: /ambient|chanson|folk|бард|experimental|new age|minimalism|soft rock|bolero|smooth/i },
    { id: 'late', from: 25, to: 27, icon: '🌙', name: 'Глубокая ночь',
      tip: 'Остались свои. Электроника, хип-хоп, гипнотичный грув.',
      bpm: [95, 130],
      like: /house|techno|electronic|idm|minimal|trip-hop|hip-hop|deep|balearic|psychedelic|garage|neo-soul|alternative|industrial|rap/i,
      avoid: /chanson|эстрад|schlager|bolero|folk|soft rock|aor/i },
    { id: 'close', from: 27, to: 30, icon: '🕯', name: 'Закрытие',
      tip: 'Сбавляем обороты. Медленно и тихо, подводим к закрытию.',
      bpm: [60, 100],
      like: /ambient|downtempo|jazz|soul|lo-fi|chill|acoustic|minimalism|new age|dream pop|neo-soul|trip-hop|singer|electroacoustic/i,
      avoid: /punk|metal|disco|house|eurodisco|techno|big room|hard rock|dance/i },
  ];
  const CROWD = { quiet: { label: 'Тихо', shift: -12 }, normal: { label: 'Нормально', shift: 0 }, packed: { label: 'Битком', shift: 10 } };
  const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const PLAYED_KEY = 'played';
  const PLAYED_TTL = 10 * 3600 * 1000;
  const bar = { slot: null, crowd: store.get('crowd', 'normal'), manual: false };

  function shiftClock(d = new Date()) {
    let h = d.getHours() + d.getMinutes() / 60;
    const day = new Date(d);
    if (h < 6) { h += 24; day.setDate(day.getDate() - 1); }
    return { h, day };
  }
  function currentSlot() {
    const { h } = shiftClock();
    return SLOTS.find((s) => h >= s.from && h < s.to) || SLOTS[0];
  }
  function playedMap() {
    const now = Date.now();
    const m = store.get(PLAYED_KEY, {});
    Object.keys(m).forEach((k) => { if (now - m[k] > PLAYED_TTL) delete m[k]; });
    return m;
  }
  function seeded(str) { // стабильный «случай» на час: список не скачет при каждом открытии
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 1000) / 1000;
  }
  function slotRange(slot) {
    const { day } = shiftClock();
    const weekend = slot.from >= 19 && (day.getDay() === 5 || day.getDay() === 6);
    const s = CROWD[bar.crowd].shift + (weekend ? 5 : 0);
    return [slot.bpm[0] + s, slot.bpm[1] + s, weekend];
  }
  function scoreFor(r, slot, lo, hi) {
    const text = `${r.genre} ${r.album}`;
    const likes = (text.match(new RegExp(slot.like.source, 'gi')) || []).length;
    let s = Math.min(likes, 3) * 2;
    if (slot.avoid.test(text)) s -= 6;
    const m = mid(r);
    if (m != null) {
      if (m >= lo && m <= hi) s += 3;
      else s -= Math.min((m < lo ? lo - m : m - hi) / 8, 4);
    }
    return s;
  }
  function recommend(slot) {
    const [lo, hi] = slotRange(slot);
    const played = playedMap();
    const hourSeed = `${new Date().toDateString()}|${new Date().getHours()}|${slot.id}|${bar.crowd}`;
    const scored = state.records
      .filter((r) => !r.unsure)
      .map((r) => ({ r, s: scoreFor(r, slot, lo, hi) + seeded(hourSeed + keyOf(r)) * 1.5, played: !!played[keyOf(r)] }))
      .filter((x) => x.s > 2);
    scored.sort((a, b) => b.s - a.s);
    const out = [], artists = new Set();
    for (const x of scored) {
      if (x.played || artists.has(x.r.artist)) continue;
      artists.add(x.r.artist);
      out.push(x.r);
      if (out.length === 10) break;
    }
    return { list: out, lo, hi, playedCount: Object.keys(played).length };
  }
  const fmtH = (h) => `${String(h % 24).padStart(2, '0')}:00`;

  function renderBar() {
    if (!state.isStaff) return;
    if (!bar.manual) bar.slot = currentSlot().id;
    const slot = SLOTS.find((s) => s.id === bar.slot);
    const now = new Date();
    const { day } = shiftClock(now);
    const { list, lo, hi, playedCount } = recommend(slot);
    const weekend = slotRange(slot)[2];
    const nowSlot = currentSlot();
    const nextSlot = SLOTS[(SLOTS.indexOf(nowSlot) + 1) % SLOTS.length];
    $('#bar-now').innerHTML = `
      <div class="bar-clock">${now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })} · ${DAYS[day.getDay()]}${weekend ? ' · выходной вечер' : ''}</div>
      <div class="bar-slot"><span>${slot.icon}</span>${slot.name}${bar.manual ? ' <em>выбрано вручную</em>' : ''}</div>
      <p class="bar-tip">${slot.tip}</p>
      <div class="bar-target">Темп <b>${lo}–${hi} BPM</b>${!bar.manual ? ` · с ${fmtH(nextSlot.from)} «${nextSlot.name}»` : ''}</div>`;
    $('#bar-slots').innerHTML = SLOTS.map((s) => `<button class="chip" data-slot="${s.id}" aria-selected="${s.id === slot.id}">${s.icon} ${s.name}${s.id === nowSlot.id ? ' · сейчас' : ''}</button>`).join('');
    const selChip = $('#bar-slots [aria-selected="true"]');
    if (selChip) selChip.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('#bar-crowd').innerHTML = Object.entries(CROWD).map(([k, v]) => `<button data-crowd="${k}" aria-pressed="${k === bar.crowd}">${v.label}</button>`).join('');
    $('#bar-list').innerHTML = list.map((r, i) => `
      <div class="bar-item">
        <button class="bar-open" data-id="${r.id}">
          <span class="bar-rank">${i + 1}</span>${coverHTML(r)}
          <span class="bar-txt"><b>${esc(r.album)}</b><span>${esc(r.artist)}</span></span>
        </button>
        <div class="bar-meta">
          <span class="bar-shelf" style="--c:${col(r.shelfNo)}">Полка ${r.shelfNo}</span>
          <span class="bar-bpm">${esc(r.bpm || '—')}</span>
          <button class="bar-play" data-play="${esc(keyOf(r))}" aria-label="Отметить: ставлю">▶</button>
        </div>
      </div>`).join('') || '<p class="empty">Под это время ничего не подобралось. Попробуй другую загруженность.</p>';
    $('#bar-played').innerHTML = playedCount
      ? `Уже играли за смену: ${playedCount}, они скрыты из подсказок. <button class="link" id="bar-reset">Сбросить</button>`
      : 'Нажми ▶, когда ставишь пластинку: до конца смены она пропадёт из подсказок.';
    wireCovers($('#bar-list'));
  }
  function markPlayed(key) {
    const m = playedMap();
    m[key] = Date.now();
    store.set(PLAYED_KEY, m);
    try { tg && tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
    const r = state.records.find((x) => keyOf(x) === key);
    toast(r ? `Играет: ${r.artist} — ${r.album}` : 'Отмечено');
    renderBar();
  }

  async function checkStaff() {
    if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('staff')) return true; // только для проверки на компьютере
    const initData = (tg && tg.initData) || '';
    if (!API || !initData) return false;
    try {
      const res = await fetch(API, { method: 'POST', body: JSON.stringify({ action: 'me', initData }) });
      const d = await res.json();
      return !!(d.ok && d.isStaff);
    } catch (e) {
      return store.get('isStaff', false); // нет сети: помним прошлую проверку
    }
  }
  function enableStaff(on) {
    state.isStaff = on;
    store.set('isStaff', on);
    document.querySelector('.tab[data-view="bar"]').hidden = !on;
    document.querySelector('.tabbar').classList.toggle('four', on);
    if (!on && state.view === 'bar') showView('catalog');
  }

  // ---------- UI glue ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    window.scrollTo(0, 0);
    state.view = name;
    if (name === 'favs') renderFavs();
    if (name === 'bar') renderBar();
  }
  function findRec(id) { return state.records.find((r) => r.id === Number(id)); }

  function wire() {
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { haptic(); showView(b.dataset.view); }));
    let qTimer;
    $('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; renderGrid(); }, 120); });
    $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('#shelf-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      haptic();
      state.shelf = Number(c.dataset.shelf);
      document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-selected', String(x === c)));
      c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      renderGrid();
    });
    $('#f-decade').addEventListener('change', (e) => { state.decade = e.target.value; renderGrid(); });
    $('#f-tempo').addEventListener('change', (e) => { state.tempo = e.target.value; renderGrid(); });
    $('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderGrid(); });

    document.addEventListener('click', (e) => {
      const rec = e.target.closest('.rec, .pick');
      if (rec) { const r = findRec(rec.dataset.id); if (r) openSheet(r); return; }
      if (e.target.closest('[data-close]')) { closeSheet(); return; }
      const tag = e.target.closest('[data-tag]');
      if (tag) {
        closeSheet();
        showView('catalog');
        state.q = tag.dataset.tag; state.shelf = 0;
        $('#q').value = state.q;
        document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.shelf === '0')));
        renderGrid();
        return;
      }
      if (e.target.closest('#d-fav')) { if (state.current) toggleFav(state.current); return; }
      if (e.target.closest('#fav-go')) { showView('catalog'); return; }
      const play = e.target.closest('[data-play]');
      if (play) { markPlayed(play.dataset.play); return; }
      const open = e.target.closest('.bar-open');
      if (open) { const r = findRec(open.dataset.id); if (r) openSheet(r); return; }
      const sl = e.target.closest('[data-slot]');
      if (sl) { haptic(); bar.slot = sl.dataset.slot; bar.manual = sl.dataset.slot !== currentSlot().id; renderBar(); return; }
      const cr = e.target.closest('[data-crowd]');
      if (cr) { haptic(); bar.crowd = cr.dataset.crowd; store.set('crowd', bar.crowd); renderBar(); return; }
      if (e.target.closest('#bar-reset')) { store.set(PLAYED_KEY, {}); renderBar(); return; }
      const mood = e.target.closest('.mood');
      if (mood) { haptic(); state.mood = mood.dataset.mood; renderMoods(); renderPick(); $('#pick-result').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (e.target.closest('#reroll')) { haptic(); renderPick(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  }

  async function init() {
    wire();
    renderMoods();
    const fresh = loadFreshCatalog();
    const [raw, covers] = await Promise.all([loadLocalCatalog(), loadCovers(), loadFavs()]);
    state.covers = covers || {};
    state.records = prep(raw);
    buildShelves();
    renderGrid();
    updateFavUI();
    fresh.then((list) => {
      if (!list || JSON.stringify(list) === JSON.stringify(raw)) return;
      state.records = prep(list);
      const shelf = state.shelf;
      buildShelves();
      state.shelf = shelf;
      document.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-selected', String(Number(x.dataset.shelf) === shelf)));
      renderGrid();
      if (state.view === 'favs') renderFavs();
      if (state.view === 'pick') renderPick();
    });
    if (store.get('isStaff', false)) enableStaff(true); // показать сразу, потом перепроверить
    checkStaff().then(enableStaff);
    setInterval(() => { if (state.view === 'bar' && !bar.manual) renderBar(); }, 60000);
    const start = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
    if (start === 'pick') showView('pick');
    if (start === 'favs') showView('favs');
  }

  init().catch((e) => { $('#count-line').textContent = 'Не удалось загрузить каталог'; console.error(e); });
})();
