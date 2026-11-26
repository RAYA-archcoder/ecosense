// EcoSense Duo — MySQL (PHP API) немесе Firebase-тен деректерді оқып, көрсетеді.
// Деректер құрылымы (ESP32 осылай жазады):
//   devices/smokeoff/latest            { co2, temp, hum, place, ts }
//   devices/smokeoff/history/<pushId>  { co2, temp, hum, place, ts }
//   devices/aquascan/latest            { turbidity, ph, wtemp, place, ts }
//   devices/aquascan/history/<pushId>  { turbidity, ph, wtemp, place, ts }
// ts — миллисекундпен уақыт (Firebase server timestamp).

const CFG = window.ECOSENSE_CONFIG;
const T = CFG.thresholds;
const DAY = 864e5, WEEK = 7 * DAY;

let LANG = (() => { try { const s = localStorage.getItem('eco-lang'); if (s && I18N.langs[s]) return s; } catch (e) {} return 'kk'; })();
const S = (k, v = {}) => { let s = (I18N.str[LANG] || {})[k]; if (s == null) s = I18N.str.kk[k]; return typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '') : s; };
const DEVICES = {
  smokeoff: { name: 'Smoke Off', metrics: {
    co2:  { lk: 'm_co2', label: 'CO₂', unit: 'ppm', color: '#22d3ee', digits: 0 },
    temp: { lk: 'm_temp', label: 'Температура', unit: '°C', color: '#f59e0b', digits: 1 },
    hum:  { lk: 'm_hum', label: 'Ылғалдылық', unit: '%', color: '#a78bfa', digits: 0 } } },
  aquascan: { name: 'AquaScan', metrics: {
    turbidity: { lk: 'm_turbidity', label: 'Лайлылық', unit: 'NTU', color: '#38bdf8', digits: 0 },
    ph:        { lk: 'm_ph', label: 'pH', unit: '', color: '#10b981', digits: 2 },
    wtemp:     { lk: 'm_wtemp', label: 'Су температурасы', unit: '°C', color: '#fb923c', digits: 1 } } }
};

// ---------- норма деңгейлері ----------
const level = {
  co2: v => v <= T.co2.good ? 'g' : v <= T.co2.warn ? 'y' : 'r',
  turbidity: v => v <= T.turbidity.good ? 'g' : v <= T.turbidity.warn ? 'y' : 'r',
  ph: v => (v >= T.ph.min && v <= T.ph.max) ? 'g' : (v >= T.ph.warnMin && v <= T.ph.warnMax) ? 'y' : 'r'
};
const rank = { g: 0, y: 1, r: 2 };
function deviceLevel(dev, d) {
  const ls = dev === 'smokeoff' ? [level.co2(d.co2)] : [level.turbidity(d.turbidity), level.ph(d.ph)];
  return ls.reduce((a, b) => rank[b] > rank[a] ? b : a, 'g');
}
const LVL_TXT = new Proxy({}, { get: (_, k) => S('lv_' + k) });
const STATE_TXT = new Proxy({}, { get: (_, k) => S('st_' + k) });

// ---------- көмекшілер ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const fDate = ts => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
const fTime = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fShort = ts => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const num = (v, k) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(k);


// ---------- күй ----------
const hist = { smokeoff: [], aquascan: [] };
const latest = { smokeoff: null, aquascan: null };
const range = { smokeoff: 24, aquascan: 24 };
let tableDev = 'smokeoff';
let dirty = true;

// ---------- Chart.js ----------
Chart.defaults.color = '#8a9bb5';
Chart.defaults.borderColor = '#1e2a40';
Chart.defaults.font.family = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
const charts = {};
function lineChart(id, color, opts = {}) {
  return new Chart(document.getElementById(id), {
    type: 'line',
    data: { datasets: [{ data: [], borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 0, borderWidth: 2, tension: .3 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => fShort(it[0].parsed.x) } } },
      scales: {
        x: { type: 'linear', display: !opts.spark, ticks: { maxTicksLimit: 7, callback: v => fShort(v) }, grid: { display: false } },
        y: { display: !opts.spark, grace: '5%' }
      }
    }
  });
}
function barChart(id, sets) {
  return new Chart(document.getElementById(id), {
    type: 'bar',
    data: { labels: [], datasets: sets.map(s => ({ lk: s.lk, label: S(s.lk), data: [], backgroundColor: s.color, borderRadius: 4, type: s.type || 'bar', borderColor: s.color, pointRadius: 3, tension: .3 })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: false, grace: '5%' } } }
  });
}

