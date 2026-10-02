import { CONFIG } from './config.js';

/* ═════════════ Opsætning ═════════════ */
const configured = CONFIG.SUPABASE_URL && !CONFIG.SUPABASE_URL.includes('DIN-') && !CONFIG.SUPABASE_ANON_KEY.includes('DIN-');
const sb = configured
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
const FN_URL = CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/ingest-receipt';

const CATEGORIES = ['Noder & instrumenter', 'Kørsel & transport', 'Rejse & overnatning', 'Markedsføring', 'Kontor & IT', 'Telefon & internet', 'Forsikring & kontingent', 'Repræsentation', 'Underleverandører', 'Andet'];
const KM_CAT = 'Kørsel i egen bil';
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];

const S = {
  user: null, tab: 'overblik', year: new Date().getFullYear(), salgView: 'fakturaer',
  settings: null, trips: [], routes: [], receipts: [], invoices: [], customers: [], income: [],
};

/* ═════════════ Hjælpere ═════════════ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sum = a => a.reduce((x, y) => x + (+y || 0), 0);
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const fmtVal = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmtVal).join('') : esc(v);
const html = (strings, ...vals) => new Raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmtVal(vals[i]) : ''), ''));

const nf0 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('da-DK', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kr = (n, d = false) => (d ? nf2 : nf0).format(n || 0) + ' kr.';
const ns = n => (n == null || n === '' ? '' : typeof n === 'number' ? String(n).replace('.', ',') : String(n));
const parseNum = v => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
};

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const fmtD = iso => iso ? parseISO(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'short' }) : '';
const fmtDY = iso => iso ? parseISO(iso).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function groupByMonth(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = (x[key] || '').slice(0, 7);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}
const monthName = ym => ym ? MONTHS[+ym.slice(5, 7) - 1] : 'Uden dato';

/* ═════════════ Data ═════════════ */
async function fetchAll() {
  const res = await Promise.all([
    sb.from('settings').select('*').maybeSingle(),
    sb.from('trips').select('*').order('trip_date', { ascending: false }).order('created_at', { ascending: false }),
    sb.from('routes').select('*').order('sort').order('created_at'),
    sb.from('receipts').select('*').order('created_at', { ascending: false }),
    sb.from('invoices').select('*').order('issue_date', { ascending: false }).order('seq', { ascending: false }),
    sb.from('customers').select('*').order('name'),
    sb.from('income').select('*').order('income_date', { ascending: false }),
  ]);
  const err = res.find(r => r.error)?.error;
  if (err) throw err;
  let settings = res[0].data;
  if (!settings) {
    const r = await sb.from('settings').insert({ user_id: S.user.id }).select().single();
    if (r.error) throw r.error;
    settings = r.data;
  }
  Object.assign(S, { settings, trips: res[1].data, routes: res[2].data, receipts: res[3].data, invoices: res[4].data, customers: res[5].data, income: res[6].data });
}
async function refresh() {
  try { await fetchAll(); } catch (e) { console.error(e); toast('Kunne ikke hente data: ' + (e.message || e), { err: true }); }
  render();
}
const must = r => { if (r.error) throw r.error; return r.data; };

/* ═════════════ Beregninger ═════════════ */
function tripValues(list) {
  const hi = +S.settings.km_rate || 0, lo = +S.settings.km_rate_low || 0, th = +S.settings.km_threshold || 20000;
  const asc = [...list].sort((a, b) => a.trip_date.localeCompare(b.trip_date) || (a.created_at || '').localeCompare(b.created_at || ''));
  const out = new Map();
  let cum = 0;
  for (const t of asc) {
    const km = +t.km;
    const hiKm = Math.max(0, Math.min(km, th - cum));
    out.set(t.id, hiKm * hi + (km - hiKm) * lo);
    cum += km;
  }
  return out;
}

const invStatus = i => (i.status === 'sent' && i.due_date < todayISO() ? 'overdue' : i.status);
const STATUS_TXT = { draft: 'Kladde', sent: 'Sendt', paid: 'Betalt', overdue: 'Forfalden', cancelled: 'Annulleret' };
const statusChip = i => { const st = invStatus(i); return html`<span class="chip ${st}">${STATUS_TXT[st]}</span>`; };
function dueText(i) {
  const d = daysBetween(todayISO(), i.due_date);
  if (d < 0) return `${plural(-d, 'dag', 'dage')} over fristen`;
  if (d === 0) return 'forfalder i dag';
  return `forfalder om ${plural(d, 'dag', 'dage')}`;
}

function calc() {
  const y = String(S.year), vatReg = !!S.settings.vat_registered;
  const inc = Array(12).fill(0), exp = Array(12).fill(0), cats = {};
  let vatOut = 0, vatIn = 0;
  const mi = iso => +iso.slice(5, 7) - 1;

  for (const i of S.invoices) {
    if (i.status === 'paid' && i.paid_date?.startsWith(y)) { inc[mi(i.paid_date)] += +i.subtotal; vatOut += +i.vat_amount; }
  }
  for (const n of S.income) {
    if (n.income_date.startsWith(y)) { inc[mi(n.income_date)] += +n.amount - (+n.vat_amount || 0); vatOut += +n.vat_amount || 0; }
  }
  for (const r of S.receipts) {
    if (r.status !== 'approved' || !r.receipt_date?.startsWith(y) || r.total == null) continue;
    const v = +r.vat_amount || 0;
    const net = vatReg ? +r.total - v : +r.total;
    exp[mi(r.receipt_date)] += net;
    const c = r.category || 'Andet';
    cats[c] = (cats[c] || 0) + net;
    if (vatReg) vatIn += v;
  }
  const yt = S.trips.filter(t => t.trip_date.startsWith(y));
  const vals = tripValues(yt);
  let km = 0, kmValue = 0;
  for (const t of yt) { const v = vals.get(t.id) || 0; exp[mi(t.trip_date)] += v; kmValue += v; km += +t.km; }
  if (kmValue) cats[KM_CAT] = kmValue;

  const income = sum(inc), expense = sum(exp);
  return { inc, exp, income, expense, result: income - expense, cats, km, kmValue, vatOut, vatIn };
}

/* ═════════════ UI-bund: toast, ark, viewer ═════════════ */
let toastTimer;
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action.label;
    b.onclick = async () => { t.classList.remove('show'); try { await opts.action.fn(); } catch (e) { toast(e.message, { err: true }); } };
    t.append(b);
  }
  t.className = 'show' + (opts.err ? ' err' : '');
  clearTimeout(toastTimer);
  if (!opts.sticky) toastTimer = setTimeout(() => t.classList.remove('show'), opts.ms || (opts.err ? 6000 : 4000));
}
const hideToast = () => $('#toast').classList.remove('show');

function openSheet({ title, body, submit = 'Gem', onSubmit, extra = '', onMount }) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.id = 'sheetWrap';
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = html`<div class="scrim" data-act="closeSheet"></div>
    <form class="sheet" novalidate autocomplete="off">
      <div class="sheet-head"><h2>${title}</h2><button type="button" class="x" data-act="closeSheet" aria-label="Luk">×</button></div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">${extra}${submit ? html`<button type="submit" class="btn primary">${submit}</button>` : ''}</div>
    </form>`.s;
  document.body.append(wrap);
  document.body.classList.add('lock');
  const form = $('form', wrap);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('[type=submit]', form);
    if (btn) btn.disabled = true;
    try { await onSubmit?.(form); } catch (err) { console.error(err); toast(err.message || String(err), { err: true }); if (btn) btn.disabled = false; }
  });
  onMount?.(form);
  return form;
}
function closeSheet() { $('#sheetWrap')?.remove(); document.body.classList.remove('lock'); }

