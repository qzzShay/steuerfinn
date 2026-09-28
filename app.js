'use strict';
/* SteuerFinn – Fahrten, Ausgaben & Einnahmen für Ausbildung und Gewerbe.
   Alle Daten bleiben lokal im Browser (IndexedDB). Kein Server. */

// ================= Helfer =================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const eur = (n) => (n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const dec = (n, d = 2) => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
// "1.234,56" und "12,5" (deutsch) sowie "12.5" (Punkt als Komma) verstehen
const parseNum = (v) => {
  let s = String(v).trim().replace(/\s|€/g, '');
  s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
};
const parseKm = (v) => { const n = parseFloat(String(v).trim().replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const round2 = (n) => Math.round(n * 100) / 100;

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
const PALETTE = ['#2f5d8a', '#b5651d', '#1f6f4a', '#8a3b5c', '#6b5b95', '#3d7f8c', '#a08c2a', '#5a5a5a'];
const BEREICH = { ausbildung: 'Ausbildung', gewerbe: 'Gewerbe' };
const STATUS = { urlaub: 'Urlaub', krank: 'Krank', frei: 'Frei' };
const AUSGABE_KAT = ['Arbeitsmittel', 'Fachliteratur', 'Arbeitskleidung', 'Software / Abos', 'Telefon / Internet', 'Büromaterial', 'Fortbildung / Kurse', 'Porto / Versand', 'Wareneinkauf', 'Werbung', 'Gebühren / Versicherung', 'Reisekosten (sonstige)', 'Sonstiges'];
const EINNAHME_KAT = ['Umsatz / Verkauf', 'Honorar / Dienstleistung', 'Sonstige Einnahme'];

// ================= Steuerlogik =================
// Dienstreise / auswärtige Tätigkeit: 0,30 € je gefahrenem km (Hin- und Rückfahrt).
const REISE_RATE = 0.30;

// Entfernungspauschale je Arbeitstag (nur einfache Strecke).
function pendelBetrag(km, year) {
  if (year >= 2026) return km * 0.38; // ab 2026: 0,38 € ab dem ersten km
  const far = year >= 2022 ? 0.38 : year === 2021 ? 0.35 : 0.30;
  return Math.min(km, 20) * 0.30 + Math.max(km - 20, 0) * far;
}
function pendelSatzText(year) {
  if (year >= 2026) return '0,38 €/km ab dem 1. km';
  if (year >= 2022) return '0,30 €/km (bis 20 km), 0,38 € ab km 21';
  if (year === 2021) return '0,30 €/km (bis 20 km), 0,35 € ab km 21';
  return '0,30 €/km';
}

// Berechnet die absetzbaren Fahrtkosten eines Tages.
// Entfernungspauschale zählt nur einmal pro Tag (höchster Wert), Reisekosten zusätzlich.
function dayCalc(rec) {
  if (!rec || rec.status) return [];
  const year = +rec.date.slice(0, 4);
  const out = [];
  let best = null;
  const dropped = [];
  for (const pid of rec.placeIds || []) {
    const p = placeById(pid);
    if (!p) continue;
    if (p.mode === 'pendel') {
      const item = { p, art: 'pendel', km: p.km, betrag: round2(pendelBetrag(p.km, year)) };
      if (!best || item.betrag > best.betrag) { if (best) dropped.push(best); best = item; } else dropped.push(item);
    } else {
      out.push({ p, art: 'reise', km: p.km * 2, betrag: round2(p.km * 2 * REISE_RATE) });
    }
  }
  if (best) out.unshift(best);
  out.dropped = dropped;
  return out;
}

// Bundesweite Feiertage (landesspezifische bitte selbst als "Frei" markieren)
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
const holCache = new Map();
function holidays(y) {
  if (holCache.has(y)) return holCache.get(y);
  const e = easter(y);
  const rel = (n) => { const d = new Date(e); d.setDate(d.getDate() + n); return iso(d); };
  const map = new Map([
    [`${y}-01-01`, 'Neujahr'], [rel(-2), 'Karfreitag'], [rel(1), 'Ostermontag'], [`${y}-05-01`, 'Tag der Arbeit'],
    [rel(39), 'Christi Himmelfahrt'], [rel(50), 'Pfingstmontag'], [`${y}-10-03`, 'Tag der Deutschen Einheit'],
    [`${y}-12-25`, '1. Weihnachtstag'], [`${y}-12-26`, '2. Weihnachtstag'],
  ]);
  holCache.set(y, map);
  return map;
}

// ================= IndexedDB =================
let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('steuerfinn', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('places', { keyPath: 'id' });
        d.createObjectStore('days', { keyPath: 'date' });
        d.createObjectStore('entries', { keyPath: 'id' });
        d.createObjectStore('settings');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
async function tx(stores, mode, fn) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => res(req && 'result' in req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const idb = {
  all: (s) => tx(s, 'readonly', (t) => t.objectStore(s).getAll()),
  get: (s, k) => tx(s, 'readonly', (t) => t.objectStore(s).get(k)),
  put: (s, v, k) => tx(s, 'readwrite', (t) => (k === undefined ? t.objectStore(s).put(v) : t.objectStore(s).put(v, k))),
  putMany: (s, arr) => tx(s, 'readwrite', (t) => { const st = t.objectStore(s); arr.forEach((v) => st.put(v)); }),
  del: (s, k) => tx(s, 'readwrite', (t) => t.objectStore(s).delete(k)),
  delMany: (s, keys) => tx(s, 'readwrite', (t) => { const st = t.objectStore(s); keys.forEach((k) => st.delete(k)); }),
  clearAll: () => tx(['places', 'days', 'entries', 'settings'], 'readwrite', (t) => { ['places', 'days', 'entries', 'settings'].forEach((s) => t.objectStore(s).clear()); }),
};

// ================= Zustand =================
const now = new Date();
const S = {
  view: 'fahrten',
  month: new Date(now.getFullYear(), now.getMonth(), 1),
  year: now.getFullYear(),
  filter: 'alle',
  places: [],
  days: new Map(),
  entries: [],
  cfg: {},
};
const placeById = (id) => S.places.find((p) => p.id === id);

async function load() {
  S.places = (await idb.all('places')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  S.days = new Map((await idb.all('days')).map((d) => [d.date, d]));
  S.entries = await idb.all('entries');
  S.cfg = (await idb.get('settings', 'cfg')) || {};
}
async function saveCfg(patch) {
  Object.assign(S.cfg, patch);
  await idb.put('settings', S.cfg, 'cfg');
}
let persistAsked = false;
async function askPersist() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch { /* egal */ }
}

// ================= UI-Grundgerüst =================
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2400);
}

let sheetUrls = [];
function openSheet(html) {
  const root = $('#sheet');
  root.innerHTML = `<div class="sheet-backdrop" data-act="closeSheet"></div><div class="sheet-panel" role="dialog" aria-modal="true"><div class="grip"></div>${html}</div>`;
  root.setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('open')));
  return $('.sheet-panel', root);
}
function closeSheet() {
  const root = $('#sheet');
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('locked');
  sheetUrls.forEach((u) => URL.revokeObjectURL(u));
  sheetUrls = [];
  setTimeout(() => { if (!root.classList.contains('open')) root.innerHTML = ''; }, 300);
}