function initCharts() {
  charts['spark-smokeoff'] = lineChart('spark-smokeoff', '#22d3ee', { spark: true });
  charts['spark-aquascan'] = lineChart('spark-aquascan', '#38bdf8', { spark: true });
  for (const [dev, D] of Object.entries(DEVICES))
    for (const [m, M] of Object.entries(D.metrics)) charts[`${dev}-${m}`] = lineChart(`ch-${dev}-${m}`, M.color);
  charts.wkCo2 = barChart('wk-co2', [{ lk: 'avg', color: '#22d3ee' }, { lk: 'max', color: '#ef4444aa' }]);
  charts.wkTurb = barChart('wk-turbidity', [{ lk: 'avg', color: '#38bdf8' }, { lk: 'max', color: '#ef4444aa' }]);
  charts.wkPh = barChart('wk-ph', [{ lk: 'ph_avg', color: '#10b981' }]);
  charts.wkTemp = barChart('wk-temp', [{ lk: 't_air', color: '#f59e0b', type: 'line' }, { lk: 't_water', color: '#fb923c88' }]);
}

// Көп нүктені сиретеді (браузер баяуламас үшін)
function downsample(rows, key, maxPts = 500) {
  const pts = rows.filter(r => r[key] != null).map(r => ({ x: r.ts, y: +r[key] }));
  if (pts.length <= maxPts) return pts;
  const step = Math.ceil(pts.length / maxPts), out = [];
  for (let i = 0; i < pts.length; i += step) {
    const ch = pts.slice(i, i + step);
    out.push({ x: ch[Math.floor(ch.length / 2)].x, y: ch.reduce((s, p) => s + p.y, 0) / ch.length });
  }
  return out;
}

// ---------- сызу ----------
function subScores(dev, d) {
  if (!d) return null;
  const c = (x) => Math.max(0, Math.min(100, x));
  if (dev === 'smokeoff') return c(100 - (d.co2 - 400) / 16);
  const t = c(100 - d.turbidity / 3);
  const p = c(100 - Math.max(0, Math.abs(d.ph - 7.25) - 0.25) * 40);
  return Math.min(t, p);
}
function renderLive() {
  const scores = [];
  for (const dev of Object.keys(DEVICES)) {
    const d = latest[dev] || hist[dev][hist[dev].length - 1];
    $$(`[data-place="${dev}"]`).forEach(e => e.textContent = (d && d.place) || CFG.places[dev]);
    if (!d) continue;
    for (const [m, M] of Object.entries(DEVICES[dev].metrics)) {
      $$(`[data-v="${dev}.${m}"]`).forEach(el => { el.textContent = num(d[m], M.digits); el.className = level[m] && d[m] != null ? level[m](d[m]) : ''; });
    }
    const off = Date.now() - d.ts > CFG.offlineAfterMin * 60e3;
    const lv = deviceLevel(dev, d);
    $(`[data-light="${dev}"]`).className = 'light ' + (off ? '' : lv);
    const st = $(`[data-state="${dev}"]`);
    st.textContent = off ? STATE_TXT.off + ' · ' + S('st_last') + ': ' + STATE_TXT[lv] : STATE_TXT[lv];
    st.className = 'state ' + (off ? 'off' : lv);
    $(`[data-time="${dev}"]`).textContent = `${fDate(d.ts)} · ${fTime(d.ts)}`;
    const sc = subScores(dev, d); scores.push(sc);
    const g = $(`[data-gauge="${dev}"]`); if (g) g.style.left = (100 - sc) + '%';
  }
  const hero = $('[data-hero="aqi"]');
  if (hero && scores.length) {
    const a = Math.round(scores.reduce((x, y) => x + y, 0) / scores.length);
    hero.textContent = a;
    hero.style.color = a >= 70 ? 'var(--mint)' : a >= 45 ? 'var(--yellow)' : 'var(--red)';
  }
  renderTicker();
}
let tickerKey = '';
function renderTicker() {
  const s = latest.smokeoff, a = latest.aquascan;
  const items = [];
  if (s) items.push(`🌫 <b>Smoke Off</b> · ${s.place || CFG.places.smokeoff}: CO₂ <b>${num(s.co2, 0)} ppm</b>, ${num(s.temp, 1)} °C, ${S('tk_hum')} ${num(s.hum, 0)}%`);
  if (a) items.push(`💧 <b>AquaScan</b> · ${a.place || CFG.places.aquascan}: ${S('tk_s')} <b>${num(a.turbidity, 0)} NTU</b>, pH <b>${num(a.ph, 2)}</b>, ${S('tk_water')} ${num(a.wtemp, 1)} °C`);
  items.push(S('tk_flow'));
  items.push(S('tk_quote'));
  const key = items.join('|'); if (key === tickerKey) return; tickerKey = key;
  const html = items.map(t => `<span>${t}</span>`).join('');
  $('#ticker').innerHTML = html + html;
}