function openViewer(url, mime) {
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = html`<div class="bar"><button data-act="closeViewer">Luk</button><a href="${url}" target="_blank" rel="noopener">Åbn i ny fane</a></div>
    ${mime === 'application/pdf' ? html`<iframe src="${url}" title="Bilag"></iframe>` : html`<img src="${url}" alt="Bilag">`}`.s;
  document.body.append(v);
}

/* ═════════════ Fælles view-dele ═════════════ */
const yearSwitch = () => html`<div class="yr"><button data-act="yearPrev" aria-label="Forrige år">‹</button><span>${S.year}</span><button data-act="yearNext" aria-label="Næste år" ${S.year >= new Date().getFullYear() ? 'disabled' : ''}>›</button></div>`;
const empty = (title, text) => html`<div class="empty"><b>${title}</b>${text}</div>`;

/* ═════════════ Overblik ═════════════ */
function chart(c) {
  const W = 336, H = 92, gw = W / 12;
  const max = Math.max(1, ...c.inc, ...c.exp);
  const nowM = S.year === new Date().getFullYear() ? new Date().getMonth() : -1;
  const bars = c.inc.map((v, i) => {
    const hi = Math.max(v > 0 ? 3 : 0, v / max * H), he = Math.max(c.exp[i] > 0 ? 3 : 0, c.exp[i] / max * H);
    const x = i * gw + 3.5;
    return html`<rect class="bi" x="${x}" y="${H - hi}" width="9" height="${hi}" rx="2.5"/><rect class="be" x="${x + 10.5}" y="${H - he}" width="9" height="${he}" rx="2.5"/><text class="${i === nowM ? 'now' : ''}" x="${i * gw + gw / 2}" y="${H + 14}">${'JFMAMJJASOND'[i]}</text>`;
  });
  return html`<svg class="chart" viewBox="0 0 ${W} ${H + 18}" role="img" aria-label="Indtægter og udgifter pr. måned">${bars}</svg>
    <div class="legend"><span><i style="background:#fff"></i>Indtægter</span><span><i style="background:rgba(255,255,255,.36)"></i>Udgifter</span></div>`;
}

function vOverblik() {
  const c = calc(), s = S.settings, today = todayISO();
  const unpaid = S.invoices.filter(i => i.status === 'sent').sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = unpaid.filter(i => i.due_date < today);
  const pending = S.receipts.filter(r => r.status === 'pending').length;
  const cats = Object.entries(c.cats).sort((a, b) => b[1] - a[1]);
  const maxCat = cats[0]?.[1] || 1;
  const th = +s.km_threshold || 20000;

  return html`
  <section class="hero">
    <div class="hero-top"><span>Resultat ${S.year}</span>${yearSwitch()}</div>
    <div class="hero-num">${kr(c.result)}</div>
    <div class="hero-sub"><span>Indtægter ${kr(c.income)}</span><span>Udgifter ${kr(c.expense)}</span></div>
    ${chart(c)}
  </section>

  ${pending ? html`<button class="banner" data-act="goBilag"><span>${plural(pending, 'bilag', 'bilag')} venter på godkendelse</span><span>Tjek ›</span></button>` : ''}

  <section class="block">
    <h2>Fakturaer</h2>
    ${unpaid.length ? html`
      <div class="pair">
        <div><div class="n">${kr(sum(unpaid.map(i => i.total)))}</div><div class="l">udestår på ${plural(unpaid.length, 'faktura', 'fakturaer')}</div></div>
        ${overdue.length ? html`<div class="bad"><div class="n">${kr(sum(overdue.map(i => i.total)))}</div><div class="l">${plural(overdue.length, 'faktura', 'fakturaer')} over fristen</div></div>` : ''}
      </div>
      ${unpaid.slice(0, 5).map(i => html`<button class="row" data-act="openInvoice" data-id="${i.id}">
        <div class="main"><div class="t">${i.customer_name}</div><div class="s ${i.due_date < today ? 'bad' : ''}">Nr. ${i.number}, ${dueText(i)}</div></div>
        <div class="amt">${kr(i.total)}</div></button>`)}
    ` : html`<p class="lead">${S.invoices.length ? 'Alle sendte fakturaer er betalt.' : 'Ingen fakturaer endnu.'}</p>`}
    <div class="btns"><button class="btn" data-act="newInvoice">Ny faktura</button></div>
  </section>

  <section class="block">
    <h2>Kørsel</h2>
    <div class="pair"><div><div class="n">${nf0.format(c.km)} km</div><div class="l">i ${S.year}</div></div><div><div class="n">${kr(c.kmValue)}</div><div class="l">fradrag efter takst</div></div></div>
    <div class="meter" title="Mod grænsen for høj takst"><i style="width:${Math.min(100, c.km / th * 100)}%"></i></div>
    <p class="lead">${c.km < th ? `${nf0.format(th - c.km)} km til lav takst træder ind.` : 'Over grænsen: lav takst gælder nu.'}</p>
  </section>

  ${cats.length ? html`<section class="block"><h2>Udgifter fordelt</h2>
    ${cats.map(([name, v]) => html`<div class="cat"><div class="h"><span>${name}</span><b>${kr(v)}</b></div><div class="meter"><i style="width:${v / maxCat * 100}%"></i></div></div>`)}
  </section>` : ''}

  ${s.vat_registered ? html`<section class="block"><h2>Moms ${S.year}</h2>
    <div class="pair"><div><div class="n">${kr(c.vatOut)}</div><div class="l">udgående</div></div><div><div class="n">${kr(c.vatIn)}</div><div class="l">indgående</div></div><div><div class="n">${kr(c.vatOut - c.vatIn)}</div><div class="l">${c.vatOut - c.vatIn >= 0 ? 'til betaling' : 'til gode'}</div></div></div>
    <p class="lead">Foreløbigt tal ud fra betalte fakturaer og godkendte bilag.</p></section>` : ''}
  `;
}

/* ═════════════ Kørsel ═════════════ */
function vKorsel() {
  const trips = S.trips.filter(t => t.trip_date.startsWith(String(S.year)));
  const vals = tripValues(trips);
  const km = sum(trips.map(t => t.km));
  return html`
  <header class="top"><h1>Kørsel</h1>${yearSwitch()}</header>
  <div class="routes">
    ${S.routes.map(r => html`<button class="route" data-act="logRoute" data-id="${r.id}"><span class="rl">${r.label}</span><span class="rk">${nf1.format(r.km * (r.round_trip ? 2 : 1))} km${r.round_trip ? ', tur/retur' : ''}</span></button>`)}
    <button class="route new" data-act="newTrip">+ Anden tur</button>
  </div>
  ${!S.routes.length ? html`<p class="sumline">Tip: giv en tur et navn, når du registrerer den, så får du en hurtigknap her.</p>` : ''}
  <p class="sumline"><b>${nf1.format(km)} km</b> i ${S.year}, svarende til <b>${kr(sum([...vals.values()]))}</b></p>
  ${trips.length ? groupByMonth(trips, 'trip_date').map(([ym, list]) => html`
    <div class="month"><span>${monthName(ym)}</span><span>${nf1.format(sum(list.map(t => t.km)))} km</span></div>
    <div class="list">${list.map(t => html`<button class="row" data-act="editTrip" data-id="${t.id}">
      <div class="main"><div class="t">${t.from_place || '?'} → ${t.to_place || '?'}</div><div class="s">${fmtD(t.trip_date)}${t.purpose ? ', ' + t.purpose : ''}</div></div>
      <div class="amt">${nf1.format(t.km)} km</div></button>`)}</div>`)
    : empty('Ingen ture endnu', 'Tryk på en hurtigknap eller på "Anden tur", så er første tur registreret.')}`;
}