function showImage(blob) {
  const v = $('#viewer');
  const url = URL.createObjectURL(blob);
  if (blob.type === 'application/pdf') { window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); return; }
  v.innerHTML = `<button class="btn sm">Schließen</button><img alt="Beleg" src="${url}">`;
  v.hidden = false;
  v.onclick = () => { v.hidden = true; v.innerHTML = ''; URL.revokeObjectURL(url); };
}

function render() {
  const titles = { fahrten: 'Fahrten', belege: 'Belege', uebersicht: 'Übersicht', mehr: 'Mehr' };
  $$('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  $('#title').textContent = titles[S.view];
  $('#main').innerHTML = { fahrten: vFahrten, belege: vBelege, uebersicht: vUebersicht, mehr: vMehr }[S.view]();
}

const pressed = (b) => (b ? 'true' : 'false');
const placeMeta = (p) => {
  const days = WD_ORDER.filter((d) => (p.weekdays || []).includes(d)).map((d) => WD[d]).join(', ');
  const art = p.mode === 'pendel' ? 'Entfernungspauschale' : 'Reisekosten';
  return `${dec(p.km, p.km % 1 ? 1 : 0)} km · ${art}${days ? ' · ' + days : ''}`;
};

// ================= Ansicht: Fahrten =================
function vFahrten() {
  const y = S.month.getFullYear(), mo = S.month.getMonth();
  const hol = holidays(y);
  const tIso = iso(new Date());
  const offset = (new Date(y, mo, 1).getDay() + 6) % 7;
  const dim = new Date(y, mo + 1, 0).getDate();

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<span class="cell empty"></span>';
  let tage = 0, sum = 0, km = 0;
  const cnt = {};
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(y, mo, d), ds = iso(dt), rec = S.days.get(ds), dow = dt.getDay();
    const calc = dayCalc(rec);
    if (calc.length) { tage++; calc.forEach((c) => { sum += c.betrag; km += c.art === 'reise' ? c.km : c.km * 2; }); }
    (rec?.placeIds || []).forEach((pid) => { cnt[pid] = (cnt[pid] || 0) + 1; });
    const cls = ['cell'];
    if (ds === tIso) cls.push('today');
    if (ds > tIso) cls.push('future');
    if (dow === 0 || dow === 6) cls.push('we');
    if (hol.has(ds)) cls.push('hol');
    if (calc.length) cls.push('has');
    const dots = (rec?.placeIds || []).map((pid) => { const p = placeById(pid); return p ? `<i style="background:${p.color}"></i>` : ''; }).join('');
    const stamp = rec?.status ? `<b class="stamp">${STATUS[rec.status]}</b>` : '';
    const label = `${d}. ${MONTHS[mo]}${hol.has(ds) ? ', ' + hol.get(ds) : ''}`;
    cells += `<button class="${cls.join(' ')}" data-act="day" data-date="${ds}" aria-label="${esc(label)}"><span class="n">${d}</span>${stamp}<span class="dots">${dots}</span></button>`;
  }

  const monthStart = iso(new Date(y, mo, 1));
  const canFill = monthStart <= tIso && S.places.some((p) => (p.weekdays || []).length);

  if (!S.places.length) {
    return `
      <section class="card">
        <div class="empty">
          <p class="big">Erst deine Orte anlegen</p>
          <p class="muted">Zum Beispiel <b>Berufsschule</b>, <b>Arbeit Standort 1</b> und <b>Standort 2</b>, jeweils mit Entfernung und festen Wochentagen.</p>
          <button class="btn primary" data-act="place" style="margin-top:10px">+ Ort anlegen</button>
        </div>
      </section>`;
  }

  return `
    <section class="card">
      <div class="nav-period">
        <button class="icon-btn" data-act="month" data-d="-1" aria-label="Vorheriger Monat">‹</button>
        <span class="label">${MONTHS[mo]} ${y}</span>
        <button class="icon-btn" data-act="month" data-d="1" aria-label="Nächster Monat">›</button>
      </div>
      <div class="cal-head">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal">${cells}</div>
      <div class="stats">
        <div class="stat"><b>${tage}</b><span>Fahrtage</span></div>
        <div class="stat"><b>${dec(km, 0)}</b><span>km gefahren</span></div>
        <div class="stat"><b>${dec(sum)}</b><span>€ absetzbar</span></div>
      </div>
      <div class="btn-row">
        ${canFill ? '<button class="btn primary" data-act="fillPlan">Wochenplan eintragen</button>' : ''}
        <button class="btn" data-act="range">Zeitraum festlegen</button>
      </div>
      <p class="explain">Tippe auf einen Tag, um ihn zu ändern. „Wochenplan eintragen“ füllt alle leeren Tage bis heute nach deinen festen Wochentagen (Feiertage ausgenommen).</p>
    </section>

    <section class="card">
      <p class="eyebrow">Deine Orte</p>
      <ul class="list">
        ${S.places.map((p) => `
          <li><button class="row" data-act="place" data-id="${p.id}">
            <span class="swatch" style="background:${p.color}"></span>
            <span class="grow"><span class="t">${esc(p.name)} <span class="tag ${p.bereich}">${BEREICH[p.bereich]}</span></span><span class="s">${esc(placeMeta(p))}</span></span>
            <span class="amt">${cnt[p.id] || 0}×</span>
          </button></li>`).join('')}
      </ul>
      <div class="btn-row"><button class="btn ghost" data-act="place">+ Ort hinzufügen</button></div>
    </section>`;
}

function calcHtml(calc) {
  if (!calc.length && !(calc.dropped || []).length) return '';
  const lines = calc.map((c) => c.art === 'pendel'
    ? `<div class="line"><span>${esc(c.p.name)} · ${dec(c.km, c.km % 1 ? 1 : 0)} km einfach<br><small class="muted">Entfernungspauschale</small></span><b class="amt">${eur(c.betrag)}</b></div>`
    : `<div class="line"><span>${esc(c.p.name)} · ${dec(c.km, c.km % 1 ? 1 : 0)} km hin + zurück<br><small class="muted">Reisekosten 0,30 €/km</small></span><b class="amt">${eur(c.betrag)}</b></div>`);
  (calc.dropped || []).forEach((c) => lines.push(`<div class="line"><span class="x">${esc(c.p.name)}</span><small class="muted">Pauschale nur 1× pro Tag</small></div>`));
  return lines.join('');
}