function renderCharts() {
  const now = Date.now();
  const sp = { smokeoff: 'co2', aquascan: 'turbidity' };
  for (const dev of Object.keys(DEVICES)) {
    const c = charts['spark-' + dev];
    c.data.datasets[0].data = downsample(hist[dev].filter(r => r.ts >= now - 6 * 36e5), sp[dev], 150);
    c.update();
    const rows = hist[dev].filter(r => r.ts >= now - range[dev] * 36e5);
    for (const m of Object.keys(DEVICES[dev].metrics)) {
      const ch = charts[`${dev}-${m}`];
      ch.data.datasets[0].data = downsample(rows, m);
      ch.options.scales.x.min = now - range[dev] * 36e5; ch.options.scales.x.max = now;
      ch.update();
    }
  }
}

function stats(rows, key) {
  const v = rows.map(r => r[key]).filter(x => x != null && !isNaN(x)).map(Number);
  if (!v.length) return null;
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), n: v.length };
}

function ring(sel, p, col) { const c = $(sel); c.style.strokeDasharray = `${p || 0} 100`; c.style.stroke = col || 'var(--mint)'; }
function renderWeekly() {
  const now = Date.now();
  const start = new Date(now - 6 * DAY); start.setHours(0, 0, 0, 0);
  const days = [...Array(7)].map((_, i) => { const d = new Date(start.getTime() + i * DAY); return d; });
  const labels = days.map(d => `${S('days')[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`);
  const byDay = dev => days.map(d => hist[dev].filter(r => r.ts >= d.getTime() && r.ts < d.getTime() + DAY));
  const air = byDay('smokeoff'), water = byDay('aquascan');
  const day = (groups, key, f) => groups.map(g => { const s = stats(g, key); return s ? +s[f].toFixed(2) : null; });

  $('#weekRange').textContent = `${fDate(start.getTime())} — ${fDate(now)}`;
  const set = (c, data) => { c.data.labels = labels; c.data.datasets.forEach(ds => ds.lk && (ds.label = S(ds.lk))); data.forEach((d, i) => c.data.datasets[i].data = d); c.update(); };
  set(charts.wkCo2, [day(air, 'co2', 'avg'), day(air, 'co2', 'max')]);
  set(charts.wkTurb, [day(water, 'turbidity', 'avg'), day(water, 'turbidity', 'max')]);
  set(charts.wkPh, [day(water, 'ph', 'avg')]);
  set(charts.wkTemp, [day(air, 'temp', 'avg'), day(water, 'wtemp', 'avg')]);

  const wa = hist.smokeoff.filter(r => r.ts >= now - WEEK), ww = hist.aquascan.filter(r => r.ts >= now - WEEK);
  const pct = (rows, dev) => rows.length ? Math.round(100 * rows.filter(r => deviceLevel(dev, r) === 'g').length / rows.length) : null;
  const pa = pct(wa, 'smokeoff'), pw = pct(ww, 'aquascan');
  const colorOf = p => p == null ? '' : p >= 80 ? 'var(--green)' : p >= 50 ? 'var(--yellow)' : 'var(--red)';
  $('#scoreAir').textContent = pa == null ? '—' : pa + '%'; ring('#ringAir', pa, colorOf(pa));
  $('#scoreWater').textContent = pw == null ? '—' : pw + '%'; ring('#ringWater', pw, colorOf(pw));
  $('#countAll').textContent = (wa.length + ww.length).toLocaleString('ru-RU');
  $('#countSplit').textContent = S('split', { a: wa.length, w: ww.length });

  // кесте + үрдіс
  const half = now - 3.5 * DAY;
  const rowsHtml = [], insights = [];
  for (const [dev, rows] of [['smokeoff', wa], ['aquascan', ww]]) {
    for (const [m, M] of Object.entries(DEVICES[dev].metrics)) {
      const s = stats(rows, m); if (!s) continue;
      const a1 = stats(rows.filter(r => r.ts < half), m), a2 = stats(rows.filter(r => r.ts >= half), m);
      let trend = '—';
      if (a1 && a2 && a1.avg) {
        const ch = (a2.avg - a1.avg) / Math.abs(a1.avg) * 100;
        trend = Math.abs(ch) < 3 ? S('stable') : (ch > 0 ? '↑ ' : '↓ ') + Math.abs(ch).toFixed(0) + '%';
      }
      const bad = level[m] ? rows.filter(r => r[m] != null && level[m](r[m]) !== 'g').length : null;
      const badTxt = bad == null ? '—' : `${bad} (${Math.round(100 * bad / s.n)}%)`;
      const cls = level[m] ? level[m](s.avg) : '';
      rowsHtml.push(`<tr><td>${DEVICES[dev].name} · ${S(M.lk)}${M.unit ? ', ' + M.unit : ''}</td><td class="${cls}">${num(s.avg, M.digits)}</td><td>${num(s.min, M.digits)}</td><td>${num(s.max, M.digits)}</td><td>${badTxt}</td><td>${trend}</td></tr>`);
    }
  }
  $('#statTable tbody').innerHTML = rowsHtml.join('') || `<tr><td colspan="6" class="muted">${S('no_week')}</td></tr>`;

  const sCo2 = stats(wa, 'co2'), sT = stats(ww, 'turbidity'), sPh = stats(ww, 'ph');
  if (sCo2) {
    const maxRow = wa.reduce((a, b) => (b.co2 > a.co2 ? b : a));
    insights.push(S('ins_co2', { avg: num(sCo2.avg, 0), lv: LVL_TXT[level.co2(sCo2.avg)], max: num(maxRow.co2, 0), date: fDate(maxRow.ts), time: fTime(maxRow.ts).slice(0, 5) }));
    const worstDay = air.map((g, i) => [stats(g, 'co2'), i]).filter(x => x[0]).sort((a, b) => b[0].avg - a[0].avg)[0];
    if (worstDay) insights.push(S('ins_worst', { day: labels[worstDay[1]], avg: num(worstDay[0].avg, 0) }));
  }
  if (sT) {
    const maxRow = ww.reduce((a, b) => (b.turbidity > a.turbidity ? b : a));
    insights.push(S('ins_turb', { avg: num(sT.avg, 0), lv: LVL_TXT[level.turbidity(sT.avg)], max: num(maxRow.turbidity, 0), date: fDate(maxRow.ts), time: fTime(maxRow.ts).slice(0, 5) }));
  }
  if (sPh) insights.push(S('ins_ph', { min: num(sPh.min, 2), max: num(sPh.max, 2), avg: num(sPh.avg, 2), nmin: T.ph.min, nmax: T.ph.max }));
  if (pa != null && pw != null) insights.push(S('ins_pct', { a: pa, w: pw }));
  $('#insights').innerHTML = insights.map(t => `<li>${t}</li>`).join('') || `<li class="muted">${S('no_ins')}</li>`;
}

