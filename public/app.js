(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Constantes y utilidades
  // ---------------------------------------------------------------------

  const API_URL = '/api';
  const PHOTO_URL = '/photo';
  const DEVICE_KEY = 'gc_device_v1';

  const AVATAR_COLORS = [
    '#e07a5f', '#3d5a80', '#8d5a97', '#2a9d8f', '#e9963e',
    '#577590', '#b5525c', '#43aa8b', '#9b5de5', '#f4845f',
  ];

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function avatarColor(idOrName) {
    return AVATAR_COLORS[hashStr(String(idOrName)) % AVATAR_COLORS.length];
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 1).toUpperCase();
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatMoney(cents) {
    const n = (cents || 0) / 100;
    return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '');
  }

  function todayStr() {
    const d = new Date();
    const tz = d.getTimezoneOffset();
    return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
  }

  function euroToCents(value) {
    const n = Number(String(value).replace(',', '.'));
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function centsToEuroInput(cents) {
    return (cents / 100).toFixed(2);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------------------------------------------------------------------
  // Almacenamiento local del dispositivo
  // ---------------------------------------------------------------------

  function loadDevice() {
    try {
      const raw = localStorage.getItem(DEVICE_KEY);
      if (!raw) return { groups: [] };
      const parsed = JSON.parse(raw);
      if (!parsed.groups) parsed.groups = [];
      return parsed;
    } catch (e) {
      return { groups: [] };
    }
  }

  function saveDevice(device) {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); } catch (e) { /* ignore */ }
  }

  function rememberGroup(code, memberId, memberName, groupName) {
    const device = loadDevice();
    const existing = device.groups.find((g) => g.code === code);
    if (existing) {
      existing.memberId = memberId;
      existing.memberName = memberName;
      existing.groupName = groupName;
    } else {
      device.groups.unshift({ code, memberId, memberName, groupName });
    }
    saveDevice(device);
  }

  function forgetGroup(code) {
    const device = loadDevice();
    device.groups = device.groups.filter((g) => g.code !== code);
    saveDevice(device);
  }

  // ---------------------------------------------------------------------
  // Llamadas a la API
  // ---------------------------------------------------------------------

  async function apiPost(action, data) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...data }),
    });
    let body;
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok) throw new Error(body.error || 'Ha ocurrido un error');
    return body;
  }

  async function apiGetGroup(code) {
    const res = await fetch(`${API_URL}?code=${encodeURIComponent(code)}`);
    let body;
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok) throw new Error(body.error || 'Ha ocurrido un error');
    return body.group;
  }

  async function uploadPhoto(code, base64) {
    const body = await apiPostRaw(PHOTO_URL, { groupCode: code, imageBase64: base64 });
    return body.photoKey;
  }

  async function apiPostRaw(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    let body;
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok) throw new Error(body.error || 'Ha ocurrido un error');
    return body;
  }

  // ---------------------------------------------------------------------
  // Cálculo de saldos (deudas netas entre miembros)
  // ---------------------------------------------------------------------

  function computeLedger(group) {
    const net = {};
    const ensure = (a, b) => {
      net[a] = net[a] || {};
      net[b] = net[b] || {};
      if (net[a][b] === undefined) net[a][b] = 0;
      if (net[b][a] === undefined) net[b][a] = 0;
    };
    function addDebt(debtor, creditor, amount) {
      if (debtor === creditor || !amount) return;
      ensure(debtor, creditor);
      net[debtor][creditor] += amount;
      net[creditor][debtor] -= amount;
    }
    for (const e of group.expenses || []) {
      for (const s of e.splits || []) {
        if (s.memberId !== e.paidBy) addDebt(s.memberId, e.paidBy, s.amount);
      }
    }
    for (const p of group.payments || []) {
      addDebt(p.toMemberId, p.fromMemberId, p.amount);
    }
    return net;
  }

  function netBetween(net, a, b) {
    if (!net[a] || net[a][b] === undefined) return 0;
    return net[a][b];
  }

  function memberBalances(group, meId) {
    const net = computeLedger(group);
    const perMember = [];
    let totalOwedToMe = 0;
    let totalIOwe = 0;
    for (const m of group.members) {
      if (m.id === meId) continue;
      const amount = netBetween(net, meId, m.id); // >0: yo debo a m; <0: m me debe
      if (amount > 0) totalIOwe += amount;
      if (amount < 0) totalOwedToMe += -amount;
      perMember.push({ member: m, amount });
    }
    return { perMember, totalOwedToMe, totalIOwe, net };
  }

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------

  const state = {
    screen: 'loading',
    device: loadDevice(),
    code: null,
    meId: null,
    group: null,
    groupTab: 'saldos',
    activityFilter: 'all',
    error: null,
    busy: false,
    pollTimer: null,
    prefillJoinCode: null,
  };

  let draft = null; // borrador del formulario de gasto/pago en curso

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function setError(msg) {
    state.error = msg;
    render();
    if (msg) toast(msg);
  }

  // ---------------------------------------------------------------------
  // Navegación
  // ---------------------------------------------------------------------

  function goHome() {
    stopPolling();
    state.screen = 'home';
    state.code = null;
    state.meId = null;
    state.group = null;
    state.error = null;
    history.replaceState(null, '', location.pathname);
    render();
  }

  async function openGroup(code, meId) {
    state.error = null;
    state.busy = true;
    render();
    try {
      const group = await apiGetGroup(code);
      state.code = code;
      state.meId = meId;
      state.group = group;
      state.groupTab = 'saldos';
      state.activityFilter = 'all';
      state.screen = 'group';
      state.busy = false;
      render();
      startPolling();
    } catch (err) {
      state.busy = false;
      state.screen = 'home';
      render();
      toast(err.message);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && state.screen === 'group' && state.code) {
        refreshGroup(true);
      }
    }, 7000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function refreshGroup(silent) {
    if (!state.code) return;
    try {
      const group = await apiGetGroup(state.code);
      state.group = group;
      if (state.screen === 'group') render();
    } catch (err) {
      if (!silent) toast(err.message);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.screen === 'group') {
      refreshGroup(true);
    }
  });

  // ---------------------------------------------------------------------
  // Render principal
  // ---------------------------------------------------------------------

  function render() {
    if (state.screen === 'loading') return renderLoading();
    if (state.screen === 'home') return renderHome();
    if (state.screen === 'create') return renderCreate();
    if (state.screen === 'join') return renderJoin();
    if (state.screen === 'group') return renderGroupScreen();
    if (state.screen === 'addExpense') return renderAddExpense();
    if (state.screen === 'settle') return renderSettle();
    if (state.screen === 'settings') return renderSettings();
    if (state.screen === 'addMember') return renderAddMember();
  }

  function renderLoading() {
    app.innerHTML = `
      <div class="center-col">
        <div class="spinner"></div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: inicio / mis grupos
  // ---------------------------------------------------------------------

  function renderHome() {
    const groups = state.device.groups;
    if (groups.length === 0) {
      app.innerHTML = `
        <div class="center-col">
          <div class="big-emoji">💶</div>
          <h1 style="margin:4px 0;">Gastos Compartidos</h1>
          <p class="hint" style="max-width:280px;">Reparte gastos con tu cuñado y tus amigos, y ve al momento quién debe qué a quién.</p>
          <div class="welcome-actions" style="width:100%;max-width:320px;margin-top:20px;">
            <button class="btn btn-primary btn-block" data-action="show-create">➕ Crear un grupo nuevo</button>
            <button class="btn btn-outline btn-block" data-action="show-join">🔑 Unirme con un código</button>
          </div>
        </div>`;
      return;
    }

    const rows = groups.map((g) => `
      <button class="list-row" style="width:100%;text-align:left;border:none;" data-action="open-group" data-code="${g.code}" data-member="${g.memberId}">
        <div class="avatar" style="background:${avatarColor(g.code)}">${escapeHtml(initials(g.groupName || g.code))}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(g.groupName || 'Grupo')}</div>
          <div class="row-sub">Código ${g.code} · ${escapeHtml(g.memberName)}</div>
        </div>
        <div class="row-right">›</div>
      </button>`).join('');

    app.innerHTML = `
      <div class="hero">
        <div class="hero-top">
          <div></div>
          <h1 style="margin:0;font-size:20px;">Tus grupos</h1>
          <div></div>
        </div>
      </div>
      <div class="section screen-pad-bottom">
        <div class="card">${rows}</div>
        <div class="btn-row" style="margin-top:16px;">
          <button class="btn btn-secondary" style="flex:1;" data-action="show-create">➕ Nuevo grupo</button>
          <button class="btn btn-secondary" style="flex:1;" data-action="show-join">🔑 Unirme</button>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: crear grupo
  // ---------------------------------------------------------------------

  function renderCreate() {
    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="go-home">←</button>
        <h2>Crear grupo</h2>
      </div>
      <div class="section">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
        <form data-form="create">
          <div class="field">
            <label>Nombre del grupo</label>
            <input type="text" name="groupName" placeholder="Ej. Amigos, Piso, Viaje..." required maxlength="40" />
          </div>
          <div class="field">
            <label>Tu nombre</label>
            <input type="text" name="memberName" placeholder="¿Cómo te llamas?" required maxlength="30" />
          </div>
          <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Creando…' : 'Crear grupo'}
          </button>
        </form>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: unirse a grupo
  // ---------------------------------------------------------------------

  function renderJoin() {
    const codeVal = state.prefillJoinCode || '';
    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="go-home">←</button>
        <h2>Unirme a un grupo</h2>
      </div>
      <div class="section">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
        <form data-form="join">
          <div class="field">
            <label>Código del grupo</label>
            <input type="text" name="groupCode" placeholder="Ej. AB3XZ9" required maxlength="8"
              style="text-transform:uppercase;letter-spacing:0.08em;font-weight:700;" value="${escapeHtml(codeVal)}" />
          </div>
          <div class="field">
            <label>Tu nombre</label>
            <input type="text" name="memberName" placeholder="¿Cómo te llamas?" required maxlength="30" />
          </div>
          <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Entrando…' : 'Unirme'}
          </button>
        </form>
        <p class="hint">Pide el código a quien creó el grupo, o abre el enlace que te haya compartido.</p>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: grupo (saldos + actividad)
  // ---------------------------------------------------------------------

  function renderGroupScreen() {
    const group = state.group;
    if (!group) return renderLoading();
    const { perMember, totalOwedToMe, totalIOwe } = memberBalances(group, state.meId);

    const balanceRows = perMember.length === 0
      ? `<div class="empty"><div class="big-emoji">🙂</div>Todavía no hay nadie más en este grupo.</div>`
      : perMember.map((row) => {
          const m = row.member;
          let label, cls;
          if (row.amount < 0) { label = `te debe ${formatMoney(-row.amount)}`; cls = 'amount-owed'; }
          else if (row.amount > 0) { label = `le debes ${formatMoney(row.amount)}`; cls = 'amount-owe'; }
          else { label = 'en paz'; cls = 'amount-neutral'; }
          return `
            <div class="list-row">
              <div class="avatar" style="background:${avatarColor(m.id)}">${escapeHtml(initials(m.name))}</div>
              <div class="row-main">
                <div class="row-title">${escapeHtml(m.name)}</div>
                <div class="row-sub ${cls}">${label}</div>
              </div>
              ${row.amount !== 0 ? `<button class="btn btn-secondary btn-sm" data-action="open-settle" data-member="${m.id}">Liquidar</button>` : ''}
            </div>`;
        }).join('');

    const activity = buildActivityList(group);
    const filterChips = ['all', ...group.members.map((m) => m.id)].map((f) => {
      const label = f === 'all' ? 'Todos' : escapeHtml(group.members.find((m) => m.id === f).name);
      return `<button class="filter-chip ${state.activityFilter === f ? 'active' : ''}" data-action="set-filter" data-filter="${f}">${label}</button>`;
    }).join('');

    const filteredActivity = activity.filter((item) => {
      if (state.activityFilter === 'all') return true;
      return item.involves.includes(state.activityFilter);
    });

    const activityRows = filteredActivity.length === 0
      ? `<div class="empty"><div class="big-emoji">🧾</div>Todavía no hay movimientos.</div>`
      : filteredActivity.map(renderActivityRow).join('');

    app.innerHTML = `
      <div class="hero">
        <div class="hero-top">
          <button class="icon-btn" data-action="go-home">←</button>
          <h1 style="margin:0;">${escapeHtml(group.name)}</h1>
          <button class="icon-btn" data-action="open-settings">⚙️</button>
        </div>
        <div class="sub">Código ${group.code} · ${group.members.length} persona${group.members.length === 1 ? '' : 's'}</div>
        <div class="totals">
          <div class="total-chip">
            <div class="label">Te deben en total</div>
            <div class="value">${formatMoney(totalOwedToMe)}</div>
          </div>
          <div class="total-chip">
            <div class="label">Debes en total</div>
            <div class="value">${formatMoney(totalIOwe)}</div>
          </div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab ${state.groupTab === 'saldos' ? 'active' : ''}" data-action="set-tab" data-tab="saldos">Saldos</button>
        <button class="tab ${state.groupTab === 'actividad' ? 'active' : ''}" data-action="set-tab" data-tab="actividad">Actividad</button>
      </div>

      ${state.groupTab === 'saldos' ? `
        <div class="section screen-pad-bottom">
          <div class="card">${balanceRows}</div>
          <button class="btn btn-secondary btn-block" style="margin-top:14px;" data-action="show-add-member">➕ Añadir a alguien al grupo</button>
        </div>
      ` : `
        <div class="filter-scroll">${filterChips}</div>
        <div class="section screen-pad-bottom" style="padding-top:0;">
          <div class="card">${activityRows}</div>
        </div>
      `}

      <div class="fab">
        <button class="btn btn-primary" data-action="show-add-expense">🧾  Añadir gasto</button>
      </div>`;
  }

  function buildActivityList(group) {
    const items = [];
    for (const e of group.expenses || []) {
      const payer = group.members.find((m) => m.id === e.paidBy);
      items.push({
        type: 'expense',
        date: e.date,
        createdAt: e.createdAt,
        id: e.id,
        title: e.description,
        sub: `${payer ? payer.name : '?'} pagó`,
        amount: e.amount,
        photoKey: e.photoKey,
        involves: [e.paidBy, ...e.splits.map((s) => s.memberId)],
      });
    }
    for (const p of group.payments || []) {
      const from = group.members.find((m) => m.id === p.fromMemberId);
      const to = group.members.find((m) => m.id === p.toMemberId);
      items.push({
        type: 'payment',
        date: p.date,
        createdAt: p.createdAt,
        id: p.id,
        title: `${from ? from.name : '?'} pagó a ${to ? to.name : '?'}`,
        sub: 'Liquidación',
        amount: p.amount,
        involves: [p.fromMemberId, p.toMemberId],
      });
    }
    items.sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
    return items;
  }

  function renderActivityRow(item) {
    const icon = item.type === 'expense' ? '🧾' : '💸';
    const photoBtn = item.photoKey
      ? `<button class="btn btn-secondary btn-sm" data-action="view-photo" data-key="${escapeHtml(item.photoKey)}" style="margin-top:6px;">📷 Ver foto</button>`
      : '';
    const delAction = item.type === 'expense' ? 'delete-expense' : 'delete-payment';
    return `
      <div class="list-row" style="align-items:flex-start;">
        <div class="avatar" style="background:var(--teal-light);color:var(--teal-dark);font-size:18px;">${icon}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(item.title)}</div>
          <div class="row-sub">${escapeHtml(item.sub)} · ${formatDate(item.date)}</div>
          ${photoBtn}
        </div>
        <div class="row-right">
          <div class="row-title">${formatMoney(item.amount)}</div>
          <button class="btn-danger-text btn-sm" data-action="${delAction}" data-id="${escapeHtml(item.id)}">Eliminar</button>
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: añadir miembro manualmente
  // ---------------------------------------------------------------------

  function renderAddMember() {
    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <h2>Añadir persona</h2>
      </div>
      <div class="section">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
        <p class="hint">Puedes añadir a alguien aunque todavía no tenga la app instalada, solo para repartir gastos con esa persona. Si más adelante se une con el código del grupo escribiendo el mismo nombre, se conectará con esta misma persona.</p>
        <form data-form="addMember">
          <div class="field">
            <label>Nombre</label>
            <input type="text" name="memberName" placeholder="Nombre de la persona" required maxlength="30" />
          </div>
          <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>Añadir</button>
        </form>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: ajustes del grupo
  // ---------------------------------------------------------------------

  function renderSettings() {
    const group = state.group;
    const link = `${location.origin}/?join=${group.code}`;
    const memberRows = group.members.map((m) => `
      <div class="list-row">
        <div class="avatar" style="background:${avatarColor(m.id)}">${escapeHtml(initials(m.name))}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(m.name)}${m.id === state.meId ? ' (tú)' : ''}</div>
        </div>
      </div>`).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <h2>Ajustes del grupo</h2>
      </div>
      <div class="section">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

        <div class="section-title">Invitar</div>
        <div class="code-display">${group.code}</div>
        <div class="link-row">
          <input type="text" readonly value="${escapeHtml(link)}" />
          <button class="btn btn-secondary btn-sm" data-action="copy-link" data-link="${escapeHtml(link)}">Copiar</button>
        </div>
        <button class="btn btn-outline btn-block" style="margin-top:10px;" data-action="share-link" data-link="${escapeHtml(link)}">📤 Compartir enlace de invitación</button>

        <div class="section-title" style="margin-top:24px;">Nombre del grupo</div>
        <form data-form="rename">
          <div class="field" style="margin-bottom:8px;">
            <input type="text" name="groupName" value="${escapeHtml(group.name)}" maxlength="40" required />
          </div>
          <button class="btn btn-secondary btn-block" type="submit">Guardar nombre</button>
        </form>

        <div class="section-title" style="margin-top:24px;">Miembros</div>
        <div class="card">${memberRows}</div>

        <button class="btn btn-danger-text btn-block" style="margin-top:24px;" data-action="leave-group">Salir de este grupo (solo en este dispositivo)</button>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: añadir gasto
  // ---------------------------------------------------------------------

  function initExpenseDraft() {
    const group = state.group;
    draft = {
      description: '',
      amount: '',
      date: todayStr(),
      paidBy: state.meId,
      splitType: 'equal',
      participants: new Set(group.members.map((m) => m.id)),
      customAmounts: {},
      photoBase64: null,
      photoPreview: null,
    };
  }

  function renderAddExpense() {
    if (!draft) initExpenseDraft();
    const group = state.group;

    const payerOptions = group.members.map((m) =>
      `<option value="${m.id}" ${draft.paidBy === m.id ? 'selected' : ''}>${escapeHtml(m.name)}${m.id === state.meId ? ' (tú)' : ''}</option>`
    ).join('');

    const amountCents = euroToCents(draft.amount || 0);
    const participantIds = group.members.filter((m) => draft.participants.has(m.id)).map((m) => m.id);

    let splitRows = '';
    if (draft.splitType === 'equal') {
      splitRows = group.members.map((m) => `
        <div class="split-row">
          <input type="checkbox" data-role="participant" data-member="${m.id}" ${draft.participants.has(m.id) ? 'checked' : ''} />
          <div class="name">${escapeHtml(m.name)}</div>
        </div>`).join('');
    } else {
      splitRows = group.members.map((m) => {
        const checked = draft.participants.has(m.id);
        const val = draft.customAmounts[m.id] != null ? draft.customAmounts[m.id] : '';
        return `
        <div class="split-row">
          <input type="checkbox" data-role="participant" data-member="${m.id}" ${checked ? 'checked' : ''} />
          <div class="name">${escapeHtml(m.name)}</div>
          <input type="number" step="0.01" min="0" inputmode="decimal" data-role="custom-amount" data-member="${m.id}"
            value="${val}" placeholder="0,00" ${checked ? '' : 'disabled'} />
        </div>`;
      }).join('');
    }

    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <h2>Nuevo gasto</h2>
      </div>
      <div class="section screen-pad-bottom">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
        <form data-form="expense">
          <div class="field">
            <label>¿Qué has comprado?</label>
            <input type="text" name="description" placeholder="Ej. Supermercado, cena, gasolina..." required maxlength="60" value="${escapeHtml(draft.description)}" />
          </div>
          <div class="field">
            <label>Importe (€)</label>
            <input type="number" step="0.01" min="0" inputmode="decimal" name="amount" placeholder="0,00" required value="${escapeHtml(draft.amount)}" />
          </div>
          <div class="field">
            <label>Fecha</label>
            <input type="date" name="date" value="${draft.date}" />
          </div>
          <div class="field">
            <label>¿Quién pagó?</label>
            <select name="paidBy">${payerOptions}</select>
          </div>

          <div class="field">
            <label>Foto del ticket (opcional)</label>
            <input type="file" accept="image/*" capture="environment" data-role="photo-input" />
            ${draft.photoPreview ? `<img src="${draft.photoPreview}" class="photo-preview" />` : ''}
          </div>

          <div class="field">
            <label>¿Cómo se reparte?</label>
            <div class="tabs" style="margin:0;">
              <button type="button" class="tab ${draft.splitType === 'equal' ? 'active' : ''}" data-action="set-split-type" data-type="equal">Partes iguales</button>
              <button type="button" class="tab ${draft.splitType === 'custom' ? 'active' : ''}" data-action="set-split-type" data-type="custom">Cantidades personalizadas</button>
            </div>
          </div>

          <div class="card" style="padding:6px 12px;">
            ${splitRows}
          </div>

          <div id="splitSummary"></div>

          <button class="btn btn-primary btn-block" type="submit" style="margin-top:18px;" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Guardando…' : 'Guardar gasto'}
          </button>
        </form>
      </div>`;

    updateSplitSummary();
  }

  function updateSplitSummary() {
    const el = document.getElementById('splitSummary');
    if (!el || !draft) return;
    const group = state.group;
    const amount = document.querySelector('form[data-form="expense"] input[name="amount"]');
    const amountCents = euroToCents(amount ? amount.value : draft.amount || 0);

    if (draft.splitType === 'equal') {
      const n = draft.participants.size;
      const each = n > 0 ? Math.floor(amountCents / n) : 0;
      el.innerHTML = `<div class="split-summary"><span>Cada uno paga</span><strong>${n > 0 ? formatMoney(each) : '—'}</strong></div>`;
    } else {
      let sum = 0;
      document.querySelectorAll('[data-role="custom-amount"]').forEach((input) => {
        const memberId = input.dataset.member;
        if (draft.participants.has(memberId)) sum += euroToCents(input.value || 0);
      });
      const remaining = amountCents - sum;
      const ok = remaining === 0;
      el.innerHTML = `<div class="split-summary ${ok ? 'ok' : 'bad'}"><span>${ok ? 'Reparto cuadrado' : (remaining > 0 ? 'Falta repartir' : 'Te has pasado')}</span><strong>${formatMoney(Math.abs(remaining))}</strong></div>`;
    }
  }

  // ---------------------------------------------------------------------
  // Pantalla: liquidar deuda
  // ---------------------------------------------------------------------

  function renderSettle() {
    const group = state.group;
    const other = group.members.find((m) => m.id === draft.otherId);
    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <h2>Liquidar con ${escapeHtml(other ? other.name : '')}</h2>
      </div>
      <div class="section">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}
        <form data-form="settle">
          <div class="field">
            <label>¿Quién paga?</label>
            <select name="fromMemberId">
              <option value="${state.meId}" ${draft.direction === 'i-pay' ? 'selected' : ''}>Tú</option>
              <option value="${other.id}" ${draft.direction === 'they-pay' ? 'selected' : ''}>${escapeHtml(other.name)}</option>
            </select>
          </div>
          <div class="field">
            <label>Importe (€)</label>
            <input type="number" step="0.01" min="0" inputmode="decimal" name="amount" value="${draft.amount}" required />
          </div>
          <button class="btn btn-primary btn-block" type="submit" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Guardando…' : 'Marcar como liquidado'}
          </button>
        </form>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Compresión de imágenes
  // ---------------------------------------------------------------------

  function compressImage(file, maxSize = 1280, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxSize) {
            height = Math.round(height * (maxSize / width));
            width = maxSize;
          } else if (height > maxSize) {
            width = Math.round(width * (maxSize / height));
            height = maxSize;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------
  // Manejadores de formularios
  // ---------------------------------------------------------------------

  async function handleCreateSubmit(form) {
    const groupName = form.groupName.value.trim();
    const memberName = form.memberName.value.trim();
    state.busy = true; state.error = null; render();
    try {
      const { group, memberId } = await apiPost('create_group', { groupName, memberName });
      rememberGroup(group.code, memberId, memberName, group.name);
      state.device = loadDevice();
      state.busy = false;
      await openGroup(group.code, memberId);
      toast('¡Grupo creado! Comparte el código con tu gente.');
    } catch (err) {
      state.busy = false;
      setError(err.message);
    }
  }

  async function handleJoinSubmit(form) {
    const groupCode = form.groupCode.value.trim().toUpperCase();
    const memberName = form.memberName.value.trim();
    state.busy = true; state.error = null; render();
    try {
      const { group, memberId } = await apiPost('join_group', { groupCode, memberName });
      rememberGroup(group.code, memberId, memberName, group.name);
      state.device = loadDevice();
      state.busy = false;
      state.prefillJoinCode = null;
      await openGroup(group.code, memberId);
    } catch (err) {
      state.busy = false;
      setError(err.message);
    }
  }

  async function handleAddMemberSubmit(form) {
    const memberName = form.memberName.value.trim();
    state.busy = true; state.error = null; render();
    try {
      const { group } = await apiPost('add_member', { groupCode: state.code, memberName });
      state.group = group;
      state.busy = false;
      state.screen = 'group';
      state.groupTab = 'saldos';
      render();
    } catch (err) {
      state.busy = false;
      setError(err.message);
    }
  }

  async function handleRenameSubmit(form) {
    const groupName = form.groupName.value.trim();
    try {
      const { group } = await apiPost('rename_group', { groupCode: state.code, groupName });
      state.group = group;
      const device = loadDevice();
      const g = device.groups.find((x) => x.code === state.code);
      if (g) { g.groupName = group.name; saveDevice(device); state.device = device; }
      toast('Nombre actualizado');
      render();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleExpenseSubmit(form) {
    const description = form.description.value.trim();
    const amountCents = euroToCents(form.amount.value);
    const date = form.date.value || todayStr();
    const paidBy = form.paidBy.value;
    const group = state.group;

    let splits = [];
    if (draft.splitType === 'equal') {
      const ids = group.members.filter((m) => draft.participants.has(m.id)).map((m) => m.id);
      if (ids.length === 0) return setError('Selecciona al menos una persona en el reparto');
      const base = Math.floor(amountCents / ids.length);
      let remainder = amountCents - base * ids.length;
      splits = ids.map((id, idx) => ({ memberId: id, amount: base + (idx < remainder ? 1 : 0) }));
    } else {
      const ids = group.members.filter((m) => draft.participants.has(m.id)).map((m) => m.id);
      if (ids.length === 0) return setError('Selecciona al menos una persona en el reparto');
      let sum = 0;
      splits = ids.map((id) => {
        const input = document.querySelector(`[data-role="custom-amount"][data-member="${id}"]`);
        const cents = euroToCents(input ? input.value : 0);
        sum += cents;
        return { memberId: id, amount: cents };
      });
      if (sum !== amountCents) return setError('El reparto personalizado no cuadra con el importe total');
    }

    state.busy = true; state.error = null; render();
    try {
      let photoKey = null;
      if (draft.photoBase64) {
        photoKey = await uploadPhoto(state.code, draft.photoBase64);
      }
      const { group: updated } = await apiPost('add_expense', {
        groupCode: state.code,
        expense: { description, amount: amountCents, paidBy, date, splitType: draft.splitType, splits, photoKey },
      });
      state.group = updated;
      state.busy = false;
      draft = null;
      state.screen = 'group';
      state.groupTab = 'actividad';
      render();
      toast('Gasto añadido');
    } catch (err) {
      state.busy = false;
      setError(err.message);
    }
  }

  async function handleSettleSubmit(form) {
    const fromMemberId = form.fromMemberId.value;
    const toMemberId = fromMemberId === state.meId ? draft.otherId : state.meId;
    const amountCents = euroToCents(form.amount.value);
    if (amountCents <= 0) return setError('Introduce un importe válido');

    state.busy = true; state.error = null; render();
    try {
      const { group } = await apiPost('add_payment', {
        groupCode: state.code,
        payment: { fromMemberId, toMemberId, amount: amountCents, date: todayStr() },
      });
      state.group = group;
      state.busy = false;
      draft = null;
      state.screen = 'group';
      render();
      toast('Deuda liquidada');
    } catch (err) {
      state.busy = false;
      setError(err.message);
    }
  }

  async function deleteExpense(id) {
    try {
      const { group } = await apiPost('delete_expense', { groupCode: state.code, expenseId: id });
      state.group = group;
      render();
      toast('Gasto eliminado');
    } catch (err) {
      toast(err.message);
    }
  }

  async function deletePayment(id) {
    try {
      const { group } = await apiPost('delete_payment', { groupCode: state.code, paymentId: id });
      state.group = group;
      render();
      toast('Liquidación eliminada');
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Delegación de eventos
  // ---------------------------------------------------------------------

  app.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'go-home') return goHome();
    if (action === 'show-create') { state.screen = 'create'; state.error = null; return render(); }
    if (action === 'show-join') { state.screen = 'join'; state.error = null; return render(); }
    if (action === 'open-group') return openGroup(target.dataset.code, target.dataset.member);
    if (action === 'back-to-group') { state.screen = 'group'; state.error = null; draft = null; return render(); }
    if (action === 'open-settings') { state.screen = 'settings'; state.error = null; return render(); }
    if (action === 'set-tab') { state.groupTab = target.dataset.tab; return render(); }
    if (action === 'set-filter') { state.activityFilter = target.dataset.filter; return render(); }
    if (action === 'show-add-expense') { draft = null; state.screen = 'addExpense'; state.error = null; return render(); }
    if (action === 'show-add-member') { state.screen = 'addMember'; state.error = null; return render(); }

    if (action === 'open-settle') {
      const memberId = target.dataset.member;
      const { net } = memberBalances(state.group, state.meId);
      const amount = Math.abs(netBetween(net, state.meId, memberId));
      const iOwe = netBetween(net, state.meId, memberId) > 0;
      draft = { otherId: memberId, amount: centsToEuroInput(amount), direction: iOwe ? 'i-pay' : 'they-pay' };
      state.screen = 'settle';
      state.error = null;
      return render();
    }

    if (action === 'set-split-type') {
      draft.splitType = target.dataset.type;
      return renderAddExpense();
    }

    if (action === 'delete-expense') {
      if (confirm('¿Eliminar este gasto?')) deleteExpense(target.dataset.id);
      return;
    }
    if (action === 'delete-payment') {
      if (confirm('¿Eliminar esta liquidación?')) deletePayment(target.dataset.id);
      return;
    }

    if (action === 'copy-link') {
      navigator.clipboard?.writeText(target.dataset.link).then(() => toast('Enlace copiado'));
      return;
    }
    if (action === 'share-link') {
      const link = target.dataset.link;
      if (navigator.share) {
        navigator.share({ title: 'Únete a nuestro grupo de gastos', text: `Únete a "${state.group.name}" con el código ${state.group.code}`, url: link }).catch(() => {});
      } else {
        navigator.clipboard?.writeText(link).then(() => toast('Enlace copiado'));
      }
      return;
    }

    if (action === 'leave-group') {
      if (confirm('¿Salir de este grupo en este dispositivo? No se borrarán los datos del grupo.')) {
        forgetGroup(state.code);
        state.device = loadDevice();
        goHome();
      }
      return;
    }

    if (action === 'view-photo') {
      window.open(`${PHOTO_URL}?key=${encodeURIComponent(target.dataset.key)}`, '_blank');
      return;
    }
  });

  app.addEventListener('change', (e) => {
    if (e.target.matches('[data-role="participant"]')) {
      const memberId = e.target.dataset.member;
      if (e.target.checked) draft.participants.add(memberId);
      else draft.participants.delete(memberId);
      return renderAddExpense();
    }
    if (e.target.matches('[data-role="photo-input"]')) {
      const file = e.target.files[0];
      if (!file) return;
      compressImage(file).then((dataUrl) => {
        draft.photoBase64 = dataUrl;
        draft.photoPreview = dataUrl;
        renderAddExpense();
      }).catch(() => toast('No se ha podido procesar la foto'));
      return;
    }
  });

  app.addEventListener('input', (e) => {
    if (e.target.matches('[data-role="custom-amount"]') || (e.target.name === 'amount' && draft)) {
      updateSplitSummary();
    }
  });

  app.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    const type = form.dataset.form;
    if (type === 'create') return handleCreateSubmit(form);
    if (type === 'join') return handleJoinSubmit(form);
    if (type === 'addMember') return handleAddMemberSubmit(form);
    if (type === 'rename') return handleRenameSubmit(form);
    if (type === 'expense') return handleExpenseSubmit(form);
    if (type === 'settle') return handleSettleSubmit(form);
  });

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------

  function init() {
    const params = new URLSearchParams(location.search);
    const joinCode = params.get('join');

    if (joinCode) {
      const existing = state.device.groups.find((g) => g.code === joinCode.toUpperCase());
      if (existing) {
        openGroup(existing.code, existing.memberId);
      } else {
        state.prefillJoinCode = joinCode.toUpperCase();
        state.screen = 'join';
        render();
      }
      return;
    }

    if (state.device.groups.length > 0) {
      state.screen = 'home';
      render();
    } else {
      state.screen = 'home';
      render();
    }
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  init();
})();