function daySheet(ds) {
  const dt = parseIso(ds);
  const rec = S.days.get(ds) || { date: ds, placeIds: [], status: null, note: '' };
  const sel = new Set(rec.placeIds || []);
  let status = rec.status || null;
  const hol = holidays(dt.getFullYear()).get(ds);

  const p = openSheet(`
    <p class="eyebrow">${WD_LONG[dt.getDay()]}</p>
    <h2>${dt.getDate()}. ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}</h2>
    ${hol ? `<p class="note-hol">Feiertag · ${esc(hol)}</p>` : ''}
    <div class="field"><span class="lbl">Wo warst du?</span>
      <div class="chips" id="dPlaces">${S.places.map((pl) => `<button type="button" class="chip" data-pid="${pl.id}" style="--c:${pl.color}">${esc(pl.name)}</button>`).join('') || '<span class="muted">Noch keine Orte angelegt.</span>'}</div>
    </div>
    <div class="field"><span class="lbl">Oder nicht gefahren</span>
      <div class="chips" id="dStatus">${Object.entries(STATUS).map(([k, v]) => `<button type="button" class="chip ghost" data-st="${k}">${v}</button>`).join('')}</div>
    </div>
    <label class="field"><span class="lbl">Notiz</span><input id="dNote" value="${esc(rec.note)}" placeholder="optional, z. B. Umweg Kunde"></label>
    <div class="calc" id="dCalc"></div>
    <div class="row-btns">
      <button class="btn ghost" id="dClear">Tag leeren</button>
      <button class="btn primary" id="dSave">Speichern</button>
    </div>`);

  const sync = () => {
    $$('#dPlaces .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(sel.has(b.dataset.pid))));
    $$('#dStatus .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(status === b.dataset.st)));
    $('#dCalc', p).innerHTML = calcHtml(dayCalc({ date: ds, placeIds: [...sel], status }));
  };
  sync();

  p.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-pid]');
    const st = e.target.closest('[data-st]');
    if (chip) { sel.has(chip.dataset.pid) ? sel.delete(chip.dataset.pid) : sel.add(chip.dataset.pid); status = null; sync(); }
    if (st) { status = status === st.dataset.st ? null : st.dataset.st; if (status) sel.clear(); sync(); }
    if (e.target.id === 'dClear') { await setDay(ds, null); closeSheet(); render(); }
    if (e.target.id === 'dSave') {
      const note = $('#dNote', p).value.trim();
      await setDay(ds, sel.size || status || note ? { date: ds, placeIds: [...sel], status, note } : null);
      closeSheet(); render();
    }
  });
}

async function setDay(ds, rec) {
  if (rec) { S.days.set(ds, rec); await idb.put('days', rec); askPersist(); }
  else { S.days.delete(ds); await idb.del('days', ds); }
}

async function fillPlan() {
  const y = S.month.getFullYear(), mo = S.month.getMonth();
  const tIso = iso(new Date()), hol = holidays(y);
  const dim = new Date(y, mo + 1, 0).getDate();
  const recs = [];
  for (let d = 1; d <= dim; d++) {
    const dt = new Date(y, mo, d), ds = iso(dt);
    if (ds > tIso) break;
    if (S.days.has(ds) || hol.has(ds)) continue;
    const pids = S.places.filter((p) => (p.weekdays || []).includes(dt.getDay())).map((p) => p.id);
    if (pids.length) recs.push({ date: ds, placeIds: pids, status: null, note: '' });
  }
  if (!recs.length) { toast('Nichts einzutragen, alle Tage schon belegt.'); return; }
  await idb.putMany('days', recs);
  recs.forEach((r) => S.days.set(r.date, r));
  askPersist();
  render();
  toast(`${recs.length} ${recs.length === 1 ? 'Tag' : 'Tage'} eingetragen`);
}

function rangeSheet() {
  const y = S.month.getFullYear(), mo = S.month.getMonth();
  const from = iso(new Date(y, mo, 1));
  const to = iso(new Date(y, mo + 1, 0));
  const sel = new Set();
  let status = null;
  const wds = new Set([1, 2, 3, 4, 5]);

  const p = openSheet(`
    <p class="eyebrow">Mehrere Tage auf einmal</p>
    <h2>Zeitraum festlegen</h2>
    <p class="explain">Für Blockunterricht, Urlaub, Krankheit oder wenn du eine Zeit lang an einem anderen Standort bist.</p>
    <div class="two">
      <label class="field"><span class="lbl">Von</span><input type="date" id="rFrom" value="${from}"></label>
      <label class="field"><span class="lbl">Bis</span><input type="date" id="rTo" value="${to}"></label>
    </div>
    <div class="field"><span class="lbl">Ort(e)</span>
      <div class="chips" id="rPlaces">${S.places.map((pl) => `<button type="button" class="chip" data-pid="${pl.id}" style="--c:${pl.color}">${esc(pl.name)}</button>`).join('')}</div>
    </div>
    <div class="field"><span class="lbl">Oder abwesend</span>
      <div class="chips" id="rStatus">${Object.entries(STATUS).map(([k, v]) => `<button type="button" class="chip ghost" data-st="${k}">${v}</button>`).join('')}</div>
    </div>
    <div class="field"><span class="lbl">An diesen Wochentagen</span>
      <div class="chips" id="rWd">${WD_ORDER.map((d) => `<button type="button" class="chip plain" data-wd="${d}">${WD[d]}</button>`).join('')}</div>
    </div>
    <label class="check"><input type="checkbox" id="rHol" checked> Feiertage überspringen</label>
    <label class="check"><input type="checkbox" id="rOver" checked> Bereits eingetragene Tage überschreiben</label>
    <div class="row-btns">
      <button class="btn ghost" id="rDelete">Zeitraum leeren</button>
      <button class="btn primary" id="rSave">Übernehmen</button>
    </div>`);

  const sync = () => {
    $$('#rPlaces .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(sel.has(b.dataset.pid))));
    $$('#rStatus .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(status === b.dataset.st)));
    $$('#rWd .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(wds.has(+b.dataset.wd))));
  };
  sync();

  const eachDay = (fn) => {
    const a = $('#rFrom', p).value, b = $('#rTo', p).value;
    if (!a || !b || a > b) { toast('Bitte gültigen Zeitraum wählen.'); return null; }
    const skipHol = $('#rHol', p).checked;
    const list = [];
    for (let d = parseIso(a); iso(d) <= b; d.setDate(d.getDate() + 1)) {
      const ds = iso(d);
      if (!wds.has(d.getDay())) continue;
      if (skipHol && holidays(d.getFullYear()).has(ds)) continue;
      list.push(ds);
      if (list.length > 800) break;
    }
    return fn(list);
  };

  p.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-pid]'), st = e.target.closest('[data-st]'), wd = e.target.closest('[data-wd]');
    if (chip) { sel.has(chip.dataset.pid) ? sel.delete(chip.dataset.pid) : sel.add(chip.dataset.pid); status = null; sync(); }
    if (st) { status = status === st.dataset.st ? null : st.dataset.st; if (status) sel.clear(); sync(); }
    if (wd) { const n = +wd.dataset.wd; wds.has(n) ? wds.delete(n) : wds.add(n); sync(); }
    if (e.target.id === 'rSave') {
      if (!sel.size && !status) { toast('Ort oder Abwesenheit wählen.'); return; }
      const over = $('#rOver', p).checked;
      await eachDay(async (list) => {
        const recs = list.filter((ds) => over || !S.days.has(ds)).map((ds) => ({ date: ds, placeIds: [...sel], status, note: S.days.get(ds)?.note || '' }));
        await idb.putMany('days', recs);
        recs.forEach((r) => S.days.set(r.date, r));
        askPersist();
        closeSheet(); render();
        toast(`${recs.length} ${recs.length === 1 ? 'Tag' : 'Tage'} gesetzt`);
      });
    }
    if (e.target.id === 'rDelete') {
      await eachDay(async (list) => {
        const keys = list.filter((ds) => S.days.has(ds));
        if (!keys.length) { toast('Im Zeitraum ist nichts eingetragen.'); return; }
        if (!confirm(`${keys.length} Tage im Zeitraum leeren?`)) return;
        await idb.delMany('days', keys);
        keys.forEach((k) => S.days.delete(k));
        closeSheet(); render();
        toast(`${keys.length} Tage geleert`);
      });
    }
  });
}