function tripSheet(t) {
  const isNew = !t;
  const v = t || { trip_date: todayISO(), from_place: '', to_place: '', km: '', purpose: '' };
  const places = [...new Set(S.trips.flatMap(x => [x.from_place, x.to_place]).filter(Boolean))];
  openSheet({
    title: isNew ? 'Ny tur' : 'Ret tur',
    body: html`
      <label>Dato<input type="date" name="trip_date" value="${v.trip_date}" required></label>
      <div class="row2">
        <label>Fra<input name="from_place" list="places" value="${v.from_place}" placeholder="Hjem"></label>
        <label>Til<input name="to_place" list="places" value="${v.to_place}" placeholder="Risskov Kirke"></label>
      </div>
      <datalist id="places">${places.map(p => html`<option value="${p}">`)}</datalist>
      <div class="row2">
        <label>Kilometer<input name="km" inputmode="decimal" value="${ns(v.km)}" required></label>
        ${isNew ? html`<label class="check"><input type="checkbox" name="round"> Tur/retur</label>` : ''}
      </div>
      <label>Formål<input name="purpose" value="${v.purpose}" placeholder="Koncert, øvelse, møde"></label>
      ${isNew ? html`<label>Gem som fast tur (giv den et navn)<input name="route_label" placeholder="Fx Hjem til Risskov Kirke"></label>` : ''}`,
    extra: isNew ? '' : html`<button type="button" class="btn danger" data-act="delTrip" data-id="${t.id}">Slet</button>`,
    onMount: form => {
      const fill = () => {
        const km = form.elements.km;
        if (km.value) return;
        const f = form.elements.from_place.value.trim().toLowerCase(), to = form.elements.to_place.value.trim().toLowerCase();
        if (!f || !to) return;
        const m = S.trips.find(x => x.from_place.toLowerCase() === f && x.to_place.toLowerCase() === to);
        if (m) km.value = ns(m.km);
      };
      form.elements.from_place.addEventListener('change', fill);
      form.elements.to_place.addEventListener('change', fill);
    },
    onSubmit: async form => {
      const f = new FormData(form);
      const km = parseNum(f.get('km'));
      if (!(km > 0)) throw new Error('Skriv antal kilometer');
      const mult = f.get('round') ? 2 : 1;
      const row = {
        trip_date: f.get('trip_date') || todayISO(), from_place: f.get('from_place').trim(), to_place: f.get('to_place').trim(),
        km: round2(km * mult), purpose: f.get('purpose').trim(),
      };
      if (isNew) {
        must(await sb.from('trips').insert(row));
        const label = (f.get('route_label') || '').trim();
        if (label) must(await sb.from('routes').insert({ label, from_place: row.from_place, to_place: row.to_place, km, round_trip: !!f.get('round'), purpose: row.purpose, sort: S.routes.length }));
      } else {
        must(await sb.from('trips').update(row).eq('id', t.id));
      }
      closeSheet(); await refresh(); toast('Tur gemt');
    },
  });
}

async function logRoute(id) {
  const r = S.routes.find(x => x.id === id);
  if (!r) return;
  const km = r.km * (r.round_trip ? 2 : 1);
  const { data, error } = await sb.from('trips').insert({ trip_date: todayISO(), from_place: r.from_place, to_place: r.to_place, km, purpose: r.purpose }).select().single();
  if (error) return toast(error.message, { err: true });
  await refresh();
  toast(`Logget: ${nf1.format(km)} km, ${r.label}`, { ms: 7000, action: { label: 'Fortryd', fn: async () => { must(await sb.from('trips').delete().eq('id', data.id)); await refresh(); toast('Tur fjernet'); } } });
}

function routeSheet(r) {
  const isNew = !r;
  const v = r || { label: '', from_place: '', to_place: '', km: '', purpose: '', round_trip: false };
  openSheet({
    title: isNew ? 'Ny fast tur' : 'Ret fast tur',
    body: html`
      <label>Navn på knappen<input name="label" value="${v.label}" placeholder="Hjem til Risskov Kirke" required></label>
      <div class="row2"><label>Fra<input name="from_place" value="${v.from_place}"></label><label>Til<input name="to_place" value="${v.to_place}"></label></div>
      <div class="row2"><label>Kilometer, én vej<input name="km" inputmode="decimal" value="${ns(v.km)}" required></label>
      <label class="check"><input type="checkbox" name="round" ${v.round_trip ? 'checked' : ''}> Tur/retur</label></div>
      <label>Formål<input name="purpose" value="${v.purpose}"></label>`,
    extra: isNew ? '' : html`<button type="button" class="btn danger" data-act="delRoute" data-id="${r.id}">Slet</button>`,
    onSubmit: async form => {
      const f = new FormData(form), km = parseNum(f.get('km'));
      if (!f.get('label').trim()) throw new Error('Giv turen et navn');
      if (!(km > 0)) throw new Error('Skriv antal kilometer');
      const row = { label: f.get('label').trim(), from_place: f.get('from_place').trim(), to_place: f.get('to_place').trim(), km, round_trip: !!f.get('round'), purpose: f.get('purpose').trim() };
      must(isNew ? await sb.from('routes').insert({ ...row, sort: S.routes.length }) : await sb.from('routes').update(row).eq('id', r.id));
      closeSheet(); await refresh();
    },
  });
}

/* ═════════════ Bilag ═════════════ */
function receiptRow(r) {
  const foreign = r.currency && r.currency !== 'DKK';
  return html`<button class="row" data-act="editReceipt" data-id="${r.id}">
    <div class="main"><div class="t">${r.vendor || r.file_name || 'Bilag'}</div>
    <div class="s ${r.extract_error ? 'bad' : ''}">${r.extract_error ? 'Kunne ikke aflæses, udfyld selv' : [fmtD(r.receipt_date), r.category].filter(Boolean).join(', ') || 'Mangler oplysninger'}</div></div>
    <div class="amt">${r.total != null ? kr(r.total, true) : foreign ? r.currency : '–'}</div></button>`;
}

function vBilag() {
  const pend = S.receipts.filter(r => r.status === 'pending');
  const appr = S.receipts.filter(r => r.status === 'approved' && (r.receipt_date || '').startsWith(String(S.year)));
  return html`
  <header class="top"><h1>Bilag</h1>${yearSwitch()}</header>
  <div class="uploads">
    <button class="btn primary" data-act="pickCam">Tag foto</button>
    <button class="btn" data-act="pickFile">Vælg fil</button>
  </div>
  ${pend.length ? html`<div class="month"><span>Til godkendelse</span><span>${pend.length}</span></div><div class="list">${pend.map(receiptRow)}</div>` : ''}
  ${appr.length ? groupByMonth(appr, 'receipt_date').map(([ym, list]) => html`
    <div class="month"><span>${monthName(ym)}</span><span>${kr(sum(list.map(r => r.total)))}</span></div>
    <div class="list">${list.map(receiptRow)}</div>`)
    : (pend.length ? '' : empty('Ingen bilag endnu', 'Tag et foto af en kvittering, eller del en PDF fra Mail via genvejen i iOS.'))}`;
}

