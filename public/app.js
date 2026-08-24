(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // Constantes y utilidades
  // ---------------------------------------------------------------------

  const API_URL = '/api';
  const PHOTO_URL = '/photo';
  const DEVICE_KEY = 'gc_device_v1';
  const VAPID_PUBLIC_KEY = 'BCBWOGVoj-8y2kz9P85eOsXjCrxHR9fYf2B3c4F0VVwe2ve6wIpaYHKw3BWIeTMc5DKiSaKKDtRGscvfrNDhoOs';

  // Convierte la clave pública VAPID (base64 "url-safe") al formato de bytes
  // que pide PushManager.subscribe().
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  const AVATAR_COLORS = [
    '#e07a5f', '#3d5a80', '#8d5a97', '#2a9d8f', '#e9963e',
    '#577590', '#b5525c', '#43aa8b', '#9b5de5', '#f4845f',
  ];

  const CATEGORIES = [
    { id: 'comida', label: 'Comida', emoji: '🍔', color: '#e07a5f' },
    { id: 'super', label: 'Súper', emoji: '🛒', color: '#2a9d8f' },
    { id: 'transporte', label: 'Transporte', emoji: '🚗', color: '#577590' },
    { id: 'ocio', label: 'Ocio', emoji: '🎉', color: '#9b5de5' },
    { id: 'casa', label: 'Casa', emoji: '🏠', color: '#e9963e' },
    { id: 'salud', label: 'Salud', emoji: '💊', color: '#e63946' },
    { id: 'viajes', label: 'Viajes', emoji: '✈️', color: '#118ab2' },
    { id: 'otros', label: 'Otros', emoji: '📦', color: '#8d5a97' },
  ];

  function getCategory(id) {
    return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
  }

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

  // Reparte `amountCents` a partes iguales entre `ids`, sin perder céntimos por redondeo.
  function equalSplit(ids, amountCents) {
    const n = ids.length;
    const base = Math.floor(amountCents / n);
    const remainder = amountCents - base * n;
    return ids.map((id, idx) => ({ memberId: id, amount: base + (idx < remainder ? 1 : 0) }));
  }

  // Avatar (foto si existe, si no iniciales de color).
  function avatarHtml(member, size) {
    size = size || 44;
    if (member.photoKey) {
      // "v" fuerza al navegador a pedir la foto de nuevo cuando cambia, ya que
      // la URL en sí es siempre la misma para cada persona.
      const v = encodeURIComponent(member.photoUpdatedAt || '0');
      return `<img src="${PHOTO_URL}?key=${encodeURIComponent(member.photoKey)}&v=${v}" class="avatar" style="width:${size}px;height:${size}px;object-fit:cover;" alt="${escapeHtml(member.name)}" />`;
    }
    return `<div class="avatar" style="background:${avatarColor(member.id)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;">${escapeHtml(initials(member.name))}</div>`;
  }

  // ---------------------------------------------------------------------
  // Almacenamiento local del dispositivo
  // ---------------------------------------------------------------------

  // Identificador aleatorio para este dispositivo/persona (para la foto de
  // perfil compartida entre grupos, no es un id sensible ni de seguridad).
  function randomId() {
    return 'a' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function loadDevice() {
    try {
      const raw = localStorage.getItem(DEVICE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      let changed = !raw;
      if (!parsed.groups) { parsed.groups = []; changed = true; }
      if (!parsed.avatarId) { parsed.avatarId = randomId(); changed = true; }
      if (changed) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify(parsed)); } catch (e) { /* ignore */ } }
      return parsed;
    } catch (e) {
      const fresh = { groups: [], avatarId: randomId() };
      try { localStorage.setItem(DEVICE_KEY, JSON.stringify(fresh)); } catch (e2) { /* ignore */ }
      return fresh;
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

  const MUTE_KEY = 'gc_muted_v1';

  function loadMuted() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; }
  }

  function saveMuted(muted) {
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
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

  async function uploadPhoto(code, base64, avatarFor, global) {
    const body = await apiPostRaw(PHOTO_URL, { groupCode: code, imageBase64: base64, avatarFor: avatarFor || undefined, global: global || undefined });
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
    muted: loadMuted(),
    pushStatus: 'unknown', // 'unsupported' | 'denied' | 'off' | 'on'
  };

  let draft = null; // borrador del formulario de gasto/pago en curso
  let viewingItem = null; // movimiento (gasto o pago) que se está viendo en detalle

  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  // ---------------------------------------------------------------------
  // Decoración de fondo: dinero flotando en TODAS las pantallas
  // ---------------------------------------------------------------------

  function setupMoneyDecor() {
    const el = document.getElementById('moneyDecor');
    if (!el) return;
    const emojis = ['🪙', '💶', '💸', '💰'];
    const COUNT = 48; // x3 respecto a antes
    let html = '';
    for (let i = 0; i < COUNT; i++) {
      const emoji = emojis[i % emojis.length];
      // Distribución triangular: concentra la mayoría hacia el centro de la
      // pantalla (en móvil, cerca de los bordes se ve raro/cortado).
      const centerBias = (Math.random() + Math.random() + Math.random()) / 3;
      const left = Math.round(10 + centerBias * 80);
      const top = Math.round(Math.random() * 92);
      const size = 20 + Math.round(Math.random() * 26);
      const delay = (Math.random() * 4).toFixed(2);
      const duration = (4 + Math.random() * 3.5).toFixed(2);
      html += `<span style="left:${left}%;top:${top}%;font-size:${size}px;animation-delay:${delay}s;animation-duration:${duration}s;">${emoji}</span>`;
    }
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Sonido de caja registradora ("chin chin") al añadir gastos o pagos
  // ---------------------------------------------------------------------

  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        audioCtx = null;
      }
    }
    return audioCtx;
  }

  const CASH_SOUND_URL = '/sounds/cash-register.mp3';
  let cashSoundBuffer = null;
  let cashSoundLoadPromise = null;

  // Descarga y decodifica el sonido una sola vez, y lo deja preparado en memoria.
  function loadCashSound() {
    const ctx = getAudioCtx();
    if (!ctx) return Promise.resolve(null);
    if (cashSoundBuffer) return Promise.resolve(cashSoundBuffer);
    if (!cashSoundLoadPromise) {
      cashSoundLoadPromise = fetch(CASH_SOUND_URL)
        .then((res) => res.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => { cashSoundBuffer = buf; return buf; })
        .catch(() => null);
    }
    return cashSoundLoadPromise;
  }

  // Reproduce el "chin chin" de caja registradora, reforzado con ganancia extra
  // y un limitador para que suene lo más fuerte posible sin distorsionar.
  function playCashRegisterSound() {
    if (state.muted) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    loadCashSound().then((buffer) => {
      if (!buffer) {
        try {
          const audio = new Audio(CASH_SOUND_URL);
          audio.volume = 1;
          audio.play().catch(() => {});
        } catch (e) { /* sin sonido, seguimos sin bloquear nada */ }
        return;
      }
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;

        const gain = ctx.createGain();
        gain.gain.value = 2.4; // refuerzo extra de volumen sobre el archivo original

        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.15;

        source.connect(gain);
        gain.connect(limiter);
        limiter.connect(ctx.destination);
        source.start(0);
      } catch (e) { /* si algo falla, simplemente no suena */ }
    });
  }

  // Crea el contexto de audio y precarga el sonido en el primer toque del
  // usuario (algunos móviles exigen "desbloquear" el sonido con una interacción real).
  document.addEventListener('pointerdown', () => { getAudioCtx(); loadCashSound(); }, { once: true, passive: true });

  function toast(msg) {
    // Mensajes flotantes desactivados a petición del usuario: los errores
    // importantes se siguen mostrando en el banner de la propia pantalla.
    return;
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
      if (document.visibilityState === 'visible' && (state.screen === 'group' || state.screen === 'movementDetail') && state.code) {
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
      if (state.screen === 'movementDetail') {
        // Al refrescar en segundo plano no queremos borrar lo que la persona
        // está escribiendo en el chat, así que lo guardamos y lo devolvemos.
        const input = document.querySelector('[data-role="chat-input"]');
        const draftText = input ? input.value : '';
        const hadFocus = !!input && input === document.activeElement;
        render();
        const newInput = document.querySelector('[data-role="chat-input"]');
        if (newInput && draftText) {
          newInput.value = draftText;
          if (hadFocus) newInput.focus();
        }
      }
    } catch (err) {
      if (!silent) toast(err.message);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.screen === 'group' || state.screen === 'movementDetail')) {
      refreshGroup(true);
    }
  });

  // ---------------------------------------------------------------------
  // Render principal
  // ---------------------------------------------------------------------

  function render() {
    if (state.screen === 'splash') return renderSplash();
    if (state.screen === 'loading') return renderLoading();
    if (state.screen === 'home') return renderHome();
    if (state.screen === 'create') return renderCreate();
    if (state.screen === 'join') return renderJoin();
    if (state.screen === 'group') return renderGroupScreen();
    if (state.screen === 'addExpense') return renderAddExpense();
    if (state.screen === 'settle') return renderSettle();
    if (state.screen === 'settings') return renderSettings();
    if (state.screen === 'addMember') return renderAddMember();
    if (state.screen === 'movementDetail') return renderMovementDetail();
  }

  function renderLoading() {
    app.innerHTML = `
      <div class="center-col">
        <div class="spinner"></div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: intro / splash al arrancar (dura ~2 segundos)
  // ---------------------------------------------------------------------

  function renderSplash() {
    const emojis = ['🪙', '💶', '💸', '💰'];
    let coinsHtml = '';
    const COUNT = 55;
    for (let i = 0; i < COUNT; i++) {
      const emoji = emojis[i % emojis.length];
      const left = Math.round(Math.random() * 96);
      const delay = (Math.random() * 1.5).toFixed(2);
      const duration = (1.2 + Math.random() * 1.0).toFixed(2);
      const size = 16 + Math.round(Math.random() * 18);
      coinsHtml += `<span style="left:${left}%;font-size:${size}px;animation-delay:${delay}s;animation-duration:${duration}s;">${emoji}</span>`;
    }
    app.innerHTML = `
      <div class="splash">
        <div class="splash-coins">${coinsHtml}</div>
        <div class="splash-logo">🪙</div>
        <h1 class="splash-title">Apokina<span>la pasta</span></h1>
      </div>`;
  }

  function showSplash(next) {
    state.screen = 'splash';
    render();
    // Sonido al arrancar (mejor esfuerzo: algunos móviles bloquean cualquier
    // sonido hasta que el usuario ha tocado la pantalla al menos una vez).
    playCashRegisterSound();
    setTimeout(() => {
      const el = document.querySelector('.splash');
      if (el) el.classList.add('splash-fade-out');
      setTimeout(next, 380);
    }, 1600);
  }

  // ---------------------------------------------------------------------
  // Pantalla: inicio / mis grupos
  // ---------------------------------------------------------------------

  function renderHome() {
    const groups = state.device.groups;
    if (groups.length === 0) {
      app.innerHTML = `
        <div class="center-col">
          <div class="big-emoji">🪙</div>
          <h1 style="margin:4px 0;">Apokina la Pasta</h1>
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
        <div class="hero-float-icon">💸</div>
        <div class="hero-top">
          <div></div>
          <h1 style="margin:0;font-size:20px;">Tus grupos</h1>
          <button class="icon-btn" data-action="toggle-mute" title="${state.muted ? 'Activar sonido' : 'Silenciar'}">${state.muted ? '🔇' : '🔊'}</button>
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
            <div class="list-row balance-row ${cls}">
              ${avatarHtml(m, 44)}
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

    const activityRows = renderActivitySections(filteredActivity, state.meId);

    app.innerHTML = `
      <div class="hero">
        <div class="hero-float-icon">💸</div>
        <div class="hero-top">
          <button class="icon-btn" data-action="go-home">←</button>
          <h1 style="margin:0;">${escapeHtml(group.name)}</h1>
          <div class="hero-top-actions">
            <button class="icon-btn" data-action="toggle-mute" title="${state.muted ? 'Activar sonido' : 'Silenciar'}">${state.muted ? '🔇' : '🔊'}</button>
            <button class="icon-btn" data-action="open-settings">⚙️</button>
          </div>
        </div>
        <div class="sub">Código ${group.code} · ${group.members.length} persona${group.members.length === 1 ? '' : 's'}</div>
        <div class="totals">
          <div class="total-chip owed">
            <div class="label">Te deben en total</div>
            <div class="value">${formatMoney(totalOwedToMe)}</div>
          </div>
          <div class="total-chip owe">
            <div class="label">Debes en total</div>
            <div class="value">${formatMoney(totalIOwe)}</div>
          </div>
        </div>
      </div>

      <div class="tabs">
        <button class="tab ${state.groupTab === 'saldos' ? 'active' : ''}" data-action="set-tab" data-tab="saldos">Saldos</button>
        <button class="tab ${state.groupTab === 'actividad' ? 'active' : ''}" data-action="set-tab" data-tab="actividad">Actividad</button>
      </div>

      ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

      ${state.groupTab === 'saldos' ? `
        <div class="section screen-pad-bottom">
          <div class="card">${balanceRows}</div>
          <button class="btn btn-secondary btn-block" style="margin-top:14px;" data-action="show-add-member">➕ Añadir a alguien al grupo</button>
        </div>
      ` : `
        <div class="filter-scroll">${filterChips}</div>
        <div class="section screen-pad-bottom" style="padding-top:0;">
          ${activityRows}
          <button class="btn btn-secondary btn-block" style="margin-top:14px;" data-action="export-csv">📤 Exportar movimientos (Excel/CSV)</button>
        </div>
      `}

      <div class="fab">
        <button class="btn btn-primary" data-action="show-add-expense">🧾  Añadir gasto</button>
      </div>`;
  }

  const UNKNOWN_MEMBER = { id: '?', name: '?' };

  function buildActivityList(group) {
    const items = [];
    for (const e of group.expenses || []) {
      const payer = group.members.find((m) => m.id === e.paidBy);
      const creator = group.members.find((m) => m.id === e.createdBy) || payer;
      items.push({
        type: 'expense',
        date: e.date,
        createdAt: e.createdAt,
        id: e.id,
        title: e.description,
        payerName: payer ? payer.name : '?',
        payerMember: payer || null,
        paidBy: e.paidBy,
        createdBy: e.createdBy || e.paidBy,
        creatorMember: creator || null,
        splits: e.splits,
        amount: e.amount,
        photoKey: e.photoKey,
        category: e.category || 'otros',
        involves: [e.paidBy, ...e.splits.map((s) => s.memberId)],
      });
    }
    for (const p of group.payments || []) {
      const from = group.members.find((m) => m.id === p.fromMemberId);
      const to = group.members.find((m) => m.id === p.toMemberId);
      const creator = group.members.find((m) => m.id === p.createdBy) || from;
      items.push({
        type: 'payment',
        date: p.date,
        createdAt: p.createdAt,
        id: p.id,
        fromMemberId: p.fromMemberId,
        toMemberId: p.toMemberId,
        fromName: from ? from.name : '?',
        toName: to ? to.name : '?',
        fromMember: from || null,
        toMember: to || null,
        createdBy: p.createdBy || p.fromMemberId,
        creatorMember: creator || null,
        amount: p.amount,
        involves: [p.fromMemberId, p.toMemberId],
      });
    }
    items.sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
    return items;
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Agrupa los movimientos por mes para que se vean en secciones ordenadas, no todos mezclados.
  function groupActivityByMonth(items) {
    const groups = [];
    let current = null;
    for (const item of items) {
      const d = item.date ? new Date(item.date.length <= 10 ? item.date + 'T00:00:00' : item.date) : null;
      const key = d ? `${d.getFullYear()}-${d.getMonth()}` : 'sin-fecha';
      if (!current || current.key !== key) {
        current = {
          key,
          label: d ? capitalize(d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })) : 'Sin fecha',
          items: [],
        };
        groups.push(current);
      }
      current.items.push(item);
    }
    return groups;
  }

  function renderActivitySections(items, meId) {
    if (items.length === 0) {
      return `<div class="empty"><div class="big-emoji">🧾</div>Todavía no hay movimientos.</div>`;
    }
    const groups = groupActivityByMonth(items);
    return groups.map((g) => `
      <div class="activity-section-title">${escapeHtml(g.label)}</div>
      <div class="card activity-card">${g.items.map((item) => renderActivityRow(item, meId)).join('')}</div>
    `).join('');
  }

  function renderActivityRow(item, meId) {
    const isExpense = item.type === 'expense';
    const cat = isExpense ? getCategory(item.category) : null;
    const actorMember = isExpense ? item.payerMember : item.fromMember;
    const avatarIcon = avatarHtml(actorMember || UNKNOWN_MEMBER, 46);
    const photoBtn = item.photoKey
      ? `<button class="btn btn-secondary btn-sm" data-action="view-photo" data-key="${escapeHtml(item.photoKey)}" style="margin-top:6px;">📷 Ver foto</button>`
      : '';

    let title, sub, rightLabel, rightClass, rightSecondary = '';

    if (isExpense) {
      title = escapeHtml(item.title);
      const payerBit = item.paidBy === meId ? 'Tú pagaste' : `${escapeHtml(item.payerName)} pagó`;
      sub = `${payerBit} · ${formatDate(item.date)} · ${escapeHtml(cat.label)}`;
      const mySplit = (item.splits || []).find((s) => s.memberId === meId);
      const myShare = mySplit ? mySplit.amount : 0;
      if (item.paidBy === meId) {
        const lent = item.amount - myShare;
        if (lent > 0) { rightLabel = `prestaste ${formatMoney(lent)}`; rightClass = 'amount-owed'; }
        else { rightLabel = formatMoney(item.amount); rightClass = 'amount-neutral'; }
      } else if (mySplit) {
        rightLabel = `pediste prestado ${formatMoney(myShare)}`;
        rightClass = 'amount-owe';
      } else {
        rightLabel = formatMoney(item.amount);
        rightClass = 'amount-neutral';
      }
      rightSecondary = formatMoney(item.amount);
    } else {
      if (item.fromMemberId === meId) {
        title = `Le pagaste a ${escapeHtml(item.toName)}`;
        rightLabel = `pagaste ${formatMoney(item.amount)}`;
        rightClass = 'amount-owe';
      } else if (item.toMemberId === meId) {
        title = `${escapeHtml(item.fromName)} te pagó`;
        rightLabel = `recibiste ${formatMoney(item.amount)}`;
        rightClass = 'amount-owed';
      } else {
        title = `${escapeHtml(item.fromName)} pagó a ${escapeHtml(item.toName)}`;
        rightLabel = formatMoney(item.amount);
        rightClass = 'amount-neutral';
      }
      sub = `Liquidación · ${formatDate(item.date)}`;
    }

    return `
      <div class="list-row activity-row" data-action="view-movement" data-type="${item.type}" data-id="${escapeHtml(item.id)}">
        ${avatarIcon}
        <div class="row-main">
          <div class="row-title">${title}</div>
          <div class="row-sub">${sub}</div>
          ${photoBtn}
        </div>
        <div class="row-right">
          <div class="row-title ${rightClass}" style="font-size:14px;">${rightLabel}</div>
          ${isExpense && rightClass !== 'amount-neutral' ? `<div class="row-sub">${rightSecondary}</div>` : ''}
        </div>
        <div class="row-chevron">›</div>
      </div>`;
  }

  // ---------------------------------------------------------------------
  // Pantalla: detalle de un movimiento (gasto o liquidación)
  // ---------------------------------------------------------------------

  function renderMovementDetail() {
    const item = viewingItem;
    if (!item) { state.screen = 'group'; return render(); }
    const group = state.group;
    const isExpense = item.type === 'expense';
    const meId = state.meId;

    const dateObj = item.date ? new Date(item.date.length <= 10 ? item.date + 'T00:00:00' : item.date) : null;
    const createdAtObj = item.createdAt ? new Date(item.createdAt) : null;
    const dateLabel = dateObj ? capitalize(dateObj.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })) : '';
    const timeLabel = createdAtObj ? createdAtObj.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';

    const creator = item.creatorMember;
    const cat = isExpense ? getCategory(item.category) : null;

    const headerMember = isExpense ? (item.payerMember || UNKNOWN_MEMBER) : (item.fromMember || UNKNOWN_MEMBER);
    const headerIcon = avatarHtml(headerMember, 68);
    const headerTitle = isExpense ? item.title : `${escapeHtml(item.fromName)} pagó a ${escapeHtml(item.toName)}`;

    let breakdownRows = '';
    if (isExpense) {
      breakdownRows = (item.splits || []).map((s) => {
        const m = group.members.find((mm) => mm.id === s.memberId);
        return `
          <div class="list-row">
            ${avatarHtml(m || UNKNOWN_MEMBER, 36)}
            <div class="row-main"><div class="row-title" style="font-size:15px;">${escapeHtml(m ? m.name : '?')}${m && m.id === meId ? ' (tú)' : ''}</div></div>
            <div class="row-right"><div class="row-title" style="font-size:15px;">${formatMoney(s.amount)}</div></div>
          </div>`;
      }).join('');
    }

    const photoSection = item.photoKey ? `
      <div class="section-title" style="margin-top:24px;">Foto del ticket</div>
      <img src="${PHOTO_URL}?key=${encodeURIComponent(item.photoKey)}" class="photo-preview" style="max-height:320px;" />
    ` : '';

    const delAction = isExpense ? 'delete-expense' : 'delete-payment';

    // Comentarios (chat) de este movimiento en concreto.
    const itemMessages = (group.messages || []).filter((m) => m.itemType === item.type && m.itemId === item.id);
    const chatHtml = itemMessages.length === 0
      ? `<div class="empty" style="padding:16px;">Todavía no hay comentarios. Escribe el primero 👇</div>`
      : itemMessages.map((m) => {
          const sender = group.members.find((mm) => mm.id === m.memberId) || UNKNOWN_MEMBER;
          const mine = m.memberId === meId;
          const time = m.createdAt ? new Date(m.createdAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
          return `
            <div class="chat-msg ${mine ? 'chat-msg-mine' : ''}">
              ${avatarHtml(sender, 28)}
              <div class="chat-bubble">
                <div class="chat-msg-name">${escapeHtml(sender.name)}${mine ? ' (tú)' : ''}</div>
                <div class="chat-msg-text">${escapeHtml(m.text)}</div>
                <div class="chat-msg-time">${escapeHtml(time)}</div>
              </div>
            </div>`;
        }).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <button class="back-btn" data-action="go-home" title="Tus grupos" style="font-size:16px;">🏠</button>
        <h2>${isExpense ? 'Detalle del gasto' : 'Detalle de la liquidación'}</h2>
      </div>
      <div class="section screen-pad-bottom">
        ${state.error ? `<div class="error-banner">${escapeHtml(state.error)}</div>` : ''}

        <div class="center-col" style="min-height:auto;padding:16px 8px 8px;gap:8px;">
          ${headerIcon}
          <h2 style="margin:8px 0 0;text-align:center;">${headerTitle}</h2>
          <div style="font-size:32px;font-weight:800;">${formatMoney(item.amount)}</div>
          ${cat ? `<div class="movement-cat-chip">${cat.emoji} ${escapeHtml(cat.label)}</div>` : ''}
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="list-row">
            <div class="row-main">
              <div class="row-sub">Añadido por</div>
              <div class="row-title" style="font-size:15px;">${escapeHtml(creator ? creator.name : '?')}${creator && creator.id === meId ? ' (tú)' : ''}</div>
            </div>
          </div>
          <div class="list-row">
            <div class="row-main">
              <div class="row-sub">Fecha y hora</div>
              <div class="row-title" style="font-size:15px;">${escapeHtml(dateLabel)}${timeLabel ? ` · ${escapeHtml(timeLabel)}` : ''}</div>
            </div>
          </div>
        </div>

        ${isExpense ? `
          <div class="section-title" style="margin-top:24px;">Reparto</div>
          <div class="card">${breakdownRows}</div>
        ` : ''}

        ${photoSection}

        <button class="btn btn-outline btn-block" style="margin-top:24px;" data-action="share-whatsapp" data-type="${item.type}" data-id="${escapeHtml(item.id)}">📲 Avisar por WhatsApp</button>

        <div class="section-title" style="margin-top:24px;">Comentarios</div>
        <div class="card chat-card" id="chatMessages">${chatHtml}</div>
        <form data-form="chatMessage" class="chat-input-row">
          <input type="text" name="text" data-role="chat-input" placeholder="Escribe un mensaje…" maxlength="500" autocomplete="off" required />
          <button class="btn btn-primary btn-sm" type="submit">Enviar</button>
        </form>

        <button class="btn btn-danger-text btn-block" style="margin-top:24px;" data-action="${delAction}" data-id="${escapeHtml(item.id)}">Eliminar este movimiento</button>
      </div>`;

    const chatBox = document.getElementById('chatMessages');
    if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
  }

  // ---------------------------------------------------------------------
  // Exportar a CSV (se abre bien en Excel)
  // ---------------------------------------------------------------------

  function exportCsv() {
    const group = state.group;
    const items = buildActivityList(group).slice().reverse(); // orden cronológico
    const rows = [['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Quién pagó / De', 'Para (si es pago)', 'Importe (€)']];
    for (const item of items) {
      if (item.type === 'expense') {
        rows.push([
          item.date || '',
          'Gasto',
          getCategory(item.category).label,
          item.title,
          item.payerName,
          '',
          (item.amount / 100).toFixed(2).replace('.', ','),
        ]);
      } else {
        rows.push([
          item.date || '',
          'Liquidación',
          '',
          `Pago de ${item.fromName} a ${item.toName}`,
          item.fromName,
          item.toName,
          (item.amount / 100).toFixed(2).replace('.', ','),
        ]);
      }
    }
    const csv = rows.map((r) => r.map((cell) => {
      const s = String(cell == null ? '' : cell);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(';')).join('\r\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gastos-${group.code}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Movimientos exportados');
  }

  // ---------------------------------------------------------------------
  // Pantalla: añadir miembro manualmente
  // ---------------------------------------------------------------------

  function renderAddMember() {
    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <button class="back-btn" data-action="go-home" title="Tus grupos" style="font-size:16px;">🏠</button>
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

  function renderPushStatusBlock() {
    const status = state.pushStatus || 'unknown';
    if (status === 'unsupported') {
      return `<div class="row-sub">Tu navegador no admite notificaciones push.</div>`;
    }
    if (status === 'denied') {
      return `<div class="row-sub">Has bloqueado las notificaciones para esta app. Actívalas desde los ajustes de notificaciones de tu móvil o navegador para poder recibirlas.</div>`;
    }
    if (status === 'on') {
      return `
        <div class="row-sub">🔔 Activadas: te avisaremos en el móvil cuando alguien del grupo añada un gasto o registre un pago.</div>
        <button class="btn btn-secondary btn-block" style="margin-top:10px;" data-action="disable-push">Desactivar notificaciones</button>`;
    }
    return `
      <div class="row-sub">Recibe un aviso en el móvil cuando alguien del grupo añada un gasto o registre un pago que te afecte.</div>
      <button class="btn btn-primary btn-block" style="margin-top:10px;" data-action="enable-push">🔔 Activar notificaciones</button>`;
  }

  function renderSettings() {
    const group = state.group;
    const link = `${location.origin}/?join=${group.code}`;
    const memberRows = group.members.map((m) => `
      <div class="list-row">
        ${avatarHtml(m, 44)}
        <div class="row-main">
          <div class="row-title">${escapeHtml(m.name)}${m.id === state.meId ? ' (tú)' : ''}</div>
        </div>
        ${m.id === state.meId ? `
          <div class="avatar-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-action="pick-avatar-selfie">🤳 Selfie</button>
            <button type="button" class="btn btn-secondary btn-sm" data-action="pick-avatar-gallery">🖼️ Galería</button>
          </div>
          <input type="file" accept="image/*" capture="user" id="avatarSelfieInput" data-role="avatar-input" class="visually-hidden-file" />
          <input type="file" accept="image/*" id="avatarGalleryInput" data-role="avatar-input" class="visually-hidden-file" />` : ''}
      </div>`).join('');

    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <button class="back-btn" data-action="go-home" title="Tus grupos" style="font-size:16px;">🏠</button>
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

        <div class="section-title" style="margin-top:24px;">Notificaciones</div>
        <div class="card" style="padding:14px;">${renderPushStatusBlock()}</div>

        <div class="section-title" style="margin-top:24px;">Tus datos</div>
        <button class="btn btn-secondary btn-block" data-action="export-csv">📤 Exportar movimientos (Excel/CSV)</button>

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
      category: 'otros',
      participants: new Set(group.members.map((m) => m.id)),
      advancedMode: false,
      quickChoice: null,
      // usados solo en modo avanzado:
      paidBy: state.meId,
      splitType: 'equal',
      customAmounts: {},
      photoBase64: null,
      photoPreview: null,
    };
  }

  // Devuelve [a, b] ordenados: "tú" primero si participas, si no el orden del grupo.
  function getQuickPair(group, meId, participantIds) {
    const members = group.members.filter((m) => participantIds.includes(m.id));
    if (members.length !== 2) return null;
    if (members[1].id === meId) return [members[1], members[0]];
    return [members[0], members[1]];
  }

  function computeQuickSplits(a, b, quickChoice, amountCents) {
    if (quickChoice === 'a-owed') return { payer: a.id, splits: [{ memberId: a.id, amount: 0 }, { memberId: b.id, amount: amountCents }] };
    if (quickChoice === 'b-equal') return { payer: b.id, splits: equalSplit([a.id, b.id], amountCents) };
    if (quickChoice === 'b-owed') return { payer: b.id, splits: [{ memberId: b.id, amount: 0 }, { memberId: a.id, amount: amountCents }] };
    return { payer: a.id, splits: equalSplit([a.id, b.id], amountCents) }; // 'a-equal' por defecto
  }

  function renderAddExpense() {
    if (!draft) initExpenseDraft();
    const group = state.group;

    const categoryChips = CATEGORIES.map((c) => `
      <button type="button" class="cat-chip ${draft.category === c.id ? 'active' : ''}" data-action="set-category" data-cat="${c.id}"
        style="--cat-color:${c.color};">
        <span class="cat-emoji">${c.emoji}</span>${escapeHtml(c.label)}
      </button>`).join('');

    const participantIds = group.members.filter((m) => draft.participants.has(m.id)).map((m) => m.id);
    const pair = !draft.advancedMode ? getQuickPair(group, state.meId, participantIds) : null;

    const memberCheckboxes = group.members.map((m) => `
      <label class="member-check ${draft.participants.has(m.id) ? 'checked' : ''}">
        <input type="checkbox" data-role="participant" data-member="${m.id}" ${draft.participants.has(m.id) ? 'checked' : ''} />
        ${avatarHtml(m, 30)}
        <span>${escapeHtml(m.name)}${m.id === state.meId ? ' (tú)' : ''}</span>
      </label>`).join('');

    let splitSection = '';

    if (pair) {
      const [a, b] = pair;
      const choice = draft.quickChoice || 'a-equal';
      const opt = (value, label) => `
        <label class="quick-option ${choice === value ? 'selected' : ''}">
          <input type="radio" name="quickChoice" value="${value}" ${choice === value ? 'checked' : ''} data-role="quick-choice" />
          <span>${label}</span>
          <span class="check">✓</span>
        </label>`;

      splitSection = `
        <div class="quick-split card">
          ${opt('a-equal', a.id === state.meId ? 'Tú pagaste, dividido a partes iguales.' : `${escapeHtml(a.name)} pagó, dividido a partes iguales.`)}
          ${opt('a-owed', a.id === state.meId ? 'Se te debe la cantidad total.' : `Se debe la cantidad total a ${escapeHtml(a.name)}.`)}
          ${opt('b-equal', b.id === state.meId ? 'Tú pagaste, dividido a partes iguales.' : `${escapeHtml(b.name)} pagó, dividido a partes iguales.`)}
          ${opt('b-owed', b.id === state.meId ? 'Se te debe la cantidad total.' : `Se debe la cantidad total a ${escapeHtml(b.name)}.`)}
        </div>
        <button type="button" class="link-btn" data-action="toggle-advanced">Más opciones</button>`;
    } else {
      const payerOptions = group.members.map((m) =>
        `<option value="${m.id}" ${draft.paidBy === m.id ? 'selected' : ''}>${escapeHtml(m.name)}${m.id === state.meId ? ' (tú)' : ''}</option>`
      ).join('');

      let advancedRows = '';
      if (draft.splitType === 'equal') {
        advancedRows = group.members.filter((m) => draft.participants.has(m.id)).map((m) => `
          <div class="split-row">
            ${avatarHtml(m, 28)}
            <div class="name">${escapeHtml(m.name)}</div>
          </div>`).join('');
      } else {
        advancedRows = group.members.filter((m) => draft.participants.has(m.id)).map((m) => {
          const val = draft.customAmounts[m.id] != null ? draft.customAmounts[m.id] : '';
          return `
          <div class="split-row">
            ${avatarHtml(m, 28)}
            <div class="name">${escapeHtml(m.name)}</div>
            <input type="text" inputmode="decimal" data-role="custom-amount" data-member="${m.id}"
              value="${val}" placeholder="0,00" />
          </div>`;
        }).join('');
      }

      splitSection = `
        <div class="field">
          <label>¿Quién participa en este gasto?</label>
          <div class="member-check-grid">${memberCheckboxes}</div>
        </div>
        <div class="field">
          <label>¿Quién pagó?</label>
          <select name="paidBy">${payerOptions}</select>
        </div>
        <div class="field">
          <label>¿Cómo se reparte?</label>
          <div class="tabs" style="margin:0;">
            <button type="button" class="tab ${draft.splitType === 'equal' ? 'active' : ''}" data-action="set-split-type" data-type="equal">Partes iguales</button>
            <button type="button" class="tab ${draft.splitType === 'custom' ? 'active' : ''}" data-action="set-split-type" data-type="custom">Cantidades personalizadas</button>
          </div>
        </div>
        <div class="card" style="padding:6px 12px;">${advancedRows}</div>
        <div id="splitSummary"></div>
        ${participantIds.length === 2 ? `<button type="button" class="link-btn" data-action="toggle-advanced">← Reparto rápido</button>` : ''}`;
    }

    app.innerHTML = `
      <div class="topbar">
        <button class="back-btn" data-action="back-to-group">←</button>
        <button class="back-btn" data-action="go-home" title="Tus grupos" style="font-size:16px;">🏠</button>
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
            <input type="text" inputmode="decimal" name="amount" placeholder="0,00" required value="${escapeHtml(draft.amount)}" />
          </div>
          <div class="field">
            <label>Fecha</label>
            <input type="date" name="date" value="${draft.date}" />
          </div>

          <div class="field">
            <label>Categoría</label>
            <div class="cat-chip-row">${categoryChips}</div>
          </div>

          <div class="field">
            <label>Foto del ticket (opcional)</label>
            <div class="photo-btn-row">
              <button type="button" class="btn btn-secondary photo-btn" data-action="pick-expense-camera">📷 Hacer foto</button>
              <button type="button" class="btn btn-secondary photo-btn" data-action="pick-expense-gallery">🖼️ Elegir de galería</button>
              <input type="file" accept="image/*" capture="environment" id="expenseCameraInput" data-role="photo-input-camera" class="visually-hidden-file" />
              <input type="file" accept="image/*" id="expenseGalleryInput" data-role="photo-input-gallery" class="visually-hidden-file" />
            </div>
            ${draft.photoPreview ? `
              <div class="photo-preview-wrap">
                <img src="${draft.photoPreview}" class="photo-preview" />
                <button type="button" class="btn-danger-text btn-sm" data-action="remove-photo">Quitar foto</button>
              </div>` : ''}
          </div>

          ${pair ? `
            <div class="field">
              <label>¿Quién participa en este gasto?</label>
              <div class="member-check-grid">${memberCheckboxes}</div>
            </div>
            <div class="field">
              <label>¿Cómo se dividió este gasto?</label>
              ${splitSection}
            </div>
          ` : `<div class="field">${splitSection}</div>`}

          <button class="btn btn-primary btn-block" type="submit" style="margin-top:8px;" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? 'Guardando…' : 'Guardar gasto'}
          </button>
        </form>
      </div>`;

    updateSplitSummary();
  }

  function updateSplitSummary() {
    const el = document.getElementById('splitSummary');
    if (!el || !draft) return; // no existe en el modo de reparto rápido (2 personas)
    const group = state.group;
    const amountInput = document.querySelector('form[data-form="expense"] input[name="amount"]');
    const amountCents = euroToCents(amountInput ? amountInput.value : draft.amount || 0);

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
        <button class="back-btn" data-action="go-home" title="Tus grupos" style="font-size:16px;">🏠</button>
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
            <input type="text" inputmode="decimal" name="amount" value="${draft.amount}" required />
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

  function compressImage(file, maxSize, quality) {
    maxSize = maxSize || 1280;
    quality = quality || 0.72;
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
      if (state.device.avatarPhotoKey) {
        // Ya tenías una foto de perfil guardada de otro grupo: se aplica sola aquí también.
        await apiPost('set_member_photo', { groupCode: group.code, memberId, photoKey: state.device.avatarPhotoKey }).catch(() => {});
      }
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
      if (state.device.avatarPhotoKey) {
        // Ya tenías una foto de perfil guardada de otro grupo: se aplica sola aquí también.
        await apiPost('set_member_photo', { groupCode: group.code, memberId, photoKey: state.device.avatarPhotoKey }).catch(() => {});
      }
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
    const group = state.group;
    const participantIds = group.members.filter((m) => draft.participants.has(m.id)).map((m) => m.id);
    const pair = !draft.advancedMode ? getQuickPair(group, state.meId, participantIds) : null;

    let paidBy, splits;

    if (pair) {
      const [a, b] = pair;
      const result = computeQuickSplits(a, b, draft.quickChoice || 'a-equal', amountCents);
      paidBy = result.payer;
      splits = result.splits;
    } else {
      paidBy = form.paidBy.value;
      if (draft.splitType === 'equal') {
        if (participantIds.length === 0) return setError('Selecciona al menos una persona en el reparto');
        splits = equalSplit(participantIds, amountCents);
      } else {
        if (participantIds.length === 0) return setError('Selecciona al menos una persona en el reparto');
        let sum = 0;
        splits = participantIds.map((id) => {
          const input = document.querySelector(`[data-role="custom-amount"][data-member="${id}"]`);
          const cents = euroToCents(input ? input.value : 0);
          sum += cents;
          return { memberId: id, amount: cents };
        });
        if (sum !== amountCents) return setError('El reparto personalizado no cuadra con el importe total');
      }
    }

    state.busy = true; state.error = null; render();
    try {
      let photoKey = null;
      if (draft.photoBase64) {
        photoKey = await uploadPhoto(state.code, draft.photoBase64);
      }
      const { group: updated } = await apiPost('add_expense', {
        groupCode: state.code,
        expense: { description, amount: amountCents, paidBy, createdBy: state.meId, date, category: draft.category, splitType: draft.splitType, splits, photoKey },
      });
      state.group = updated;
      state.busy = false;
      draft = null;
      state.groupTab = 'actividad';
      // Abrimos el detalle del gasto recién creado: desde ahí se puede avisar
      // por WhatsApp o dejar un comentario sin tener que buscarlo.
      const newExpense = updated.expenses[updated.expenses.length - 1];
      const newItem = buildActivityList(updated).find((x) => x.type === 'expense' && x.id === newExpense.id);
      if (newItem) {
        viewingItem = newItem;
        state.screen = 'movementDetail';
      } else {
        state.screen = 'group';
      }
      render();
      playCashRegisterSound();
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
        payment: { fromMemberId, toMemberId, amount: amountCents, createdBy: state.meId, date: todayStr() },
      });
      state.group = group;
      state.busy = false;
      draft = null;
      state.screen = 'group';
      render();
      playCashRegisterSound();
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
      state.error = null;
      viewingItem = null;
      state.screen = 'group';
      state.groupTab = 'actividad';
      render();
    } catch (err) {
      setError(err.message);
    }
  }

  async function deletePayment(id) {
    try {
      const { group } = await apiPost('delete_payment', { groupCode: state.code, paymentId: id });
      state.group = group;
      state.error = null;
      viewingItem = null;
      state.screen = 'group';
      state.groupTab = 'actividad';
      render();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleChatSubmit(form) {
    const text = form.text.value.trim();
    if (!text || !viewingItem) return;
    form.text.value = '';
    try {
      const { group } = await apiPost('send_message', {
        groupCode: state.code,
        memberId: state.meId,
        itemType: viewingItem.type,
        itemId: viewingItem.id,
        text,
        // El backend debe usar esta marca para enviar un Web Push a
        // los demás miembros con suscripción activa del grupo.
        notifyPush: true,
        notification: {
          title: '💬 Nuevo comentario',
          body: text,
          tag: `chat-${viewingItem.type}-${viewingItem.id}`,
          itemType: viewingItem.type,
          itemId: viewingItem.id,
        },
      });
      state.group = group;
      state.error = null;
      render();
      const input = document.querySelector('[data-role="chat-input"]');
      if (input) input.focus();
    } catch (err) {
      setError('No se ha podido enviar el mensaje: ' + err.message);
    }
  }

  async function changeAvatar(file) {
    try {
      const dataUrl = await compressImage(file, 480, 0.75);
      // Se sube como foto "global" del dispositivo (no atada a este grupo), así
      // se puede reutilizar automáticamente en cualquier otro grupo futuro.
      const photoKey = await uploadPhoto(state.code, dataUrl, state.device.avatarId, true);
      state.device.avatarPhotoKey = photoKey;
      state.device.avatarUpdatedAt = new Date().toISOString();
      saveDevice(state.device);
      const { group } = await apiPost('set_member_photo', { groupCode: state.code, memberId: state.meId, photoKey });
      state.group = group;
      state.error = null;
      render();
    } catch (err) {
      setError('No se ha podido subir la foto: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------
  // Notificaciones push
  // ---------------------------------------------------------------------

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function refreshPushStatus() {
    if (!pushSupported()) { state.pushStatus = 'unsupported'; return; }
    if (Notification.permission === 'denied') { state.pushStatus = 'denied'; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      state.pushStatus = sub ? 'on' : 'off';
    } catch (e) {
      state.pushStatus = 'off';
    }
  }

  async function enablePush() {
    if (!pushSupported()) {
      setError('Tu navegador no admite notificaciones.');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        state.pushStatus = permission === 'denied' ? 'denied' : 'off';
        setError('No se han activado las notificaciones.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await apiPost('save_push_subscription', { groupCode: state.code, memberId: state.meId, subscription: sub.toJSON() });
      state.pushStatus = 'on';
      state.error = null;
      render();
    } catch (err) {
      setError('No se han podido activar las notificaciones: ' + err.message);
    }
  }

  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await apiPost('remove_push_subscription', { groupCode: state.code, memberId: state.meId }).catch(() => {});
      state.pushStatus = 'off';
      state.error = null;
      render();
    } catch (err) {
      setError('No se han podido desactivar las notificaciones: ' + err.message);
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
    if (action === 'back-to-group') { state.screen = 'group'; state.error = null; draft = null; viewingItem = null; return render(); }
    if (action === 'open-settings') {
      state.screen = 'settings';
      state.error = null;
      render();
      refreshPushStatus().then(render);
      return;
    }
    if (action === 'enable-push') return enablePush();
    if (action === 'disable-push') return disablePush();
    if (action === 'toggle-mute') {
      state.muted = !state.muted;
      saveMuted(state.muted);
      return render();
    }
    if (action === 'set-tab') { state.groupTab = target.dataset.tab; return render(); }
    if (action === 'set-filter') { state.activityFilter = target.dataset.filter; return render(); }
    if (action === 'show-add-expense') { draft = null; state.screen = 'addExpense'; state.error = null; return render(); }
    if (action === 'show-add-member') { state.screen = 'addMember'; state.error = null; return render(); }
    if (action === 'export-csv') return exportCsv();

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

    if (action === 'set-category') { draft.category = target.dataset.cat; return renderAddExpense(); }

    if (action === 'toggle-advanced') {
      draft.advancedMode = !draft.advancedMode;
      return renderAddExpense();
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

    if (action === 'view-movement') {
      const type = target.dataset.type;
      const id = target.dataset.id;
      const item = buildActivityList(state.group).find((x) => x.type === type && x.id === id);
      if (!item) return;
      viewingItem = item;
      state.screen = 'movementDetail';
      state.error = null;
      return render();
    }

    if (action === 'share-whatsapp') {
      const type = target.dataset.type;
      const id = target.dataset.id;
      const item = buildActivityList(state.group).find((x) => x.type === type && x.id === id);
      if (!item) return;
      const link = `${location.origin}/?join=${state.group.code}`;
      let text;
      if (type === 'expense') {
        const parts = (item.splits || []).map((s) => {
          const m = state.group.members.find((mm) => mm.id === s.memberId);
          return `${m ? m.name : '?'} ${formatMoney(s.amount)}`;
        }).join(' · ');
        text = `💸 Nuevo gasto en "${state.group.name}": "${item.title}" - ${formatMoney(item.amount)} (pagado por ${item.payerName}).\nReparto: ${parts}.\nMás info aquí: ${link}`;
      } else {
        text = `💰 Pago registrado en "${state.group.name}": ${item.fromName} pagó ${formatMoney(item.amount)} a ${item.toName}.\nMás info aquí: ${link}`;
      }
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      return;
    }

    if (action === 'remove-photo') {
      draft.photoBase64 = null;
      draft.photoPreview = null;
      return renderAddExpense();
    }

    if (action === 'pick-expense-camera') { document.getElementById('expenseCameraInput')?.click(); return; }
    if (action === 'pick-expense-gallery') { document.getElementById('expenseGalleryInput')?.click(); return; }
    if (action === 'pick-avatar-selfie') { document.getElementById('avatarSelfieInput')?.click(); return; }
    if (action === 'pick-avatar-gallery') { document.getElementById('avatarGalleryInput')?.click(); return; }
  });

  app.addEventListener('change', (e) => {
    if (e.target.matches('[data-role="participant"]')) {
      const memberId = e.target.dataset.member;
      if (e.target.checked) draft.participants.add(memberId);
      else draft.participants.delete(memberId);
      draft.quickChoice = null;
      return renderAddExpense();
    }
    if (e.target.matches('[data-role="quick-choice"]')) {
      draft.quickChoice = e.target.value;
      return renderAddExpense();
    }
    if (e.target.matches('[data-role="photo-input-camera"], [data-role="photo-input-gallery"]')) {
      const file = e.target.files[0];
      if (!file) return;
      compressImage(file).then((dataUrl) => {
        draft.photoBase64 = dataUrl;
        draft.photoPreview = dataUrl;
        renderAddExpense();
      }).catch(() => toast('No se ha podido procesar la foto'));
      return;
    }
    if (e.target.matches('[data-role="avatar-input"]')) {
      const file = e.target.files[0];
      if (file) changeAvatar(file);
      return;
    }
    if (e.target.name === 'paidBy' && draft) {
      draft.paidBy = e.target.value;
      return;
    }
  });

  app.addEventListener('input', (e) => {
    // Guardamos lo que se va escribiendo en el borrador (draft) al momento,
    // para que si se vuelve a dibujar la pantalla (por ejemplo al elegir
    // "Se te debe la cantidad total" o marcar/desmarcar a alguien) no se
    // borre lo que ya se había escrito en descripción, importe o fecha.
    if (!draft) return;
    if (e.target.name === 'description') {
      draft.description = e.target.value;
      return;
    }
    if (e.target.name === 'date') {
      draft.date = e.target.value;
      return;
    }
    if (e.target.matches('[data-role="custom-amount"]')) {
      draft.customAmounts[e.target.dataset.member] = e.target.value;
      updateSplitSummary();
      return;
    }
    if (e.target.name === 'amount') {
      draft.amount = e.target.value;
      updateSplitSummary();
      return;
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
    if (type === 'chatMessage') return handleChatSubmit(form);
  });

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------

  function init() {
    showSplash(() => {
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

      state.screen = 'home';
      render();
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  setupMoneyDecor();
  init();
})();