function placeSheet(id) {
  const ex = id ? placeById(id) : null;
  const pl = ex ? { ...ex, weekdays: [...(ex.weekdays || [])] } : {
    id: uid(), name: '', km: '', bereich: 'ausbildung', mode: 'pendel', weekdays: [],
    color: PALETTE[S.places.length % PALETTE.length], order: Date.now(),
  };
  const wds = new Set(pl.weekdays);
  const year = S.month.getFullYear();

  const p = openSheet(`
    <p class="eyebrow">${ex ? 'Ort bearbeiten' : 'Neuer Ort'}</p>
    <h2>${ex ? esc(ex.name) : 'Ort anlegen'}</h2>
    <label class="field"><span class="lbl">Name</span><input id="pName" value="${esc(pl.name)}" placeholder="z. B. Berufsschule, Arbeit Standort 1" autocomplete="off"></label>
    <label class="field"><span class="lbl">Entfernung von zu Hause (einfach, km)</span><input id="pKm" inputmode="decimal" value="${pl.km === '' ? '' : dec(pl.km, pl.km % 1 ? 1 : 0)}" placeholder="z. B. 18"></label>
    <div class="field"><span class="lbl">Bereich</span>
      <div class="seg" id="pBereich">${Object.entries(BEREICH).map(([k, v]) => `<button type="button" data-v="${k}">${v}</button>`).join('')}</div>
    </div>
    <div class="field"><span class="lbl">Abrechnung</span>
      <div class="seg" id="pMode"><button type="button" data-v="pendel">Arbeitsstätte</button><button type="button" data-v="reise">Auswärts</button></div>
      <p class="explain" id="pModeText"></p>
    </div>
    <div class="field"><span class="lbl">Feste Wochentage (Wochenplan)</span>
      <div class="chips" id="pWd">${WD_ORDER.map((d) => `<button type="button" class="chip plain" data-wd="${d}">${WD[d]}</button>`).join('')}</div>
      <p class="explain">Leer lassen, wenn du nur ab und zu dort bist.</p>
    </div>
    <div class="field"><span class="lbl">Farbe</span>
      <div class="swatches" id="pColor">${PALETTE.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>
    </div>
    <div class="row-btns">
      ${ex ? '<button class="btn danger" id="pDel">Löschen</button>' : '<button class="btn ghost" data-act="closeSheet">Abbrechen</button>'}
      <button class="btn primary" id="pSave">Speichern</button>
    </div>`);

  const sync = () => {
    $$('#pBereich button', p).forEach((b) => b.setAttribute('aria-pressed', pressed(pl.bereich === b.dataset.v)));
    $$('#pMode button', p).forEach((b) => b.setAttribute('aria-pressed', pressed(pl.mode === b.dataset.v)));
    $$('#pWd .chip', p).forEach((b) => b.setAttribute('aria-pressed', pressed(wds.has(+b.dataset.wd))));
    $$('#pColor button', p).forEach((b) => b.setAttribute('aria-pressed', pressed(pl.color === b.dataset.c)));
    const km = parseKm($('#pKm', p).value);
    const perDay = Number.isFinite(km) && km > 0
      ? (pl.mode === 'pendel' ? ` Bei ${dec(km, km % 1 ? 1 : 0)} km: ${eur(pendelBetrag(km, year))} pro Tag (${year}).` : ` Bei ${dec(km, km % 1 ? 1 : 0)} km: ${eur(km * 2 * REISE_RATE)} pro Tag.`)
      : '';
    $('#pModeText', p).textContent = pl.mode === 'pendel'
      ? `Erste Tätigkeitsstätte (z. B. Ausbildungsbetrieb): Entfernungspauschale, nur einfache Strecke, ${pendelSatzText(year)}.${perDay}`
      : `Auswärtstätigkeit (z. B. Berufsschule, Kunde, Filiale): 0,30 € je gefahrenem km, Hin- und Rückweg.${perDay}`;
  };
  sync();
  $('#pKm', p).addEventListener('input', sync);

  p.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.parentElement.id === 'pBereich') { pl.bereich = b.dataset.v; sync(); }
    if (b.parentElement.id === 'pMode') { pl.mode = b.dataset.v; sync(); }
    if (b.dataset.wd) { const n = +b.dataset.wd; wds.has(n) ? wds.delete(n) : wds.add(n); sync(); }
    if (b.dataset.c) { pl.color = b.dataset.c; sync(); }
    if (b.id === 'pSave') {
      const name = $('#pName', p).value.trim();
      const km = parseKm($('#pKm', p).value);
      if (!name) { toast('Bitte Namen eingeben.'); return; }
      if (!Number.isFinite(km) || km < 0) { toast('Bitte Entfernung in km eingeben.'); return; }
      Object.assign(pl, { name, km, weekdays: [...wds] });
      await idb.put('places', pl);
      const i = S.places.findIndex((x) => x.id === pl.id);
      if (i >= 0) S.places[i] = pl; else S.places.push(pl);
      askPersist();
      closeSheet(); render();
      toast(ex ? 'Ort gespeichert' : 'Ort angelegt');
    }
    if (b.id === 'pDel') {
      const used = [...S.days.values()].filter((d) => (d.placeIds || []).includes(pl.id));
      if (!confirm(used.length
        ? `„${pl.name}“ löschen? Er ist an ${used.length} Tagen eingetragen. Diese Fahrten fallen dann aus der Berechnung.`
        : `„${pl.name}“ löschen?`)) return;
      await idb.del('places', pl.id);
      S.places = S.places.filter((x) => x.id !== pl.id);
      const changed = used.map((d) => ({ ...d, placeIds: d.placeIds.filter((x) => x !== pl.id) }));
      await idb.putMany('days', changed);
      changed.forEach((d) => S.days.set(d.date, d));
      closeSheet(); render();
    }
  });
}