function receiptSheet(r) {
  const pending = r.status === 'pending';
  const foreign = r.currency && r.currency !== 'DKK';
  openSheet({
    title: pending ? 'Tjek bilag' : 'Bilag',
    submit: pending ? 'Godkend' : 'Gem',
    body: html`
      ${r.extract_error ? html`<p class="notice warn">Bilaget kunne ikke aflæses automatisk. Udfyld felterne selv.</p>` : ''}
      ${foreign ? html`<p class="notice">Bilaget er i ${r.currency}${r.orig_total != null ? ' (' + nf2.format(r.orig_total) + ')' : ''}. Skriv beløbet i kroner herunder.</p>` : ''}
      <label>Leverandør<input name="vendor" value="${r.vendor}"></label>
      <div class="row2">
        <label>Dato<input type="date" name="receipt_date" value="${r.receipt_date || ''}"></label>
        <label>Beløb i kr.<input name="total" inputmode="decimal" value="${ns(r.total)}"></label>
      </div>
      <div class="row2">
        <label>Heraf moms<input name="vat_amount" inputmode="decimal" value="${ns(r.vat_amount || '')}"></label>
        <label>Kategori<select name="category">${['', ...CATEGORIES].map(c => html`<option value="${c}" ${c === r.category ? 'selected' : ''}>${c || 'Vælg'}</option>`)}</select></label>
      </div>
      <label>Note<input name="note" value="${r.note}"></label>`,
    extra: html`${r.file_path ? html`<button type="button" class="btn" data-act="viewFile" data-id="${r.id}">Se bilag</button>` : ''}<button type="button" class="btn danger" data-act="delReceipt" data-id="${r.id}">Slet</button>`,
    onSubmit: async form => {
      const f = new FormData(form);
      const total = parseNum(f.get('total'));
      const vat = parseNum(f.get('vat_amount'));
      if (pending && !(total >= 0)) throw new Error('Skriv beløbet i kroner');
      if (pending && !f.get('receipt_date')) throw new Error('Vælg bilagets dato');
      const row = {
        vendor: f.get('vendor').trim(), receipt_date: f.get('receipt_date') || null,
        total: isNaN(total) ? null : total, vat_amount: isNaN(vat) ? 0 : vat,
        category: f.get('category'), note: f.get('note').trim(), status: 'approved',
      };
      if (pending) row.approved_at = new Date().toISOString();
      must(await sb.from('receipts').update(row).eq('id', r.id));
      closeSheet(); await refresh(); toast(pending ? 'Bilag godkendt' : 'Bilag gemt');
    },
  });
}