function tableRows(dev) {
  const ms = Object.entries(DEVICES[dev].metrics);
  return { head: [S('col_date'), S('col_time'), S('col_place'), ...ms.map(([, M]) => S(M.lk) + (M.unit ? ', ' + M.unit : '')), S('col_state')],
    rows: hist[dev].slice().reverse().map(r => ({ r, cells: [fDate(r.ts), fTime(r.ts), r.place || CFG.places[dev], ...ms.map(([m, M]) => num(r[m], M.digits))] })), ms };
}
function renderTable() {
  const { head, rows, ms } = tableRows(tableDev);
  $('#dataTable thead').innerHTML = '<tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr>';
  $('#dataTable tbody').innerHTML = rows.slice(0, 1500).map(({ r, cells }) => {
    const lv = deviceLevel(tableDev, r);
    return '<tr>' + cells.map((c, i) => { const m = i >= 3 ? ms[i - 3][0] : null; const cl = m && level[m] && r[m] != null ? level[m](r[m]) : ''; return `<td class="${cl}">${c}</td>`; }).join('') + `<td class="${lv}">${STATE_TXT[lv]}</td></tr>`;
  }).join('') || `<tr><td colspan="${head.length}" class="muted">${S('no_data')}</td></tr>`;
}
function downloadCSV() {
  const { head, rows } = tableRows(tableDev);
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  const csv = '﻿' + [head, ...rows.map(x => x.cells)].map(r => r.map(esc).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `EcoSenseDuo_${tableDev}_${fDate(Date.now())}.csv`; a.click();
}

function renderAll() {
  renderLive();
  const active = $('.view.active').id;
  if (active === 'monitor' || active === 'charts') renderCharts();
  if (active === 'weekly') renderWeekly();
  if (active === 'table') renderTable();
  dirty = false;
}

// ---------- UI ----------
function route() {
  const tab = (location.hash.replace(/^#\/?/, '') || 'home');
  const id = document.getElementById(tab) && document.getElementById(tab).classList.contains('view') ? tab : 'home';
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === id));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  $('#nav').classList.remove('open');
  window.scrollTo({ top: 0 });
  observeReveal();
  renderAll();
}
window.addEventListener('hashchange', route);
$('#burger').onclick = () => $('#nav').classList.toggle('open');
$$('.range[data-dev]').forEach(g => g.onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('button', g).forEach(x => x.classList.toggle('active', x === b));
  range[g.dataset.dev] = +b.dataset.h; renderCharts();
});
$('#tableDev').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#tableDev button').forEach(x => x.classList.toggle('active', x === b));
  tableDev = b.dataset.d; renderTable();
};
$('#csv').onclick = downloadCSV;
setInterval(() => { const d = new Date(); $('#clock').textContent = `${fDate(d)} · ${fTime(d)}`; }, 1000);
setInterval(() => { if (dirty) renderAll(); else renderLive(); }, 2000);