// ================= Ansicht: Belege =================
const entryAmount = (e) => (e.type === 'ausgabe' ? e.amount * (e.anteil ?? 100) / 100 : e.amount);

function vBelege() {
  const y = S.year;
  const list = S.entries
    .filter((e) => e.date.startsWith(y + '-') && (S.filter === 'alle' || e.bereich === S.filter))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));
  const aus = list.filter((e) => e.type === 'ausgabe').reduce((s, e) => s + entryAmount(e), 0);
  const ein = list.filter((e) => e.type === 'einnahme').reduce((s, e) => s + e.amount, 0);

  let groups = '', cur = '';
  for (const e of list) {
    const m = e.date.slice(0, 7);
    if (m !== cur) {
      if (cur) groups += '</ul>';
      cur = m;
      groups += `<p class="month-label">${MONTHS[+m.slice(5) - 1]}</p><ul class="list">`;
    }
    const d = parseIso(e.date);
    const a = entryAmount(e);
    groups += `<li><button class="row" data-act="entry" data-id="${e.id}">
      <span class="day-badge">${d.getDate()}<small>${WD[d.getDay()]}</small></span>
      <span class="grow"><span class="t">${esc(e.text || e.kategorie)}</span><span class="s"><span class="tag ${e.bereich}">${BEREICH[e.bereich]}</span> ${esc(e.kategorie)}${e.type === 'ausgabe' && (e.anteil ?? 100) < 100 ? ` · ${e.anteil} %` : ''}</span></span>
      ${e.photo ? '<svg class="clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-label="Beleg vorhanden"><path d="M20 11.5l-8.2 8.2a5 5 0 01-7-7L13 4.4a3.3 3.3 0 014.7 4.7l-8.2 8.2a1.7 1.7 0 01-2.4-2.4l7.6-7.6"/></svg>' : ''}
      <span class="amt ${e.type === 'ausgabe' ? 'neg' : 'pos'}">${e.type === 'ausgabe' ? '−' : '+'}${dec(a)}</span>
    </button></li>`;
  }
  if (cur) groups += '</ul>';

  return `
    <section class="card">
      <div class="nav-period">
        <button class="icon-btn" data-act="year" data-d="-1" aria-label="Vorheriges Jahr">‹</button>
        <span class="label">${y}</span>
        <button class="icon-btn" data-act="year" data-d="1" aria-label="Nächstes Jahr">›</button>
      </div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn primary" data-act="newEntry" data-type="ausgabe">+ Ausgabe</button>
        <button class="btn" data-act="newEntry" data-type="einnahme">+ Einnahme</button>
      </div>
      <div class="chips" style="margin-top:14px">
        ${[['alle', 'Alle'], ['ausbildung', 'Ausbildung'], ['gewerbe', 'Gewerbe']].map(([k, v]) => `<button class="chip plain" data-act="filter" data-f="${k}" aria-pressed="${pressed(S.filter === k)}" style="--c:var(--ink)">${v}</button>`).join('')}
      </div>
      <div class="stats">
        <div class="stat"><b>${list.length}</b><span>Einträge</span></div>
        <div class="stat"><b class="amt neg">${dec(aus)}</b><span>€ Ausgaben</span></div>
        <div class="stat"><b class="amt pos">${dec(ein)}</b><span>€ Einnahmen</span></div>
      </div>
    </section>
    <section class="card">
      ${list.length ? groups : `<div class="empty"><p class="big">Noch nichts für ${y}</p><p class="muted">Kassenbon fotografieren, Betrag eintippen, fertig.</p></div>`}
    </section>`;
}

function compressImage(file, max = 2000, q = 0.8) {
  return new Promise((res) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const s = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => res(b && b.size < file.size ? b : file), 'image/jpeg', q);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}
const photoBlob = (ph) => (ph ? new Blob([ph.data], { type: ph.type }) : null);