/* Upload med offline-kø */
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('regnskab', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      rq.onsuccess = () => { this.db = rq.result; res(this.db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('queue', mode), st = tx.objectStore('queue'), rq = fn(st);
      tx.oncomplete = () => res(rq?.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  add: item => idb.run('readwrite', s => s.add(item)),
  all: () => idb.run('readonly', s => s.getAll()),
  del: id => idb.run('readwrite', s => s.delete(id)),
};

async function compress(file, max = 2000, q = 0.85) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    return blob || file;
  } catch { return file; }
}

async function sendReceipt(blob, name) {
  const { data: { session } } = await sb.auth.getSession();
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await fetch(FN_URL, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, apikey: CONFIG.SUPABASE_ANON_KEY }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Fejl ${res.status}`); e.http = true; throw e; }
  return data;
}

async function uploadFiles(files) {
  for (const file of files) {
    const blob = await compress(file);
    const name = file.name || 'bilag';
    toast('Uploader bilag', { sticky: true });
    try {
      await sendReceipt(blob, name);
      await refresh();
      toast('Bilag gemt. Tjek oplysningerne og godkend.', { ms: 5000 });
    } catch (e) {
      if (e.http) { toast(e.message, { err: true }); continue; }
      await idb.add({ blob, name });
      toast('Ingen forbindelse. Bilaget sendes, når du er online igen.', { ms: 6000 });
    }
  }
}
async function flushQueue() {
  if (!sb || !S.user || !navigator.onLine) return;
  let items = [];
  try { items = await idb.all(); } catch { return; }
  let sent = 0;
  for (const it of items) {
    try { await sendReceipt(it.blob, it.name); await idb.del(it.id); sent++; }
    catch (e) { if (e.http) await idb.del(it.id); else break; }
  }
  if (sent) { await refresh(); toast(`${plural(sent, 'bilag', 'bilag')} sendt fra køen`); }
}

/* ═════════════ Salg: fakturaer og indtægter ═════════════ */
function vSalg() {
  const y = String(S.year);
  const invs = S.invoices.filter(i => i.issue_date.startsWith(y) || i.status === 'sent');
  const inc = S.income.filter(n => n.income_date.startsWith(y));
  return html`
  <header class="top"><h1>Salg</h1>${yearSwitch()}</header>
  <div class="btns" style="padding:0 20px">
    <button class="btn ${S.salgView === 'fakturaer' ? 'primary' : ''}" data-act="salgView" data-v="fakturaer">Fakturaer</button>
    <button class="btn ${S.salgView === 'indtaegter' ? 'primary' : ''}" data-act="salgView" data-v="indtaegter">Andre indtægter</button>
  </div>
  ${S.salgView === 'fakturaer' ? html`
    <div class="btns" style="padding:0 20px"><button class="btn block-btn" data-act="newInvoice">Ny faktura</button></div>
    <div class="list">${invs.length ? invs.map(i => html`<button class="row" data-act="openInvoice" data-id="${i.id}">
      <div class="main"><div class="t">${i.customer_name}</div>
      <div class="s ${invStatus(i) === 'overdue' ? 'bad' : ''}">Nr. ${i.number}, ${i.status === 'sent' ? dueText(i) : i.status === 'paid' ? 'betalt ' + fmtD(i.paid_date) : fmtD(i.issue_date)}</div></div>
      <div style="text-align:right"><div class="amt">${kr(i.total)}</div>${statusChip(i)}</div></button>`)
      : empty('Ingen fakturaer i ' + y, 'Tryk på "Ny faktura", så er du i gang.')}</div>`
  : html`
    <div class="btns" style="padding:0 20px"><button class="btn block-btn" data-act="newIncome">Tilføj indtægt</button></div>
    <p class="sumline">Til honorarer og andet, du ikke fakturerer. Faktura-indtægter tæller automatisk, når de er markeret betalt.</p>
    <div class="list">${inc.length ? inc.map(n => html`<button class="row" data-act="editIncome" data-id="${n.id}">
      <div class="main"><div class="t">${n.source}</div><div class="s">${fmtD(n.income_date)}${n.note ? ', ' + n.note : ''}</div></div>
      <div class="amt pos">${kr(n.amount, true)}</div></button>`) : empty('Ingen indtægter i ' + y, '')}</div>`}`;
}

function incomeSheet(n) {
  const isNew = !n;
  const v = n || { income_date: todayISO(), source: '', amount: '', vat_amount: '', note: '' };
  openSheet({
    title: isNew ? 'Ny indtægt' : 'Ret indtægt',
    body: html`
      <label>Dato<input type="date" name="income_date" value="${v.income_date}" required></label>
      <label>Fra hvem eller hvad<input name="source" value="${v.source}" placeholder="Fx Risskov Kirke, honorar" required></label>
      <div class="row2"><label>Beløb inkl. moms<input name="amount" inputmode="decimal" value="${ns(v.amount)}" required></label>
      <label>Heraf moms<input name="vat_amount" inputmode="decimal" value="${ns(v.vat_amount || '')}"></label></div>
      <label>Note<input name="note" value="${v.note}"></label>`,
    extra: isNew ? '' : html`<button type="button" class="btn danger" data-act="delIncome" data-id="${n.id}">Slet</button>`,
    onSubmit: async form => {
      const f = new FormData(form), amount = parseNum(f.get('amount')), vat = parseNum(f.get('vat_amount'));
      if (!f.get('source').trim()) throw new Error('Skriv, hvor pengene kommer fra');
      if (isNaN(amount)) throw new Error('Skriv beløbet');
      const row = { income_date: f.get('income_date'), source: f.get('source').trim(), amount, vat_amount: isNaN(vat) ? 0 : vat, note: f.get('note').trim() };
      must(isNew ? await sb.from('income').insert(row) : await sb.from('income').update(row).eq('id', n.id));
      closeSheet(); await refresh();
    },
  });
}

/* Fakturaer */
function invoiceTotals(lines, vatRate) {
  const subtotal = round2(sum(lines.map(l => l.qty * l.unit_price)));
  const vat = round2(subtotal * (+vatRate || 0) / 100);
  return { subtotal, vat, total: round2(subtotal + vat) };
}
const lineHtml = (l = { description: '', qty: 1, unit_price: '' }) => html`<div class="line">
  <input class="l-desc" placeholder="Beskrivelse, fx Orgelkoncert 12. oktober" value="${l.description}">
  <div class="l3"><input class="l-qty" inputmode="decimal" aria-label="Antal" value="${ns(l.qty)}"><input class="l-price" inputmode="decimal" aria-label="Pris pr. stk." placeholder="Pris i kr." value="${ns(l.unit_price)}"><button type="button" class="x" data-act="rmLine" aria-label="Fjern linje">×</button></div></div>`;

function readInvoiceForm(form) {
  const f = new FormData(form);
  const lines = $$('.line', form).map(el => ({
    description: $('.l-desc', el).value.trim(),
    qty: parseNum($('.l-qty', el).value) || 0,
    unit_price: parseNum($('.l-price', el).value) || 0,
  })).filter(l => l.description || l.unit_price);
  return {
    customer_name: f.get('customer_name').trim(), customer_address: f.get('customer_address').trim(),
    customer_zip_city: f.get('customer_zip_city').trim(), customer_cvr: f.get('customer_cvr').trim(), customer_email: f.get('customer_email').trim(),
    issue_date: f.get('issue_date') || todayISO(), days: parseInt(f.get('days'), 10),
    vat_rate: +f.get('vat_rate') || 0, note: f.get('note').trim(), lines,
  };
}

function invoiceSheet(inv) {
  loadJsPdf().catch(() => {});
  const s = S.settings, isNew = !inv;
  const v = inv || { customer_name: '', customer_address: '', customer_zip_city: '', customer_cvr: '', customer_email: '', issue_date: todayISO(), vat_rate: s.default_vat_rate ?? 0, lines: [], note: '' };
  const days = inv ? daysBetween(inv.issue_date, inv.due_date) : (s.payment_days ?? 14);
  openSheet({
    title: isNew ? 'Ny faktura' : `Ret faktura ${inv.number}`,
    submit: 'Gem',
    body: html`
      <label>Kunde<input name="customer_name" list="custList" value="${v.customer_name}" required></label>
      <datalist id="custList">${S.customers.map(c => html`<option value="${c.name}">`)}</datalist>
      <label>Adresse<input name="customer_address" value="${v.customer_address}"></label>
      <div class="row2"><label>Postnr. og by<input name="customer_zip_city" value="${v.customer_zip_city}"></label><label>CVR<input name="customer_cvr" inputmode="numeric" value="${v.customer_cvr}"></label></div>
      <label>E-mail<input name="customer_email" type="email" inputmode="email" value="${v.customer_email}"></label>
      <div class="row2"><label>Fakturadato<input type="date" name="issue_date" value="${v.issue_date}"></label><label>Betalingsfrist, dage<input name="days" inputmode="numeric" value="${days}"></label></div>
      <div id="lines">${(v.lines.length ? v.lines : [undefined]).map(l => lineHtml(l))}</div>
      <button type="button" class="btn ghost" data-act="addLine">+ Tilføj linje</button>
      <label style="margin-top:14px">Moms<select name="vat_rate"><option value="0" ${+v.vat_rate === 0 ? 'selected' : ''}>Ingen moms</option><option value="25" ${+v.vat_rate === 25 ? 'selected' : ''}>25 %</option></select></label>
      <div class="totals" id="totals"></div>
      <label>Note på fakturaen<textarea name="note" rows="2">${v.note}</textarea></label>`,
    extra: html`${!inv || inv.status === 'draft' ? html`<button type="button" class="btn" data-act="saveSend">Gem og send</button>` : ''}`,
    onMount: form => {
      const upd = () => {
        const d = readInvoiceForm(form), t = invoiceTotals(d.lines, d.vat_rate);
        $('#totals', form).innerHTML = html`<div><span>Beløb</span><span>${kr(t.subtotal, true)}</span></div>${d.vat_rate ? html`<div><span>Moms ${d.vat_rate} %</span><span>${kr(t.vat, true)}</span></div>` : ''}<div class="big"><span>I alt</span><span>${kr(t.total, true)}</span></div>`.s;
      };
      form.addEventListener('input', upd); form.addEventListener('change', upd); upd();
      form.elements.customer_name.addEventListener('change', e => {
        const c = S.customers.find(x => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
        if (!c) return;
        form.elements.customer_address.value = c.address || ''; form.elements.customer_zip_city.value = c.zip_city || '';
        form.elements.customer_cvr.value = c.cvr || ''; form.elements.customer_email.value = c.email || '';
      });
      form.dataset.invoice = inv?.id || '';
    },
    onSubmit: form => saveInvoice(form, inv, false),
  });
}

async function saveInvoice(form, existing, send) {
  const p = readInvoiceForm(form);
  if (!p.customer_name) throw new Error('Skriv kundens navn');
  if (!p.lines.length || !p.lines.some(l => l.unit_price)) throw new Error('Tilføj mindst én linje med pris');
  if (isNaN(p.days)) p.days = S.settings.payment_days ?? 14;
  const t = invoiceTotals(p.lines, p.vat_rate);

  const cust = { name: p.customer_name, address: p.customer_address, zip_city: p.customer_zip_city, cvr: p.customer_cvr, email: p.customer_email };
  const known = S.customers.find(c => c.name.toLowerCase() === p.customer_name.toLowerCase());
  let cid = known?.id;
  if (known) must(await sb.from('customers').update(cust).eq('id', known.id));
  else cid = must(await sb.from('customers').insert(cust).select().single()).id;

  const row = {
    customer_id: cid, customer_name: p.customer_name, customer_address: p.customer_address, customer_zip_city: p.customer_zip_city,
    customer_cvr: p.customer_cvr, customer_email: p.customer_email, issue_date: p.issue_date, due_date: addDays(p.issue_date, p.days),
    lines: p.lines, vat_rate: p.vat_rate, subtotal: t.subtotal, vat_amount: t.vat, total: t.total, note: p.note,
  };
  let saved;
  if (!existing) {
    const year = +p.issue_date.slice(0, 4);
    const seq = Math.max(0, ...S.invoices.filter(i => i.year === year).map(i => i.seq)) + 1;
    Object.assign(row, { year, seq, number: `${year}-${String(seq).padStart(3, '0')}`, status: send ? 'sent' : 'draft', sent_date: send ? todayISO() : null });
    saved = must(await sb.from('invoices').insert(row).select().single());
  } else {
    if (send && existing.status === 'draft') Object.assign(row, { status: 'sent', sent_date: todayISO() });
    saved = must(await sb.from('invoices').update(row).eq('id', existing.id).select().single());
  }
  closeSheet(); await refresh();
  if (send) invoiceDetail(saved); else toast('Faktura gemt');
}

function invoiceDetail(inv) {
  loadJsPdf().catch(() => {});
  const st = invStatus(inv);
  const secondary = inv.status === 'draft'
    ? html`<button type="button" class="btn" data-act="markSent" data-id="${inv.id}">Marker som sendt</button>`
    : inv.status === 'sent' ? html`<button type="button" class="btn" data-act="markPaid" data-id="${inv.id}">Marker som betalt</button>` : '';
  openSheet({
    title: `Faktura ${inv.number}`, submit: null,
    body: html`
      <div class="inv-meta">${statusChip(inv)}<span>${inv.customer_name}</span></div>
      <p class="lead" style="font-size:14px;color:var(--mute)">${fmtDY(inv.issue_date)}, forfald ${fmtDY(inv.due_date)}${inv.paid_date ? ', betalt ' + fmtDY(inv.paid_date) : ''}${st === 'overdue' ? ' (' + dueText(inv) + ')' : ''}</p>
      <div>${inv.lines.map(l => html`<div class="row"><div class="main"><div class="t">${l.description}</div><div class="s">${nf1.format(l.qty)} × ${nf2.format(l.unit_price)}</div></div><div class="amt">${nf2.format(l.qty * l.unit_price)}</div></div>`)}</div>
      <div class="totals"><div><span>Beløb</span><span>${kr(inv.subtotal, true)}</span></div>${+inv.vat_rate ? html`<div><span>Moms ${inv.vat_rate} %</span><span>${kr(inv.vat_amount, true)}</span></div>` : ''}<div class="big"><span>I alt</span><span>${kr(inv.total, true)}</span></div></div>
      ${inv.note ? html`<p style="font-size:14px;color:var(--mute)">${inv.note}</p>` : ''}`,
    extra: html`<button type="button" class="btn primary" style="flex-basis:100%" data-act="sharePdf" data-id="${inv.id}">Del PDF</button>
      ${secondary}<button type="button" class="btn" data-act="editInvoice" data-id="${inv.id}">Rediger</button>
      ${inv.status === 'draft' ? html`<button type="button" class="btn danger" data-act="delInvoice" data-id="${inv.id}">Slet</button>`
        : inv.status !== 'cancelled' ? html`<button type="button" class="btn danger" data-act="cancelInvoice" data-id="${inv.id}">Annuller</button>` : ''}`,
  });
}

function paidSheet(inv) {
  openSheet({
    title: 'Marker som betalt', submit: 'Marker som betalt',
    body: html`<p class="lead" style="color:var(--mute);margin-bottom:10px">Brug datoen, pengene kom ind på kontoen.</p><label>Betalingsdato<input type="date" name="paid_date" value="${todayISO()}" required></label>`,
    onSubmit: async form => {
      const d = new FormData(form).get('paid_date') || todayISO();
      must(await sb.from('invoices').update({ status: 'paid', paid_date: d }).eq('id', inv.id));
      closeSheet(); await refresh(); toast('Faktura markeret som betalt');
    },
  });
}

/* PDF */
let jsPdfPromise;
function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf);
  jsPdfPromise ??= new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    sc.onload = () => res(window.jspdf);
    sc.onerror = () => { jsPdfPromise = null; rej(new Error('Kunne ikke hente PDF-værktøjet. Er du online?')); };
    document.head.append(sc);
  });
  return jsPdfPromise;
}

function makeInvoicePdf(inv) {
  const { jsPDF } = window.jspdf, s = S.settings;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 20, R = 190;
  doc.setLineHeightFactor(1.35);
  const text = (t, x, y, o = {}) => doc.text(Array.isArray(t) ? t : String(t), x, y, o);
  const money = n => nf2.format(n);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  text(s.company_name || s.owner_name || 'Min virksomhed', L, 24);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  let y = 30;
  for (const line of [s.owner_name && s.owner_name !== s.company_name ? s.owner_name : '', s.address, s.zip_city, s.cvr ? 'CVR ' + s.cvr : '', s.email, s.phone].filter(Boolean)) { text(line, L, y); y += 4.6; }

  doc.setFont('helvetica', 'bold'); doc.setFontSize(22); text('FAKTURA', R, 24, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  text(`Fakturanr. ${inv.number}`, R, 31, { align: 'right' });
  text(`Fakturadato ${fmtDY(inv.issue_date)}`, R, 36, { align: 'right' });
  text(`Forfaldsdato ${fmtDY(inv.due_date)}`, R, 41, { align: 'right' });

  y = 66;
  doc.setFont('helvetica', 'bold'); text(inv.customer_name, L, y); doc.setFont('helvetica', 'normal');
  for (const line of [inv.customer_address, inv.customer_zip_city, inv.customer_cvr ? 'CVR ' + inv.customer_cvr : ''].filter(Boolean)) { y += 4.8; text(line, L, y); }

  y = 98;
  const head = () => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
    text('Beskrivelse', L, y); text('Antal', 125, y, { align: 'right' }); text('Pris', 155, y, { align: 'right' }); text('Beløb', R, y, { align: 'right' });
    doc.setDrawColor(40); doc.setLineWidth(0.4); doc.line(L, y + 2, R, y + 2);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); y += 8;
  };
  head();
  for (const l of inv.lines) {
    const parts = doc.splitTextToSize(l.description || '', 88);
    const h = parts.length * 4.8;
    if (y + h > 255) { doc.addPage(); y = 24; head(); }
    text(parts, L, y);
    text(nf1.format(l.qty), 125, y, { align: 'right' }); text(money(l.unit_price), 155, y, { align: 'right' }); text(money(l.qty * l.unit_price), R, y, { align: 'right' });
    y += h + 2.5;
    doc.setDrawColor(215); doc.setLineWidth(0.2); doc.line(L, y - 2.5, R, y - 2.5);
  }

  if (y > 215) { doc.addPage(); y = 24; }
  y += 4;
  text('Beløb ekskl. moms', 155, y, { align: 'right' }); text(money(inv.subtotal), R, y, { align: 'right' });
  if (+inv.vat_rate) { y += 5.5; text(`Moms ${inv.vat_rate} %`, 155, y, { align: 'right' }); text(money(inv.vat_amount), R, y, { align: 'right' }); }
  y += 8; doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
  text('I alt DKK', 155, y, { align: 'right' }); text(money(inv.total), R, y, { align: 'right' });

  y += 16; doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const pay = [];
  if (s.bank_reg || s.bank_account) pay.push(`Reg.nr. ${s.bank_reg}  Kontonr. ${s.bank_account}`);
  if (s.iban) pay.push(`IBAN ${s.iban}`);
  doc.setFont('helvetica', 'bold'); text('Betaling', L, y); doc.setFont('helvetica', 'normal');
  y += 5; text(`Betal senest ${fmtDY(inv.due_date)}. Angiv fakturanr. ${inv.number}.`, L, y);
  for (const p of pay) { y += 5; text(p, L, y); }
  if (inv.note) { y += 10; const parts = doc.splitTextToSize(inv.note, R - L); text(parts, L, y); y += parts.length * 4.8; }
  if (s.invoice_footer) { y += 8; doc.setFontSize(9); text(doc.splitTextToSize(s.invoice_footer, R - L), L, y); }

  return doc.output('blob');
}

async function shareBlob(blob, name, type) {
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'aborted'; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

async function shareInvoice(inv) {
  await loadJsPdf();
  const blob = makeInvoicePdf(inv);
  const r = await shareBlob(blob, `Faktura ${inv.number}.pdf`, 'application/pdf');
  if (r !== 'aborted' && inv.status === 'draft') {
    must(await sb.from('invoices').update({ status: 'sent', sent_date: todayISO() }).eq('id', inv.id));
    await refresh(); toast('Faktura markeret som sendt');
  }
}

/* ═════════════ Mere ═════════════ */
function vMere() {
  const s = S.settings;
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  return html`
  <header class="top"><h1>Mere</h1></header>
  ${standalone ? '' : html`<p class="notice">Åbn siden i Safari, tryk på Del og vælg "Føj til hjemmeskærm", så fungerer den som en app.</p>`}
  <section class="block"><h2>Virksomhed</h2>
    <button class="row" data-act="editSettings"><div class="main"><div class="t">${s.company_name || 'Udfyld dine oplysninger'}</div><div class="s">${s.cvr ? 'CVR ' + s.cvr + ', ' : ''}${nf2.format(s.km_rate)} kr. pr. km</div></div><span class="chev">›</span></button>
  </section>
  <section class="block"><h2>Faste ture</h2>
    ${S.routes.map(r => html`<button class="row" data-act="editRoute" data-id="${r.id}"><div class="main"><div class="t">${r.label}</div><div class="s">${nf1.format(r.km)} km${r.round_trip ? ', tur/retur' : ''}</div></div><span class="chev">›</span></button>`)}
    <div class="btns"><button class="btn" data-act="newRoute">Ny fast tur</button></div>
  </section>
  <section class="block"><h2>Eksportér ${S.year}</h2>
    <p class="lead">CSV-filer, der kan åbnes i Excel eller sendes til din revisor.</p>
    <div class="btns"><button class="btn" data-act="exportCsv" data-k="trips">Kørsel</button><button class="btn" data-act="exportCsv" data-k="receipts">Bilag</button><button class="btn" data-act="exportCsv" data-k="invoices">Fakturaer</button><button class="btn" data-act="exportCsv" data-k="income">Indtægter</button></div>
  </section>
  <section class="block"><h2>Hurtig upload af bilag</h2>
    <p class="lead">Adressen til din iOS-genvej. Se README for opsætning.</p>
    <p><code>${FN_URL}</code></p>
    <div class="btns"><button class="btn" data-act="copyUrl">Kopiér adresse</button></div>
  </section>
  <section class="block"><p class="lead">${S.user.email}</p><div class="btns"><button class="btn" data-act="signOut">Log ud</button></div></section>`;
}

function settingsSheet() {
  const s = S.settings;
  const inp = (n, label, extra = '') => html`<label>${label}<input name="${n}" value="${ns(s[n])}" ${extra}></label>`;
  openSheet({
    title: 'Virksomhed og satser',
    body: html`
      ${inp('company_name', 'Virksomhedens navn')}${inp('owner_name', 'Dit navn')}${inp('address', 'Adresse')}
      <div class="row2">${inp('zip_city', 'Postnr. og by')}${inp('cvr', 'CVR', 'inputmode="numeric"')}</div>
      <div class="row2">${inp('email', 'E-mail', 'inputmode="email"')}${inp('phone', 'Telefon', 'inputmode="tel"')}</div>
      <div class="row2">${inp('bank_reg', 'Reg.nr.', 'inputmode="numeric"')}${inp('bank_account', 'Kontonr.', 'inputmode="numeric"')}</div>
      ${inp('iban', 'IBAN (valgfrit)')}
      <div class="row2">${inp('payment_days', 'Betalingsfrist, dage', 'inputmode="numeric"')}
        <label>Standard-moms på fakturaer<select name="default_vat_rate"><option value="0" ${+s.default_vat_rate === 0 ? 'selected' : ''}>Ingen moms</option><option value="25" ${+s.default_vat_rate === 25 ? 'selected' : ''}>25 %</option></select></label></div>
      <label class="check" style="padding-top:0"><input type="checkbox" name="vat_registered" ${s.vat_registered ? 'checked' : ''}> Jeg er momsregistreret</label>
      <div class="row2">${inp('km_rate', 'Kørselstakst, kr./km', 'inputmode="decimal"')}${inp('km_rate_low', 'Takst over grænsen', 'inputmode="decimal"')}</div>
      ${inp('km_threshold', 'Grænse for høj takst, km pr. år', 'inputmode="numeric"')}
      <p class="lead" style="font-size:13px;color:var(--mute)">Tjek SKATs satser for det aktuelle år.</p>
      <label>Tekst nederst på fakturaer<textarea name="invoice_footer" rows="2">${s.invoice_footer}</textarea></label>`,
    onSubmit: async form => {
      const f = new FormData(form), g = k => (f.get(k) ?? '').toString().trim();
      const row = {
        company_name: g('company_name'), owner_name: g('owner_name'), address: g('address'), zip_city: g('zip_city'), cvr: g('cvr'),
        email: g('email'), phone: g('phone'), bank_reg: g('bank_reg'), bank_account: g('bank_account'), iban: g('iban'),
        payment_days: parseInt(g('payment_days'), 10) || 14, default_vat_rate: +g('default_vat_rate') || 0, vat_registered: !!f.get('vat_registered'),
        km_rate: parseNum(g('km_rate')) || 0, km_rate_low: parseNum(g('km_rate_low')) || 0, km_threshold: parseInt(g('km_threshold'), 10) || 20000,
        invoice_footer: g('invoice_footer'), updated_at: new Date().toISOString(),
      };
      must(await sb.from('settings').update(row).eq('user_id', S.user.id));
      closeSheet(); await refresh(); toast('Gemt');
    },
  });
}

function exportCsv(kind) {
  const y = String(S.year);
  const vals = tripValues(S.trips.filter(t => t.trip_date.startsWith(y)));
  const sets = {
    trips: [['Dato', 'Fra', 'Til', 'Km', 'Formål', 'Beløb efter takst'], ...S.trips.filter(t => t.trip_date.startsWith(y)).sort((a, b) => a.trip_date.localeCompare(b.trip_date)).map(t => [t.trip_date, t.from_place, t.to_place, +t.km, t.purpose, round2(vals.get(t.id) || 0)])],
    receipts: [['Dato', 'Leverandør', 'Kategori', 'Beløb', 'Heraf moms', 'Note'], ...S.receipts.filter(r => r.status === 'approved' && (r.receipt_date || '').startsWith(y)).sort((a, b) => a.receipt_date.localeCompare(b.receipt_date)).map(r => [r.receipt_date, r.vendor, r.category, r.total, r.vat_amount, r.note])],
    invoices: [['Nr.', 'Dato', 'Kunde', 'Status', 'Forfald', 'Betalt', 'Beløb', 'Moms', 'I alt'], ...S.invoices.filter(i => i.issue_date.startsWith(y)).sort((a, b) => a.issue_date.localeCompare(b.issue_date)).map(i => [i.number, i.issue_date, i.customer_name, STATUS_TXT[i.status], i.due_date, i.paid_date || '', i.subtotal, i.vat_amount, i.total])],
    income: [['Dato', 'Kilde', 'Beløb', 'Heraf moms', 'Note'], ...S.income.filter(n => n.income_date.startsWith(y)).sort((a, b) => a.income_date.localeCompare(b.income_date)).map(n => [n.income_date, n.source, n.amount, n.vat_amount, n.note])],
  };
  const cell = v => {
    const t = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const csv = '\ufeff' + sets[kind].map(r => r.map(cell).join(';')).join('\r\n');
  const names = { trips: 'korsel', receipts: 'bilag', invoices: 'fakturaer', income: 'indtaegter' };
  return shareBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${names[kind]}-${y}.csv`, 'text/csv');
}