function setMode(cls, txt) { const m = $('#mode'); const kk = Object.keys(I18N.str.kk).find(k => k.startsWith('mode_') && Object.values(I18N.str).some(d => d[k] === txt)); if (kk) m.dataset.k = kk; else delete m.dataset.k; m.className = 'pill ' + cls; m.textContent = txt; $('#foot-mode').textContent = txt; }

function addRow(dev, r) {
  if (!r || !r.ts) return;
  const a = hist[dev];
  if (!a.length || r.ts >= a[a.length - 1].ts) a.push(r);
  else { let i = a.findIndex(x => x.ts > r.ts); a.splice(i, 0, r); }
  const cut = Date.now() - WEEK - DAY;
  while (a.length && a[0].ts < cut) a.shift();
  dirty = true;
}

// ---------- Firebase ----------
async function startFirebase() {
  const V = '10.12.2';
  const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
  const db_ = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`);
  const { getDatabase, ref, onValue, onChildAdded, query, orderByChild, startAt } = db_;
  const app = initializeApp(CFG.firebase);
  const db = getDatabase(app);
  onValue(ref(db, '.info/connected'), s => s.val() ? setMode('live', 'LIVE') : setMode('err', S('mode_conn')));
  for (const dev of Object.keys(DEVICES)) {
    onValue(ref(db, `devices/${dev}/latest`), s => { latest[dev] = s.val(); dirty = true; renderLive(); },
      err => { console.error(err); setMode('err', S('mode_rules')); });
    const q = query(ref(db, `devices/${dev}/history`), orderByChild('ts'), startAt(Date.now() - WEEK));
    onChildAdded(q, s => addRow(dev, s.val()));
  }
}

// ---------- DEMO (Firebase баптамаған кезде) ----------
function startDemo() {
  setMode('demo', S('mode_demo'));
  const now = Date.now(), step = 5 * 60e3;
  const rnd = (a = 1) => (Math.random() - .5) * 2 * a;
  const air = t => {
    const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    const rush = Math.exp(-((h - 8.5) ** 2) / 2) * 450 + Math.exp(-((h - 18.5) ** 2) / 2.5) * 550;
    const spike = (t > now - 2.2 * DAY && t < now - 2.1 * DAY) ? 700 : 0;
    return { co2: Math.round(520 + rush + spike + rnd(40)), temp: +(-6 + 4 * Math.sin((h - 9) / 24 * 2 * Math.PI) + rnd(.4)).toFixed(1),
      hum: Math.round(68 - 10 * Math.sin((h - 9) / 24 * 2 * Math.PI) + rnd(3)), place: CFG.places.smokeoff, ts: t };
  };
  const water = t => {
    const h = new Date(t).getHours();
    const spike = (t > now - 4.3 * DAY && t < now - 4.1 * DAY) ? 180 : 0;
    return { turbidity: Math.max(0, Math.round(22 + 10 * Math.sin(h / 24 * 2 * Math.PI) + spike + rnd(6))),
      ph: +(7.4 + .25 * Math.sin(t / DAY * 2 * Math.PI) - (spike ? .9 : 0) + rnd(.05)).toFixed(2),
      wtemp: +(3.2 + .8 * Math.sin((h - 14) / 24 * 2 * Math.PI) + rnd(.15)).toFixed(1), place: CFG.places.aquascan, ts: t };
  };
  for (let t = now - WEEK; t <= now; t += step) { hist.smokeoff.push(air(t)); hist.aquascan.push(water(t)); }
  setInterval(() => {
    const t = Date.now();
    latest.smokeoff = air(t); latest.aquascan = water(t); renderLive();
  }, 5000);
  setInterval(() => { const t = Date.now(); addRow('smokeoff', air(t)); addRow('aquascan', water(t)); }, 60e3);
  latest.smokeoff = air(now); latest.aquascan = water(now);
}

// ---------- MySQL (PHP API, hoster.kz) ----------
async function startMySQL() {
  const api = CFG.apiUrl.replace(/\/?$/, '/');
  const get = async (q) => { const r = await fetch(api + q, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); };
  const since = { smokeoff: Date.now() - WEEK, aquascan: Date.now() - WEEK };
  async function pullHistory() {
    for (const dev of Object.keys(DEVICES)) {
      const rows = await get(`history.php?device=${dev}&since=${since[dev]}`);
      rows.forEach(r => { addRow(dev, r); if (r.ts > since[dev]) since[dev] = r.ts; });
    }
  }
  async function pullLatest() {
    try {
      const j = await get('latest.php');
      for (const dev of Object.keys(DEVICES)) if (j[dev]) latest[dev] = j[dev];
      setMode('live', 'LIVE');
      renderLive();
    } catch (e) { console.error(e); setMode('err', S('mode_err_srv')); }
  }
  await pullHistory(); dirty = true;
  await pullLatest(); renderAll();
  setInterval(pullLatest, 5000);
  setInterval(() => pullHistory().catch(console.error), 60000);
}

// ---------- безендіру: анимациялар ----------
let io;
function observeReveal() {
  if (!io) io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in'); io.unobserve(e.target);
    $$('[data-count]', e.target).concat(e.target.matches('[data-count]') ? [e.target] : []).forEach(countUp);
  }), { threshold: .15 });
  $$('.view.active .reveal:not(.in)').forEach(el => io.observe(el));
}
function countUp(el) {
  if (el.dataset.done) return; el.dataset.done = 1;
  const to = +el.dataset.count, suf = el.dataset.suffix || '', t0 = performance.now();
  const step = t => { const k = Math.min(1, (t - t0) / 1200); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + suf; if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function particles() {
  const c = $('#particles'), x = c.getContext('2d');
  let W, H, P = [];
  const size = () => { W = c.width = innerWidth * devicePixelRatio; H = c.height = innerHeight * devicePixelRatio; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px';
    P = [...Array(Math.round(innerWidth / 22))].map(() => ({ x: Math.random() * W, y: Math.random() * H, r: (Math.random() * 1.8 + .4) * devicePixelRatio, v: (Math.random() * .3 + .08) * devicePixelRatio, h: Math.random() < .5 ? '52,211,153' : '34,211,238', a: Math.random() * .5 + .15 })); };
  size(); addEventListener('resize', size);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  (function loop() {
    x.clearRect(0, 0, W, H);
    for (const p of P) { p.y -= p.v; if (p.y < -5) { p.y = H + 5; p.x = Math.random() * W; } x.beginPath(); x.arc(p.x, p.y, p.r, 0, 6.3); x.fillStyle = `rgba(${p.h},${p.a})`; x.fill(); }
    requestAnimationFrame(loop);
  })();
}
const ROLE_KEYS = { 'Жоба авторы': 'role_author', 'Ғылыми жетекші': 'role_mentor' };
const roleTxt = r => r ? (ROLE_KEYS[r] ? S(ROLE_KEYS[r]) : r) : '';
const KK_HTML = {};
function applyLang(l) {
  LANG = l; try { localStorage.setItem('eco-lang', l); } catch (e) {}
  document.documentElement.lang = l;
  document.title = I18N.title[l] || I18N.title.kk;
  $$('[data-i18n]').forEach(el => {
    const k = el.dataset.i18n;
    if (!(k in KK_HTML)) KK_HTML[k] = el.innerHTML;
    const v = l === 'kk' ? KK_HTML[k] : (I18N.html[l] || {})[k];
    if (v != null) el.innerHTML = v;
  });
  $$('#lang button').forEach(b => b.classList.toggle('active', b.dataset.l === l));
  fillStatic();
  tickerKey = '';
  const m = $('#mode'); if (m.dataset.k) setMode(m.className.replace('pill ', ''), S(m.dataset.k));
  dirty = true; renderAll();
}
function fillStatic() {
  const th = { co2good: T.co2.good, co2warn: T.co2.warn, phmin: T.ph.min, phmax: T.ph.max, turbwarn: T.turbidity.warn };
  $$('[data-th]').forEach(e => e.textContent = th[e.dataset.th]);
  $('#teamList').innerHTML = (CFG.team || []).map(m => `<div class="card member reveal in"><div class="avatar">${m.name.trim()[0] || '?'}</div><h4>${m.name}</h4><p>${roleTxt(m.role)}</p>${CFG.school ? `<p class="muted">${CFG.school}</p>` : ''}</div>`).join('');
}
function staticContent() {
  $('#lang').innerHTML = Object.entries(I18N.langs).map(([k, v]) => `<button data-l="${k}">${v}</button>`).join('');
  $('#lang').onclick = e => { const b = e.target.closest('button'); if (b) applyLang(b.dataset.l); };
  $$('svg > use').forEach(u => { const sym = document.querySelector(u.getAttribute('href')); if (sym) u.parentNode.innerHTML = sym.innerHTML; });
  $('#year').textContent = new Date().getFullYear();
  fillStatic();
  const art = $('#tlDemo').parentElement; let auto = true, i = 0;
  $('#tlDemo').onclick = e => { const b = e.target.closest('button'); if (!b) return; auto = false; art.dataset.tl = b.dataset.l; };
  setInterval(() => { if (auto) { i = (i + 1) % 3; art.dataset.tl = 'gyr'[i]; } }, 1800);
}

initCharts();
staticContent();
applyLang(LANG);
particles();
const be = CFG.backend || 'demo';
if (be === 'mysql') startMySQL().catch(e => { console.error(e); setMode('err', S('mode_err_db')); });
else if (be === 'firebase' && CFG.firebase.apiKey && CFG.firebase.databaseURL) startFirebase().catch(e => { console.error(e); setMode('err', S('mode_fb')); });
else startDemo();
route();