function entrySheet(id, type) {
  const ex = id ? S.entries.find((e) => e.id === id) : null;
  const e = ex ? { ...ex } : {
    id: uid(), type: type || 'ausgabe', date: iso(new Date()), amount: NaN, text: '',
    bereich: type === 'einnahme' ? 'gewerbe' : (S.filter !== 'alle' ? S.filter : 'ausbildung'),
    kategorie: '', anteil: 100, photo: null, created: Date.now(),
  };
  let photo = e.photo;
  let busy = false;

  const p = openSheet(`
    <div class="sheet-head"><div>
      <p class="eyebrow">${ex ? 'Eintrag bearbeiten' : 'Neuer Eintrag'}</p>
      <h2 id="eTitle"></h2>
    </div></div>
    <div class="field"><div class="seg" id="eType"><button type="button" data-v="ausgabe">Ausgabe</button><button type="button" data-v="einnahme">Einnahme</button></div></div>
    <label class="field"><span class="lbl">Betrag (brutto, €)</span><input id="eAmount" class="amount-input" inputmode="decimal" placeholder="0,00" value="${Number.isFinite(e.amount) ? dec(e.amount) : ''}"></label>
    <div class="two">
      <label class="field"><span class="lbl">Datum</span><input type="date" id="eDate" value="${e.date}"></label>
      <label class="field" id="eAnteilWrap"><span class="lbl">Beruflich %</span><input id="eAnteil" inputmode="numeric" value="${e.anteil ?? 100}"></label>
    </div>
    <div class="field" id="eBereichWrap"><span class="lbl">Bereich</span>
      <div class="seg" id="eBereich">${Object.entries(BEREICH).map(([k, v]) => `<button type="button" data-v="${k}">${v}</button>`).join('')}</div>
    </div>
    <label class="field"><span class="lbl">Kategorie</span><select id="eKat"></select></label>
    <label class="field"><span class="lbl">Beschreibung</span><input id="eText" value="${esc(e.text)}" placeholder="z. B. Tabellenbuch Metall" autocomplete="off"></label>
    <div class="field"><span class="lbl">Beleg</span>
      <div class="photo-box" id="ePhotoBox"></div>
      <input type="file" id="eFile" accept="image/*,application/pdf" hidden>
    </div>
    <div class="row-btns">
      ${ex ? '<button class="btn danger" id="eDel">Löschen</button>' : '<button class="btn ghost" data-act="closeSheet">Abbrechen</button>'}
      <button class="btn primary" id="eSave">Speichern</button>
    </div>`);

  const renderPhoto = () => {
    const box = $('#ePhotoBox', p);
    if (!photo) {
      box.innerHTML = '<button type="button" class="btn sm" id="ePick">Foto aufnehmen / Datei wählen</button><span class="small muted">optional</span>';
      return;
    }
    const blob = photoBlob(photo);
    let thumb;
    if (photo.type === 'application/pdf') thumb = '<span class="pdf" id="eView">PDF</span>';
    else { const u = URL.createObjectURL(blob); sheetUrls.push(u); thumb = `<img src="${u}" alt="Beleg" id="eView">`; }
    box.innerHTML = `${thumb}<div class="stack" style="flex:1"><button type="button" class="btn sm" id="ePick">Ersetzen</button><button type="button" class="btn sm danger" id="eRm">Entfernen</button></div>`;
  };

  const sync = () => {
    $('#eTitle', p).textContent = e.type === 'ausgabe' ? 'Ausgabe' : 'Einnahme';
    $$('#eType button', p).forEach((b) => b.setAttribute('aria-pressed', pressed(e.type === b.dataset.v)));
    $$('#eBereich button', p).forEach((b) => b.setAttribute('aria-pressed', pressed(e.bereich === b.dataset.v)));
    $('#eAnteilWrap', p).style.visibility = e.type === 'ausgabe' ? 'visible' : 'hidden';
    $('#eBereichWrap', p).style.display = e.type === 'ausgabe' ? '' : 'none';
    const kats = e.type === 'ausgabe' ? AUSGABE_KAT : EINNAHME_KAT;
    const sel = $('#eKat', p);
    const keep = kats.includes(e.kategorie) ? e.kategorie : kats[0];
    sel.innerHTML = kats.map((k) => `<option ${k === keep ? 'selected' : ''}>${esc(k)}</option>`).join('');
    e.kategorie = keep;
  };
  sync();
  renderPhoto();
  $('#eKat', p).addEventListener('change', (ev) => { e.kategorie = ev.target.value; });
  if (!ex) setTimeout(() => $('#eAmount', p).focus(), 320);

  $('#eFile', p).addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    busy = true;
    $('#ePhotoBox', p).innerHTML = '<span class="small muted">Foto wird verarbeitet …</span>';
    try {
      const blob = f.type.startsWith('image/') ? await compressImage(f) : f;
      photo = { type: blob.type || f.type, name: f.name, data: await blob.arrayBuffer() };
    } finally {
      busy = false;
      renderPhoto();
      ev.target.value = '';
    }
  });

  p.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button, img, .pdf');
    if (!b) return;
    if (b.parentElement?.id === 'eType') { e.type = b.dataset.v; if (e.type === 'einnahme') e.bereich = 'gewerbe'; sync(); }
    if (b.parentElement?.id === 'eBereich') { e.bereich = b.dataset.v; sync(); }
    if (b.id === 'ePick') $('#eFile', p).click();
    if (b.id === 'eRm') { photo = null; renderPhoto(); }
    if (b.id === 'eView') showImage(photoBlob(photo));
    if (b.id === 'eSave') {
      if (busy) { toast('Foto wird noch verarbeitet, kurz warten.'); return; }
      const amount = parseNum($('#eAmount', p).value);
      if (!Number.isFinite(amount) || amount <= 0) { toast('Bitte Betrag eingeben.'); return; }
      const date = $('#eDate', p).value;
      if (!date) { toast('Bitte Datum wählen.'); return; }
      let anteil = Math.round(parseNum($('#eAnteil', p).value));
      if (!Number.isFinite(anteil)) anteil = 100;
      anteil = Math.min(100, Math.max(0, anteil));
      Object.assign(e, { amount: round2(amount), date, anteil: e.type === 'ausgabe' ? anteil : 100, text: $('#eText', p).value.trim(), kategorie: $('#eKat', p).value, photo });
      await idb.put('entries', e);
      const i = S.entries.findIndex((x) => x.id === e.id);
      if (i >= 0) S.entries[i] = e; else S.entries.push(e);
      askPersist();
      S.year = +date.slice(0, 4);
      closeSheet(); render();
      toast('Gespeichert');
    }
    if (b.id === 'eDel') {
      if (!confirm('Eintrag wirklich löschen?')) return;
      await idb.del('entries', e.id);
      S.entries = S.entries.filter((x) => x.id !== e.id);
      closeSheet(); render();
    }
  });
}

// ================= Ansicht: Übersicht =================
function yearStats(y) {
  const mk = () => ({ pendel: 0, pendelTage: 0, reise: 0, reiseKm: 0, aus: {}, ausSum: 0, ein: {}, einSum: 0 });
  const r = { ausbildung: mk(), gewerbe: mk() };
  const perPlace = {};
  for (const rec of S.days.values()) {
    if (!rec.date.startsWith(y + '-')) continue;
    for (const c of dayCalc(rec)) {
      const b = r[c.p.bereich] || r.ausbildung;
      if (c.art === 'pendel') { b.pendel += c.betrag; b.pendelTage++; } else { b.reise += c.betrag; b.reiseKm += c.km; }
      const pp = (perPlace[c.p.id] ||= { p: c.p, tage: 0, betrag: 0 });
      pp.tage++; pp.betrag += c.betrag;
    }
  }
  for (const e of S.entries) {
    if (!e.date.startsWith(y + '-')) continue;
    const b = r[e.bereich] || r.gewerbe;
    const a = entryAmount(e);
    if (e.type === 'ausgabe') { b.aus[e.kategorie] = (b.aus[e.kategorie] || 0) + a; b.ausSum += a; }
    else { b.ein[e.kategorie] = (b.ein[e.kategorie] || 0) + a; b.einSum += a; }
  }
  return { ...r, perPlace };
}