/* ═════════════ Login ═════════════ */
function renderAuth(msg = '') {
  $('#tabs').hidden = true;
  $('#view').innerHTML = html`<form class="auth" id="authForm">
    <h1>Regnskab</h1><p>Log ind for at se din kørsel, dine bilag og fakturaer.</p>
    <label>E-mail<input name="email" type="email" autocomplete="username" inputmode="email" required></label>
    <label>Adgangskode<input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
    <button class="btn primary" type="submit">Log ind</button>
    <div class="err" id="authErr">${msg}</div></form>`.s;
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
    if (error) $('#authErr').textContent = error.message === 'Invalid login credentials' ? 'Forkert e-mail eller adgangskode.' : error.message;
    else boot();
  });
}
function renderSetup() {
  $('#view').innerHTML = html`<div class="auth"><h1>Næsten klar</h1><p>Åbn <code>config.js</code> og indsæt din Supabase-adresse og anon-nøgle. Trin for trin står i README.</p></div>`.s;
}

/* ═════════════ Render og events ═════════════ */
function render() {
  if (!S.user) return;
  const v = { overblik: vOverblik, korsel: vKorsel, bilag: vBilag, salg: vSalg, mere: vMere }[S.tab]();
  $('#view').innerHTML = v.s;
  $('#tabs').hidden = false;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
}
function go(tab) { S.tab = tab; render(); window.scrollTo(0, 0); }

