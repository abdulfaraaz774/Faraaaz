'use strict';
/* SBK Facility Ops — front end (no build step, no framework). */
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { user: null, tz: 'Asia/Dubai', today: '', meta: { sites: [], checkpoints: [] } };
  const isManager = () => state.user && (state.user.role === 'admin' || state.user.role === 'supervisor');
  const isAdmin = () => state.user && state.user.role === 'admin';

  // ---------- api ----------
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'sbk-ops' }, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); } catch { throw Object.assign(new Error('No connection. Check your internet and try again.'), { status: 0 }); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { showLogin(); }
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
    return data;
  }

  // ---------- formatting ----------
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, ...opts });
  const fTime = (iso) => fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const fDateTime = (iso) => fmt({ day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  const fNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }));
  const siteName = (id) => (state.meta.sites.find((s) => s.id === id) || {}).name || '';
  const roleLabel = { admin: 'Admin', supervisor: 'Supervisor', staff: 'Staff' };

  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3200);
  }

  function tickClock() {
    const now = new Date();
    $('#clockTime').textContent = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
    $('#clockDate').textContent = fmt({ weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(now);
  }

  // ---------- device helpers ----------
  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
        () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
    });
  }
  function resizePhoto(file, max = 1280) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  // ---------- reusable bits ----------
  const siteOptions = (selected, { includeAll = false } = {}) =>
    (includeAll ? '<option value="">All sites</option>' : '') +
    state.meta.sites.filter((s) => s.active || s.id === selected)
      .map((s) => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const defaultSite = () => {
    const saved = Number(localStorage.getItem('sbk.site') || 0);
    return state.meta.sites.some((s) => s.id === saved && s.active) ? saved : (state.meta.sites.find((s) => s.active) || {}).id;
  };
  const rememberSite = (id) => { try { localStorage.setItem('sbk.site', String(id)); } catch {} };
  const photoField = (id = 'photo') => `
    <div class="field"><label>Photo (optional)</label>
      <div class="photo-pick">
        <input type="file" accept="image/*" capture="environment" id="${id}File">
        <img id="${id}Prev" alt="" hidden>
      </div>
    </div>`;
  function bindPhoto(id = 'photo') {
    const holder = { data: null };
    $(`#${id}File`).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      holder.data = null; $(`#${id}Prev`).hidden = true;
      if (!f) return;
      try { holder.data = await resizePhoto(f); $(`#${id}Prev`).src = holder.data; $(`#${id}Prev`).hidden = false; }
      catch (err) { toast(err.message, 'err'); }
    });
    return holder;
  }
  const thumb = (photo) => (photo ? `<img class="thumb" src="/uploads/${esc(photo)}" alt="photo" data-photo="${esc(photo)}" loading="lazy">` : '');
  async function submitting(form, fn) {
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; }
  }

  // ---------- views ----------
  const views = {};

  views.home = async (el) => {
    const d = await api('/api/dashboard');
    const p = d.patrols;
    el.innerHTML = `
      <div class="page-head"><div><h2>Good ${greeting()}, ${esc(state.user.name.split(' ')[0])}</h2>
        <div class="muted small">${isManager() ? 'Today across all sites' : 'Your activity today'}</div></div></div>
      <div class="tiles">
        <a class="tile green" href="#/attendance"><div class="k">On duty</div><div class="v">${d.onDuty.length}</div><div class="muted small">checked in now</div></a>
        <a class="tile" href="#/bins"><div class="k">Bins disposed</div><div class="v">${d.bins.bins}</div><div class="muted small">${d.bins.entries} entries</div></a>
        <a class="tile gold" href="#/meters"><div class="k">DEWA readings</div><div class="v">${d.meters.n}</div><div class="muted small">recorded today</div></a>
        <a class="tile ${p.issues ? 'red' : ''}" href="#/patrol"><div class="k">Patrol</div><div class="v">${p.cpDone}/${p.cpTotal}</div>
          <div class="muted small">checkpoints · ${p.issues || 0} issue${p.issues === 1 ? '' : 's'}</div></a>
      </div>
      <div class="grid two">
        <div class="card"><h3>On duty now</h3>
          ${d.onDuty.length ? `<ul class="list">${d.onDuty.map((r) => `<li><span>${esc(r.name)}<div class="meta">${esc(r.site || '')}</div></span><span class="pill green">since ${fTime(r.ts)}</span></li>`).join('')}</ul>`
            : '<p class="muted">Nobody is checked in.</p>'}
        </div>
        <div class="card"><h3>Patrol issues today</h3>
          ${d.issues.length ? `<ul class="list">${d.issues.map((r) => `<li><span>${esc(r.checkpoint || '')}<div class="meta">${esc(r.note || '')}</div></span><span class="meta">${fTime(r.ts)} · ${esc(r.staff)}</span></li>`).join('')}</ul>`
            : '<p class="muted">No issues reported.</p>'}
        </div>
      </div>`;
  };
  const greeting = () => { const h = Number(fmt({ hour: '2-digit', hour12: false }).format(new Date())); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; };

  views.attendance = async (el) => {
    const [{ last }, { rows }] = await Promise.all([api('/api/attendance/status'), api(`/api/attendance?from=${dayOffset(-6)}`)]);
    const inNow = last && last.type === 'in';
    el.innerHTML = `
      <div class="page-head"><h2>Attendance</h2></div>
      <form class="card punch" id="punchForm">
        <div class="state">${inNow ? `<span class="pill green">Checked in at ${fTime(last.ts)}</span>` : last ? `<span class="pill">Checked out at ${fTime(last.ts)}</span>` : '<span class="pill amber">Not checked in today</span>'}</div>
        <div class="field" style="text-align:left"><label for="aSite">Site</label><select id="aSite">${siteOptions(inNow ? last.site_id : defaultSite())}</select></div>
        <div class="field" style="text-align:left"><label for="aNote">Note (optional)</label><input id="aNote" maxlength="300"></div>
        <button class="btn big block ${inNow ? 'red' : 'green'}" type="submit">${inNow ? 'Check out' : 'Check in'}</button>
        <p class="muted small" style="margin-top:8px">Your location is attached when your phone allows it.</p>
      </form>
      <div class="card"><h3>${isManager() ? 'All staff — last 7 days' : 'My last 7 days'}</h3>${recordsTable('attendance', rows)}</div>`;
    $('#punchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(e.target, async () => {
        const loc = await getLocation();
        const site_id = Number($('#aSite').value) || null; rememberSite(site_id);
        await api('/api/attendance', { method: 'POST', body: { type: inNow ? 'out' : 'in', site_id, note: $('#aNote').value, ...(loc || {}) } });
        toast(inNow ? 'Checked out' : 'Checked in', 'ok'); render();
      });
    });
  };

  const BIN_TYPES = ['General waste', 'Recyclables', 'Food / organic', 'Cardboard', 'Glass', 'Bulky items', 'Garden waste', 'Hazardous'];
  views.bins = async (el) => {
    const { rows } = await api(`/api/bins?from=${dayOffset(-6)}`);
    el.innerHTML = `
      <div class="page-head"><h2>Bin disposal</h2></div>
      <form class="card" id="binForm">
        <div class="row">
          <div class="field"><label for="bSite">Site</label><select id="bSite">${siteOptions(defaultSite())}</select></div>
          <div class="field"><label for="bLoc">Location / bin room</label><input id="bLoc" maxlength="120" placeholder="e.g. Basement B1 bin room"></div>
        </div>
        <div class="row">
          <div class="field"><label for="bType">Waste type</label><select id="bType">${BIN_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="bCount">Number of bins</label><input id="bCount" type="number" inputmode="numeric" min="1" max="500" value="1" required></div>
        </div>
        ${photoField()}
        <div class="field"><label for="bNote">Note (optional)</label><textarea id="bNote" maxlength="500"></textarea></div>
        <button class="btn block" type="submit">Log disposal</button>
      </form>
      <div class="card"><h3>Last 7 days</h3>${recordsTable('bins', rows)}</div>`;
    const photo = bindPhoto();
    $('#binForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(e.target, async () => {
        const site_id = Number($('#bSite').value) || null; rememberSite(site_id);
        await api('/api/bins', { method: 'POST', body: { site_id, location: $('#bLoc').value, bin_type: $('#bType').value, bin_count: Number($('#bCount').value), note: $('#bNote').value, photo: photo.data } });
        toast('Disposal logged', 'ok'); render();
      });
    });
  };

  views.meters = async (el) => {
    const [{ rows }, { meters }] = await Promise.all([api('/api/meters?limit=50'), api('/api/meters/list')]);
    el.innerHTML = `
      <div class="page-head"><h2>DEWA meter readings</h2></div>
      <form class="card" id="meterForm">
        <div class="field"><label>Meter type</label>
          <div class="seg">
            <input type="radio" name="kind" id="kE" value="electricity" checked><label for="kE">⚡ Electricity</label>
            <input type="radio" name="kind" id="kW" value="water"><label for="kW">💧 Water</label>
          </div>
        </div>
        <div class="row">
          <div class="field"><label for="mNo">Meter number</label><input id="mNo" list="meterList" maxlength="60" required autocomplete="off"></div>
          <div class="field"><label for="mUnit">Unit / area</label><input id="mUnit" maxlength="60" placeholder="e.g. Flat 1204, Common area"></div>
        </div>
        <datalist id="meterList">${[...new Set(meters.map((m) => m.meter_no))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="row">
          <div class="field"><label for="mSite">Site</label><select id="mSite">${siteOptions(defaultSite())}</select></div>
          <div class="field"><label for="mRead">Reading</label><input id="mRead" type="number" inputmode="decimal" step="any" min="0" required></div>
        </div>
        <div id="mPrev" class="note" hidden></div>
        ${photoField()}
        <div class="field"><label for="mNote">Note (optional)</label><textarea id="mNote" maxlength="500"></textarea></div>
        <button class="btn block" type="submit">Save reading</button>
      </form>
      <div class="card"><h3>Recent readings</h3>${recordsTable('meters', rows)}</div>`;
    const photo = bindPhoto();
    let prev = null;
    const kind = () => $('input[name=kind]:checked').value;
    const showPrev = () => {
      const box = $('#mPrev');
      if (!prev) { box.hidden = true; return; }
      const r = Number($('#mRead').value);
      const diff = $('#mRead').value !== '' ? r - prev.reading : null;
      box.className = `note ${diff !== null && diff < 0 ? 'red' : ''}`;
      box.innerHTML = `Previous: <b>${fNum(prev.reading)}</b> on ${fDateTime(prev.ts)}` +
        (diff !== null ? ` · Consumption: <b>${fNum(diff)}</b> ${kind() === 'water' ? 'IG' : 'kWh'}${diff < 0 ? ' — lower than last reading!' : ''}` : '');
      box.hidden = false;
    };
    const lookup = async () => {
      const no = $('#mNo').value.trim();
      prev = null;
      if (no) {
        prev = (await api(`/api/meters/last?meter_no=${encodeURIComponent(no)}&kind=${kind()}`)).last;
        if (prev && !$('#mUnit').value && prev.unit) $('#mUnit').value = prev.unit;
        if (prev && prev.site_id) $('#mSite').value = prev.site_id;
      }
      showPrev();
    };
    $('#mNo').addEventListener('change', lookup);
    $$('input[name=kind]').forEach((r) => r.addEventListener('change', lookup));
    $('#mRead').addEventListener('input', showPrev);
    $('#meterForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const body = { kind: kind(), meter_no: $('#mNo').value, unit: $('#mUnit').value, site_id: Number($('#mSite').value) || null, reading: Number($('#mRead').value), note: $('#mNote').value, photo: photo.data };
      submitting(e.target, async () => {
        try { await api('/api/meters', { method: 'POST', body }); }
        catch (err) {
          if (err.status === 409 && confirm(`${err.message}\n\n(Meter replaced or reset?)`)) await api('/api/meters', { method: 'POST', body: { ...body, confirm_lower: true } });
          else throw err;
        }
        toast('Reading saved', 'ok'); render();
      });
    });
  };

  views.patrol = async (el) => {
    const site = defaultSite();
    const { rows } = await api(`/api/patrols?from=${state.today}&limit=500`);
    const draw = (siteId) => {
      const cps = state.meta.checkpoints.filter((c) => c.site_id === siteId && c.active);
      const doneMap = {};
      rows.forEach((r) => { if (!doneMap[r.checkpoint_id]) doneMap[r.checkpoint_id] = r; }); // rows are newest first
      $('#cpGrid').innerHTML = cps.length ? cps.map((c) => {
        const d = doneMap[c.id];
        return `<div class="cp ${d ? (d.status === 'issue' ? 'issue' : 'done') : ''}"><b>${esc(c.name)}</b><div class="meta small">${d ? `${d.status === 'issue' ? 'Issue' : 'Clear'} · ${fTime(d.ts)}` : 'Not visited'}</div></div>`;
      }).join('') : '<p class="muted">No checkpoints for this site. An admin can add them.</p>';
      $('#pCp').innerHTML = cps.map((c) => `<option value="${c.id}">${esc(c.name)}${doneMap[c.id] ? ' ✓' : ''}</option>`).join('');
      const next = cps.find((c) => !doneMap[c.id]);
      if (next) $('#pCp').value = next.id;
    };
    el.innerHTML = `
      <div class="page-head"><h2>Security patrol</h2></div>
      <div class="card">
        <div class="field"><label for="pSite">Site</label><select id="pSite">${siteOptions(site)}</select></div>
        <h3>Today's checkpoints</h3><div class="checklist" id="cpGrid"></div>
      </div>
      <form class="card" id="patrolForm">
        <div class="field"><label for="pCp">Checkpoint</label><select id="pCp" required></select></div>
        <div class="field"><label>Status</label>
          <div class="seg">
            <input type="radio" name="status" id="sC" value="clear" checked><label for="sC">✓ All clear</label>
            <input type="radio" name="status" id="sI" value="issue" class="issue"><label for="sI">⚠ Issue found</label>
          </div>
        </div>
        <div class="field"><label for="pNote">Note <span id="pNoteReq" hidden>(required)</span></label><textarea id="pNote" maxlength="500"></textarea></div>
        ${photoField()}
        <button class="btn block" type="submit">Log checkpoint</button>
      </form>
      <div class="card"><h3>Today's log</h3>${recordsTable('patrols', rows)}</div>`;
    draw(site);
    const photo = bindPhoto();
    $('#pSite').addEventListener('change', (e) => { rememberSite(Number(e.target.value)); draw(Number(e.target.value)); });
    $$('input[name=status]').forEach((r) => r.addEventListener('change', () => { $('#pNoteReq').hidden = $('input[name=status]:checked').value !== 'issue'; }));
    $('#patrolForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(e.target, async () => {
        const loc = await getLocation();
        await api('/api/patrols', { method: 'POST', body: { checkpoint_id: Number($('#pCp').value), status: $('input[name=status]:checked').value, note: $('#pNote').value, photo: photo.data, ...(loc || {}) } });
        toast('Checkpoint logged', 'ok'); render();
      });
    });
  };

  // records & reports (supervisor / admin)
  const MOD_LABEL = { attendance: 'Attendance', bins: 'Bin disposal', meters: 'DEWA meters', patrols: 'Security patrol' };
  views.records = async (el, params) => {
    if (!isManager()) { location.hash = '#/'; return; }
    const q = { mod: params.get('mod') || 'attendance', from: params.get('from') || dayOffset(-6), to: params.get('to') || state.today, site: params.get('site') || '', user: params.get('user') || '' };
    const { users } = await api('/api/users');
    const qs = new URLSearchParams({ from: q.from, to: q.to, site: q.site, user: q.user }).toString();
    const { rows } = await api(`/api/${q.mod}?${qs}&limit=1000`);
    el.innerHTML = `
      <div class="page-head"><h2>Records & reports</h2>
        <a class="btn gold sm" href="/api/export/${q.mod}.csv?${qs}" download>⬇ Download CSV</a></div>
      <form class="card filters" id="recForm">
        <div><label for="rMod">Module</label><select id="rMod">${Object.entries(MOD_LABEL).map(([k, v]) => `<option value="${k}" ${k === q.mod ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div><label for="rFrom">From</label><input id="rFrom" type="date" value="${q.from}"></div>
        <div><label for="rTo">To</label><input id="rTo" type="date" value="${q.to}"></div>
        <div><label for="rSite">Site</label><select id="rSite">${siteOptions(Number(q.site), { includeAll: true })}</select></div>
        <div><label for="rUser">Staff</label><select id="rUser"><option value="">All staff</option>${users.map((u) => `<option value="${u.id}" ${String(u.id) === q.user ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
        <div><button class="btn block" type="submit">Show</button></div>
      </form>
      <div class="card"><h3>${MOD_LABEL[q.mod]} <span class="muted small">· ${rows.length} record${rows.length === 1 ? '' : 's'}${rows.length === 1000 ? ' (first 1000 — use CSV for all)' : ''}</span></h3>
        ${recordsTable(q.mod, rows, { deletable: isAdmin() })}</div>`;
    $('#recForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new URLSearchParams({ mod: $('#rMod').value, from: $('#rFrom').value, to: $('#rTo').value, site: $('#rSite').value, user: $('#rUser').value });
      location.hash = `#/records?${p}`;
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b || !confirm('Delete this record permanently?')) return;
      try { await api(`/api/${q.mod}/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted', 'ok'); render(); } catch (err) { toast(err.message, 'err'); }
    });
  };

  function recordsTable(mod, rows, { deletable = false } = {}) {
    if (!rows.length) return '<p class="muted">No records yet.</p>';
    const staffCol = isManager();
    const cols = {
      attendance: [['Time', (r) => fDateTime(r.ts)], ...(staffCol ? [['Staff', (r) => esc(r.staff)]] : []), ['Site', (r) => esc(r.site || '')],
        ['Type', (r) => r.type === 'in' ? '<span class="pill green">IN</span>' : '<span class="pill">OUT</span>'],
        ['Location', (r) => r.lat ? `<a href="https://maps.google.com/?q=${r.lat},${r.lng}" target="_blank" rel="noopener">map</a> <span class="muted small">±${fNum(r.accuracy)}m</span>` : '—'],
        ['Note', (r) => esc(r.note || ''), 'wrap']],
      bins: [['Time', (r) => fDateTime(r.ts)], ...(staffCol ? [['Staff', (r) => esc(r.staff)]] : []), ['Site', (r) => esc(r.site || '')], ['Location', (r) => esc(r.location || '')],
        ['Type', (r) => esc(r.bin_type)], ['Bins', (r) => r.bin_count], ['Photo', (r) => thumb(r.photo)], ['Note', (r) => esc(r.note || ''), 'wrap']],
      meters: [['Time', (r) => fDateTime(r.ts)], ['Meter', (r) => `${r.kind === 'water' ? '💧' : '⚡'} ${esc(r.meter_no)}`], ['Unit', (r) => esc(r.unit || '')], ['Site', (r) => esc(r.site || '')],
        ['Reading', (r) => fNum(r.reading)], ['Used', (r) => r.consumption === null ? '<span class="muted">first</span>' : r.consumption < 0 ? `<span class="pill red">${fNum(r.consumption)}</span>` : fNum(r.consumption)],
        ...(staffCol ? [['By', (r) => esc(r.staff)]] : []), ['Photo', (r) => thumb(r.photo)], ['Note', (r) => esc(r.note || ''), 'wrap']],
      patrols: [['Time', (r) => fDateTime(r.ts)], ...(staffCol ? [['Guard', (r) => esc(r.staff)]] : []), ['Site', (r) => esc(r.site || '')], ['Checkpoint', (r) => esc(r.checkpoint || '')],
        ['Status', (r) => r.status === 'issue' ? '<span class="pill red">Issue</span>' : '<span class="pill green">Clear</span>'], ['Photo', (r) => thumb(r.photo)], ['Note', (r) => esc(r.note || ''), 'wrap']],
    }[mod];
    return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}${deletable ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c[2] || ''}">${c[1](r)}</td>`).join('')}${deletable ? `<td><button class="btn ghost sm" data-del="${r.id}" type="button">Delete</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  }

  views.admin = async (el) => {
    if (!isAdmin()) { location.hash = '#/'; return; }
    const { users } = await api('/api/users');
    await loadMeta();
    el.innerHTML = `
      <div class="page-head"><h2>Admin</h2></div>
      <div class="card"><h3>Staff accounts</h3>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td>
          <td><select data-role="${u.id}" style="min-height:34px;padding:4px 8px;width:auto;min-width:120px">${['staff', 'supervisor', 'admin'].map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${roleLabel[r]}</option>`).join('')}</select></td>
          <td>${u.active ? '<span class="pill green">Active</span>' : '<span class="pill">Disabled</span>'}</td>
          <td><div class="actions" style="flex-wrap:nowrap"><button class="btn ghost sm" type="button" data-reset="${u.id}">Reset password</button>
            <button class="btn ghost sm" type="button" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button></div></td></tr>`).join('')}
        </tbody></table></div>
        <div class="spacer"></div>
        <form id="userForm" class="filters">
          <div><label for="nuName">Full name</label><input id="nuName" required maxlength="80"></div>
          <div><label for="nuUser">Username</label><input id="nuUser" required pattern="[A-Za-z0-9._\\-]{3,40}" autocapitalize="none"></div>
          <div><label for="nuPass">Password</label><input id="nuPass" required minlength="8" type="text" autocomplete="new-password"></div>
          <div><label for="nuRole">Role</label><select id="nuRole"><option value="staff">Staff</option><option value="supervisor">Supervisor</option><option value="admin">Admin</option></select></div>
          <div><button class="btn block" type="submit">Add user</button></div>
        </form>
      </div>
      <div class="grid two">
        <div class="card"><h3>Sites / buildings</h3>
          <ul class="list">${state.meta.sites.map((s) => `<li><span>${esc(s.name)} ${s.active ? '' : '<span class="pill">hidden</span>'}</span>
            <span class="actions"><button class="btn ghost sm" type="button" data-rename-site="${s.id}">Rename</button><button class="btn ghost sm" type="button" data-site-toggle="${s.id}" data-active="${s.active}">${s.active ? 'Hide' : 'Show'}</button></span></li>`).join('')}</ul>
          <form id="siteForm" class="filters"><div><label for="nsName">New site</label><input id="nsName" required maxlength="80"></div><div><button class="btn block" type="submit">Add site</button></div></form>
        </div>
        <div class="card"><h3>Patrol checkpoints</h3>
          <ul class="list">${state.meta.checkpoints.map((c) => `<li><span>${esc(c.name)} <span class="meta">· ${esc(siteName(c.site_id))}</span> ${c.active ? '' : '<span class="pill">hidden</span>'}</span>
            <span class="actions"><button class="btn ghost sm" type="button" data-cp-toggle="${c.id}" data-active="${c.active}">${c.active ? 'Hide' : 'Show'}</button></span></li>`).join('')}</ul>
          <form id="cpForm" class="filters">
            <div><label for="ncSite">Site</label><select id="ncSite">${siteOptions(defaultSite())}</select></div>
            <div><label for="ncName">Checkpoint</label><input id="ncName" required maxlength="80"></div>
            <div><button class="btn block" type="submit">Add</button></div></form>
        </div>
      </div>`;
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, 'ok'); await loadMeta(); render(); } catch (e) { toast(e.message, 'err'); } };
    $('#userForm').addEventListener('submit', (e) => { e.preventDefault(); act(() => api('/api/users', { method: 'POST', body: { name: $('#nuName').value, username: $('#nuUser').value, password: $('#nuPass').value, role: $('#nuRole').value } }), 'User added'); });
    $('#siteForm').addEventListener('submit', (e) => { e.preventDefault(); act(() => api('/api/sites', { method: 'POST', body: { name: $('#nsName').value } }), 'Site added'); });
    $('#cpForm').addEventListener('submit', (e) => { e.preventDefault(); act(() => api('/api/checkpoints', { method: 'POST', body: { site_id: Number($('#ncSite').value), name: $('#ncName').value } }), 'Checkpoint added'); });
    el.addEventListener('change', (e) => { const s = e.target.closest('[data-role]'); if (s) act(() => api(`/api/users/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }), 'Role updated'); });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t) return;
      const d = t.dataset;
      if (d.reset) { const pw = prompt('New password (min 8 characters):'); if (pw) act(() => api(`/api/users/${d.reset}`, { method: 'PATCH', body: { password: pw } }), 'Password reset'); }
      else if (d.toggle) act(() => api(`/api/users/${d.toggle}`, { method: 'PATCH', body: { active: d.active !== '1' } }));
      else if (d.siteToggle) act(() => api(`/api/sites/${d.siteToggle}`, { method: 'PATCH', body: { active: d.active !== '1' } }));
      else if (d.cpToggle) act(() => api(`/api/checkpoints/${d.cpToggle}`, { method: 'PATCH', body: { active: d.active !== '1' } }));
      else if (d.renameSite) { const n = prompt('New site name:', siteName(Number(d.renameSite))); if (n) act(() => api(`/api/sites/${d.renameSite}`, { method: 'PATCH', body: { name: n } }), 'Renamed'); }
    });
  };

  views.me = async (el) => {
    el.innerHTML = `
      <div class="page-head"><h2>${esc(state.user.name)}</h2></div>
      <div class="card"><p>Signed in as <b>${esc(state.user.username)}</b> · <span class="pill gold">${roleLabel[state.user.role]}</span></p>
        <div class="actions">${isAdmin() ? '<a class="btn ghost" href="#/admin">Admin settings</a>' : ''}<button class="btn red" id="logoutBtn" type="button">Sign out</button></div></div>
      <form class="card" id="pwForm"><h3>Change password</h3>
        <div class="field"><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="pwNew">New password (min 8)</label><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required></div>
        <button class="btn" type="submit">Update password</button></form>`;
    $('#logoutBtn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); });
    $('#pwForm').addEventListener('submit', (e) => {
      e.preventDefault();
      submitting(e.target, async () => { await api('/api/me/password', { method: 'POST', body: { current: $('#pwCur').value, next: $('#pwNew').value } }); toast('Password updated', 'ok'); e.target.reset(); });
    });
  };

  // ---------- router / shell ----------
  const ICONS = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    attendance: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bins: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    meters: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
    patrol: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    records: '<path d="M5 4h14v16H5zM9 9h6M9 13h6M9 17h3"/>',
    me: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  };
  function drawTabs(active) {
    const tabs = [['home', 'Home'], ['attendance', 'Attend'], ['bins', 'Bins'], ['meters', 'DEWA'], ['patrol', 'Patrol'], ...(isManager() ? [['records', 'Records']] : []), ['me', 'Me']];
    $('#tabs').innerHTML = tabs.map(([k, l]) => `<a href="#/${k === 'home' ? '' : k}" class="${k === active || (active === 'admin' && k === 'me') ? 'active' : ''}" ${k === active ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>${l}</a>`).join('');
  }
  let renderSeq = 0;
  async function render() {
    if (!state.user) return;
    const [route, query] = (location.hash.replace(/^#\/?/, '') || 'home').split('?');
    const name = views[route] ? route : 'home';
    drawTabs(name);
    const el = $('#view');
    const seq = ++renderSeq;
    const fresh = el.cloneNode(false); el.replaceWith(fresh); // drops old delegated listeners
    fresh.innerHTML = '<p class="muted">Loading…</p>';
    try { await views[name](fresh, new URLSearchParams(query || '')); }
    catch (e) { if (seq === renderSeq && e.status !== 401) fresh.innerHTML = `<div class="note red">${esc(e.message)}</div><button class="btn ghost" type="button" id="retry">Retry</button>`; $('#retry', fresh)?.addEventListener('click', render); }
  }
  function dayOffset(n) {
    const [y, m, d] = state.today.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
  }
  async function loadMeta() { state.meta = await api('/api/meta'); }

  function showLogin() {
    state.user = null;
    $('#shell').hidden = true; $('#login').hidden = false;
    setTimeout(() => $('#lu').focus(), 0);
  }
  async function enter(user) {
    state.user = user;
    const me = await api('/api/me'); state.tz = me.tz; state.today = me.today;
    await loadMeta();
    $('#who').textContent = `${user.name} · ${roleLabel[user.role]}`;
    $('#login').hidden = true; $('#shell').hidden = false;
    tickClock(); render();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginErr'); err.hidden = true;
    const btn = $('button', e.target); btn.disabled = true;
    try {
      const { user } = await api('/api/login', { method: 'POST', body: { username: $('#lu').value, password: $('#lp').value } });
      $('#lp').value = '';
      await enter(user);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  });

  document.addEventListener('click', (e) => {
    const img = e.target.closest('[data-photo]');
    if (img) { $('#photoImg').src = `/uploads/${img.dataset.photo}`; $('#photoDlg').showModal(); }
  });
  $('#photoDlg').addEventListener('click', (e) => e.currentTarget.close());
  window.addEventListener('hashchange', render);
  setInterval(() => { if (state.user) tickClock(); }, 1000);
  // Refresh "today" after midnight so date filters stay right on devices left open.
  setInterval(async () => { if (state.user) { try { const me = await api('/api/me'); if (me.today !== state.today) { state.today = me.today; render(); } } catch {} } }, 5 * 60 * 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  api('/api/me').then((me) => enter(me.user)).catch(() => showLogin());
})();