function vUebersicht() {
  const y = S.year;
  const st = yearStats(y);
  const A = st.ausbildung, G = st.gewerbe;
  const aTotal = A.pendel + A.reise + A.ausSum;
  const gAus = G.pendel + G.reise + G.ausSum;
  const gGewinn = G.einSum - gAus;
  const rows = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr class="sub"><td>${esc(k)}</td><td>${dec(v)}</td></tr>`).join('');
  const places = Object.values(st.perPlace).filter((x) => x.p.bereich);

  const hasData = S.entries.length || S.days.size;
  const last = S.cfg.lastBackup ? new Date(S.cfg.lastBackup) : null;
  const stale = hasData && (!last || Date.now() - last.getTime() > 30 * 864e5);

  return `
    ${stale ? `<div class="banner"><span>Letztes Backup: ${last ? last.toLocaleDateString('de-DE') : 'noch nie'}</span><button class="btn sm" data-act="backup">Jetzt sichern</button></div>` : ''}
    <section class="card">
      <div class="nav-period" style="margin:0">
        <button class="icon-btn" data-act="year" data-d="-1" aria-label="Vorheriges Jahr">‹</button>
        <span class="label">Steuerjahr ${y}</span>
        <button class="icon-btn" data-act="year" data-d="1" aria-label="Nächstes Jahr">›</button>
      </div>
    </section>

    <section class="card section-aus">
      <p class="eyebrow">Ausbildung · Anlage N</p>
      <h2>Werbungskosten</h2>
      <table class="ledger">
        <tr><td>Wege zur Arbeitsstätte<small>Entfernungspauschale, ${A.pendelTage} Tage</small></td><td>${dec(A.pendel)}</td></tr>
        <tr><td>Reisekosten Fahrten<small>z. B. Berufsschule, ${dec(A.reiseKm, 0)} km</small></td><td>${dec(A.reise)}</td></tr>
        <tr><td>Ausgaben</td><td>${dec(A.ausSum)}</td></tr>
        ${rows(A.aus)}
        <tr class="total"><td>Summe</td><td>${dec(aTotal)} €</td></tr>
      </table>
      <p class="hint">Das Finanzamt zieht automatisch 1.230 € Arbeitnehmer-Pauschbetrag ab. Alles darüber senkt deine Steuer zusätzlich${aTotal > 1230 ? `, bei dir ${eur(aTotal - 1230)}.` : '. Du liegst noch darunter.'}</p>
    </section>

    <section class="card section-gew">
      <p class="eyebrow">Gewerbe · Anlage EÜR</p>
      <h2>Einnahmen-Überschuss</h2>
      <table class="ledger">
        <tr><td>Einnahmen</td><td>${dec(G.einSum)}</td></tr>
        ${rows(G.ein)}
        <tr><td>Betriebsausgaben</td><td>−${dec(G.ausSum)}</td></tr>
        ${rows(G.aus)}
        <tr><td>Fahrtkosten<small>${G.pendelTage ? `Pauschale ${G.pendelTage} Tage, ` : ''}${dec(G.reiseKm, 0)} km à 0,30 €</small></td><td>−${dec(G.pendel + G.reise)}</td></tr>
        <tr class="total"><td>${gGewinn >= 0 ? 'Gewinn' : 'Verlust'}</td><td>${dec(gGewinn)} €</td></tr>
      </table>
      <p class="hint">Vereinfachte Rechnung auf Basis der Bruttobeträge (Kleinunternehmer). Mit Umsatzsteuer bitte netto erfassen oder mit Steuerberater abstimmen.</p>
    </section>

    ${places.length ? `<section class="card">
      <p class="eyebrow">Fahrten nach Ort</p>
      <ul class="list">${places.map((x) => `<li><div class="row"><span class="swatch" style="background:${x.p.color}"></span><span class="grow"><span class="t">${esc(x.p.name)}</span><span class="s">${x.tage} Tage · ${esc(placeMeta(x.p))}</span></span><span class="amt">${dec(x.betrag)}</span></div></li>`).join('')}</ul>
    </section>` : ''}

    <section class="card">
      <p class="eyebrow">Für die Steuererklärung</p>
      <div class="stack" style="margin-top:8px">
        <button class="btn" data-act="exportFahrten">Fahrten ${y} als CSV</button>
        <button class="btn" data-act="exportBelege">Belege ${y} als CSV</button>
        <button class="btn" data-act="exportFotos">Belegfotos ${y} exportieren</button>
      </div>
      <p class="hint">Keine Steuerberatung. Die Werte sind Hilfsrechnungen nach den üblichen Pauschalen, bitte vor dem Eintragen in ELSTER kurz prüfen.</p>
    </section>`;
}

// ================= Ansicht: Mehr =================
function vMehr() {
  const last = S.cfg.lastBackup ? new Date(S.cfg.lastBackup).toLocaleString('de-DE') : 'noch nie';
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return `
    <section class="card">
      <p class="eyebrow">Orte & Wochenplan</p>
      <ul class="list">
        ${S.places.map((p) => `<li><button class="row" data-act="place" data-id="${p.id}"><span class="swatch" style="background:${p.color}"></span><span class="grow"><span class="t">${esc(p.name)} <span class="tag ${p.bereich}">${BEREICH[p.bereich]}</span></span><span class="s">${esc(placeMeta(p))}</span></span><span class="muted">›</span></button></li>`).join('') || '<li class="muted" style="padding:8px 0">Noch keine Orte.</li>'}
      </ul>
      <div class="btn-row"><button class="btn ghost" data-act="place">+ Ort hinzufügen</button></div>
    </section>

    <section class="card">
      <p class="eyebrow">Datensicherung</p>
      <h2>Backup</h2>
      <p class="muted small">Deine Daten liegen nur auf diesem Gerät. Sichere regelmäßig eine Backup-Datei (z. B. in iCloud Drive über „In Dateien sichern“). Letztes Backup: <b>${esc(last)}</b></p>
      <div class="stack" style="margin-top:10px">
        <button class="btn primary" data-act="backup">Backup speichern (inkl. Fotos)</button>
        <button class="btn" data-act="restore">Backup laden</button>
      </div>
    </section>

    <section class="card">
      <p class="eyebrow">Export ${S.year}</p>
      <div class="stack" style="margin-top:8px">
        <button class="btn" data-act="exportFahrten">Fahrten als CSV</button>
        <button class="btn" data-act="exportBelege">Belege als CSV</button>
        <button class="btn" data-act="exportFotos">Belegfotos exportieren</button>
      </div>
      <p class="explain">Jahr wechselst du unter „Belege“ oder „Übersicht“. CSV öffnet sich in Excel und Numbers.</p>
    </section>

    ${standalone ? '' : `<section class="card">
      <p class="eyebrow">Auf dem iPhone installieren</p>
      <ol class="small" style="margin:8px 0 0;padding-left:20px">
        <li>Diese Seite in <b>Safari</b> öffnen</li>
        <li>Teilen-Symbol (Quadrat mit Pfeil) antippen</li>
        <li><b>„Zum Home-Bildschirm“</b> wählen</li>
      </ol>
      <p class="explain">Danach startet SteuerFinn wie eine App und funktioniert offline.</p>
    </section>`}

    <section class="card">
      <p class="eyebrow">Gefahrenzone</p>
      <button class="btn danger block" data-act="wipe" style="margin-top:8px">Alle Daten löschen</button>
      <p class="explain">SteuerFinn · Daten nur lokal · keine Steuerberatung</p>
    </section>`;
}

// ================= Export / Backup =================
async function deliver(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return true; }
    catch (err) { if (err.name === 'AbortError') return false; }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  return true;
}
const csvCell = (v) => { const s = String(v ?? ''); return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvFile = (name, rows) => new File(['﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n')], name, { type: 'text/csv' });
const deDate = (ds) => ds.split('-').reverse().join('.');

function exportFahrten() {
  const y = S.year;
  const rows = [['Datum', 'Wochentag', 'Ort', 'Bereich', 'Art', 'Entfernung einfach (km)', 'Berechnungs-km', 'Betrag (€)', 'Notiz']];
  const recs = [...S.days.values()].filter((d) => d.date.startsWith(y + '-')).sort((a, b) => a.date.localeCompare(b.date));
  let sum = 0;
  for (const rec of recs) {
    const wd = WD_LONG[parseIso(rec.date).getDay()];
    if (rec.status) { rows.push([deDate(rec.date), wd, '', '', STATUS[rec.status], '', '', '', rec.note || '']); continue; }
    for (const c of dayCalc(rec)) {
      sum += c.betrag;
      rows.push([deDate(rec.date), wd, c.p.name, BEREICH[c.p.bereich], c.art === 'pendel' ? 'Entfernungspauschale' : 'Reisekosten 0,30 €/km', dec(c.p.km, 1), dec(c.km, 1), dec(c.betrag), rec.note || '']);
    }
  }
  if (rows.length === 1) { toast(`Keine Fahrten in ${y}.`); return; }
  rows.push([], ['Summe', '', '', '', '', '', '', dec(sum), '']);
  deliver([csvFile(`SteuerFinn_Fahrten_${y}.csv`, rows)]);
}

function photoName(e, i) {
  const ext = e.photo.type === 'application/pdf' ? 'pdf' : e.photo.type === 'image/png' ? 'png' : 'jpg';
  const slug = (e.text || e.kategorie).normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return `${e.date}_${pad(i + 1)}_${slug || 'Beleg'}_${dec(e.amount).replace(/\./g, '')}.${ext}`;
}

function exportBelege() {
  const y = S.year;
  const list = S.entries.filter((e) => e.date.startsWith(y + '-')).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) { toast(`Keine Belege in ${y}.`); return; }
  const rows = [['Datum', 'Typ', 'Bereich', 'Kategorie', 'Beschreibung', 'Betrag brutto (€)', 'Beruflich %', 'Absetzbar / Einnahme (€)', 'Belegdatei']];
  list.forEach((e, i) => rows.push([
    deDate(e.date), e.type === 'ausgabe' ? 'Ausgabe' : 'Einnahme', BEREICH[e.bereich], e.kategorie, e.text,
    dec(e.amount), e.type === 'ausgabe' ? e.anteil ?? 100 : '', dec(entryAmount(e)), e.photo ? photoName(e, i) : '',
  ]));
  deliver([csvFile(`SteuerFinn_Belege_${y}.csv`, rows)]);
}

function exportFotos() {
  const y = S.year;
  const list = S.entries.filter((e) => e.date.startsWith(y + '-')).sort((a, b) => a.date.localeCompare(b.date));
  const files = [];
  list.forEach((e, i) => { if (e.photo) files.push(new File([e.photo.data], photoName(e, i), { type: e.photo.type })); });
  if (!files.length) { toast(`Keine Belegfotos in ${y}.`); return; }
  deliver(files);
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

async function backup() {
  const data = {
    app: 'SteuerFinn', version: 1, exported: new Date().toISOString(),
    places: S.places,
    days: [...S.days.values()],
    entries: S.entries.map((e) => ({ ...e, photo: e.photo ? { type: e.photo.type, name: e.photo.name, b64: bufToB64(e.photo.data) } : null })),
  };
  const stamp = iso(new Date());
  const file = new File([JSON.stringify(data)], `SteuerFinn_Backup_${stamp}.json`, { type: 'application/json' });
  const ok = await deliver([file]);
  if (ok) { await saveCfg({ lastBackup: Date.now() }); render(); toast('Backup erstellt'); }
}

function restore() { $('#restoreInput').click(); }
$('#restoreInput').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'SteuerFinn') throw new Error('Keine SteuerFinn-Datei');
    const n = (data.entries || []).length, d = (data.days || []).length;
    if (!confirm(`Backup vom ${new Date(data.exported).toLocaleString('de-DE')} laden?\n${(data.places || []).length} Orte, ${d} Tage, ${n} Belege.\n\nDie aktuellen Daten auf diesem Gerät werden ERSETZT.`)) return;
    const entries = (data.entries || []).map((e) => ({ ...e, photo: e.photo ? { type: e.photo.type, name: e.photo.name, data: b64ToBuf(e.photo.b64) } : null }));
    const cfg = { ...S.cfg };
    await idb.clearAll();
    await idb.putMany('places', data.places || []);
    await idb.putMany('days', data.days || []);
    await idb.putMany('entries', entries);
    await idb.put('settings', cfg, 'cfg');
    await load();
    render();
    toast('Backup geladen');
  } catch (err) {
    alert('Backup konnte nicht geladen werden: ' + err.message);
  }
});

async function wipe() {
  if (!confirm('Wirklich ALLE Orte, Fahrten und Belege auf diesem Gerät löschen?')) return;
  if (!confirm('Letzte Warnung: Ohne Backup ist alles weg. Fortfahren?')) return;
  await idb.clearAll();
  await load();
  render();
  toast('Alles gelöscht');
}

// ================= Events =================
const ACT = {
  tab: (el) => { S.view = el.dataset.view; render(); window.scrollTo(0, 0); },
  month: (el) => { S.month = new Date(S.month.getFullYear(), S.month.getMonth() + +el.dataset.d, 1); S.year = S.month.getFullYear(); render(); },
  year: (el) => { S.year += +el.dataset.d; S.month = new Date(S.year, S.month.getMonth(), 1); render(); },
  day: (el) => daySheet(el.dataset.date),
  fillPlan, range: rangeSheet,
  place: (el) => placeSheet(el.dataset.id),
  entry: (el) => entrySheet(el.dataset.id),
  newEntry: (el) => entrySheet(null, el.dataset.type),
  filter: (el) => { S.filter = el.dataset.f; render(); },
  exportFahrten, exportBelege, exportFotos, backup, restore, wipe, closeSheet,
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#sheet').classList.contains('open')) closeSheet(); });

// ================= Start =================
(async () => {
  try {
    await load();
  } catch (err) {
    $('#main').innerHTML = `<section class="card"><h2>Speicher nicht verfügbar</h2><p class="muted">${esc(err?.message || err)}. Im privaten Modus funktioniert SteuerFinn nicht.</p></section>`;
    return;
  }
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