const byId = (list, id) => list.find(x => x.id === id);
const ACTIONS = {
  tab: d => go(d.tab),
  goBilag: () => go('bilag'),
  yearPrev: () => { S.year--; render(); },
  yearNext: () => { if (S.year < new Date().getFullYear()) { S.year++; render(); } },
  closeSheet, closeViewer: () => $('.viewer')?.remove(),
  salgView: d => { S.salgView = d.v; render(); },

  logRoute: d => logRoute(d.id),
  newTrip: () => tripSheet(null),
  editTrip: d => tripSheet(byId(S.trips, d.id)),
  delTrip: async d => { must(await sb.from('trips').delete().eq('id', d.id)); closeSheet(); await refresh(); toast('Tur slettet'); },
  newRoute: () => routeSheet(null),
  editRoute: d => routeSheet(byId(S.routes, d.id)),
  delRoute: async d => { must(await sb.from('routes').delete().eq('id', d.id)); closeSheet(); await refresh(); },

  pickCam: () => $('#fileCam').click(),
  pickFile: () => $('#fileAny').click(),
  editReceipt: d => receiptSheet(byId(S.receipts, d.id)),
  viewFile: async d => {
    const r = byId(S.receipts, d.id);
    const { data, error } = await sb.storage.from('receipts').createSignedUrl(r.file_path, 600);
    if (error) return toast(error.message, { err: true });
    openViewer(data.signedUrl, r.mime);
  },
  delReceipt: async d => {
    if (!confirm('Slette dette bilag? Det kan ikke fortrydes.')) return;
    const r = byId(S.receipts, d.id);
    if (r.file_path) await sb.storage.from('receipts').remove([r.file_path]);
    must(await sb.from('receipts').delete().eq('id', d.id));
    closeSheet(); await refresh(); toast('Bilag slettet');
  },

  newInvoice: () => invoiceSheet(null),
  openInvoice: d => invoiceDetail(byId(S.invoices, d.id)),
  editInvoice: d => invoiceSheet(byId(S.invoices, d.id)),
  addLine: () => { const el = document.createElement('div'); el.innerHTML = lineHtml().s; $('#lines').append(el.firstElementChild); $$('.l-desc').pop().focus(); },
  rmLine: (d, el) => { if ($$('.line').length > 1) { el.closest('.line').remove(); $('.sheet').dispatchEvent(new Event('input')); } },
  saveSend: (d, el) => saveInvoice(el.closest('form'), byId(S.invoices, el.closest('form').dataset.invoice), true).catch(e => toast(e.message, { err: true })),
  sharePdf: async d => { try { await shareInvoice(byId(S.invoices, d.id)); } catch (e) { toast(e.message, { err: true }); } },
  markSent: async d => { must(await sb.from('invoices').update({ status: 'sent', sent_date: todayISO() }).eq('id', d.id)); closeSheet(); await refresh(); toast('Markeret som sendt'); },
  markPaid: d => paidSheet(byId(S.invoices, d.id)),
  cancelInvoice: async d => { if (!confirm('Annullere fakturaen? Den bevares i regnskabet, men tæller ikke med.')) return; must(await sb.from('invoices').update({ status: 'cancelled' }).eq('id', d.id)); closeSheet(); await refresh(); toast('Faktura annulleret'); },
  delInvoice: async d => { if (!confirm('Slette kladden?')) return; must(await sb.from('invoices').delete().eq('id', d.id)); closeSheet(); await refresh(); toast('Kladde slettet'); },

  newIncome: () => incomeSheet(null),
  editIncome: d => incomeSheet(byId(S.income, d.id)),
  delIncome: async d => { must(await sb.from('income').delete().eq('id', d.id)); closeSheet(); await refresh(); },

  editSettings: settingsSheet,
  exportCsv: d => exportCsv(d.k),
  copyUrl: async () => { try { await navigator.clipboard.writeText(FN_URL); toast('Adressen er kopieret'); } catch { toast('Kunne ikke kopiere. Mærk teksten og kopiér selv.', { err: true }); } },
  signOut: async () => { await sb.auth.signOut(); S.user = null; renderAuth(); },
};

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  try { await fn(el.dataset, el, e); } catch (err) { console.error(err); toast(err.message || String(err), { err: true }); }
});

for (const id of ['fileCam', 'fileAny']) {
  document.addEventListener('change', e => {
    if (e.target.id !== id || !e.target.files.length) return;
    const files = [...e.target.files];
    e.target.value = '';
    uploadFiles(files);
  });
}
window.addEventListener('online', flushQueue);

/* ═════════════ Start ═════════════ */
async function boot() {
  if (!configured) return renderSetup();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderAuth();
  S.user = session.user;
  await refresh();
  flushQueue();
  setTimeout(() => navigator.onLine && loadJsPdf().catch(() => {}), 4000);
}
if (sb) sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') { S.user = null; renderAuth(); } });
boot();

export { html, calc, tripValues, parseNum, invoiceTotals };
