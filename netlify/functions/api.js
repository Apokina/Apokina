import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

// Claves VAPID para notificaciones push (identifican a este servidor ante
// los navegadores). No pasa nada porque estén aquí "a la vista": la clave
// privada solo se usa en este servidor, nunca se envía al navegador.
const VAPID_PUBLIC_KEY = 'BCBWOGVoj-8y2kz9P85eOsXjCrxHR9fYf2B3c4F0VVwe2ve6wIpaYHKw3BWIeTMc5DKiSaKKDtRGscvfrNDhoOs';
const VAPID_PRIVATE_KEY = 'z6eEPA7toamsbzhGqCJ0ryC9LlotXGmZEzYDa6r3rsw';
webpush.setVapidDetails('mailto:no-reply@apokinapasta.netlify.app', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Envía una notificación push a un miembro si tiene una suscripción guardada.
// Si la suscripción ya no es válida (el usuario desinstaló la app, etc.)
// simplemente la borramos de su ficha para no reintentar en el futuro.
async function pushToMember(member, payload) {
  if (!member || !member.pushSubscription) return;
  try {
    await webpush.sendNotification(member.pushSubscription, JSON.stringify(payload));
  } catch (err) {
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      member.pushSubscription = null;
    }
  }
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I/L para evitar confusiones

function randomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getGroupsStore() {
  return getStore({ name: 'groups', consistency: 'strong' });
}

export default async (req) => {
  const store = getGroupsStore();
  const url = new URL(req.url);

  // --- Lectura de un grupo (usado también para el sondeo/sincronización) ---
  if (req.method === 'GET') {
    const code = (url.searchParams.get('code') || '').toUpperCase().trim();
    if (!code) return json(400, { error: 'Falta el código de grupo' });
    try {
      const group = await store.get(code, { type: 'json' });
      if (!group) return json(404, { error: 'No existe ningún grupo con ese código' });
      return json(200, { group });
    } catch (err) {
      return json(500, { error: 'Error del servidor: ' + err.message });
    }
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'Método no permitido' });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return json(400, { error: 'JSON inválido' });
  }

  const { action } = payload;

  try {
    // --- Crear grupo ---
    if (action === 'create_group') {
      const memberName = (payload.memberName || '').trim();
      const groupName = (payload.groupName || '').trim();
      if (!memberName) return json(400, { error: 'Falta tu nombre' });

      let code = null;
      for (let i = 0; i < 8; i++) {
        const candidate = randomCode();
        const existing = await store.get(candidate, { type: 'json' });
        if (!existing) { code = candidate; break; }
      }
      if (!code) return json(500, { error: 'No se pudo generar un código único, inténtalo de nuevo' });

      const memberId = genId('m');
      const group = {
        code,
        name: groupName || 'Mi grupo',
        createdAt: nowIso(),
        updatedAt: nowIso(),
        members: [{ id: memberId, name: memberName, joinedAt: nowIso() }],
        expenses: [],
        payments: [],
        messages: [],
      };
      await store.setJSON(code, group);
      return json(200, { group, memberId });
    }

    // --- Unirse a un grupo existente ---
    if (action === 'join_group') {
      const code = (payload.groupCode || '').toUpperCase().trim();
      const memberName = (payload.memberName || '').trim();
      if (!code) return json(400, { error: 'Falta el código de grupo' });
      if (!memberName) return json(400, { error: 'Falta tu nombre' });

      const group = await store.get(code, { type: 'json' });
      if (!group) return json(404, { error: 'No existe ningún grupo con ese código' });

      let member = group.members.find((m) => m.name.toLowerCase() === memberName.toLowerCase());
      if (!member) {
        member = { id: genId('m'), name: memberName, joinedAt: nowIso() };
        group.members.push(member);
        group.updatedAt = nowIso();
        await store.setJSON(code, group);
      }
      return json(200, { group, memberId: member.id });
    }

    // El resto de acciones requieren un grupo existente
    const code = (payload.groupCode || '').toUpperCase().trim();
    if (!code) return json(400, { error: 'Falta el código de grupo' });
    const group = await store.get(code, { type: 'json' });
    if (!group) return json(404, { error: 'Grupo no encontrado' });

    if (action === 'add_member') {
      const name = (payload.memberName || '').trim();
      if (!name) return json(400, { error: 'Falta el nombre' });
      if (group.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        return json(400, { error: 'Ya hay alguien con ese nombre en el grupo' });
      }
      const member = { id: genId('m'), name, joinedAt: nowIso() };
      group.members.push(member);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group, memberId: member.id });
    }

    if (action === 'add_expense') {
      const e = payload.expense || {};
      const description = (e.description || '').trim();
      const amount = Math.round(Number(e.amount));
      const splits = Array.isArray(e.splits) ? e.splits : [];

      if (!description) return json(400, { error: 'Falta la descripción del gasto' });
      if (!amount || amount <= 0) return json(400, { error: 'El importe no es válido' });
      if (!e.paidBy || !group.members.some((m) => m.id === e.paidBy)) {
        return json(400, { error: 'Quién pagó no es válido' });
      }
      if (splits.length === 0) return json(400, { error: 'Falta el reparto del gasto' });

      const splitSum = splits.reduce((s, x) => s + Math.round(Number(x.amount) || 0), 0);
      if (Math.abs(splitSum - amount) > splits.length) {
        return json(400, { error: 'El reparto no cuadra con el importe total' });
      }

      const createdBy = (e.createdBy && group.members.some((m) => m.id === e.createdBy)) ? e.createdBy : e.paidBy;

      const expense = {
        id: genId('e'),
        description,
        amount,
        paidBy: e.paidBy,
        createdBy,
        date: e.date || nowIso().slice(0, 10),
        splitType: e.splitType === 'custom' ? 'custom' : 'equal',
        splits: splits.map((x) => ({ memberId: x.memberId, amount: Math.round(Number(x.amount) || 0) })),
        photoKey: e.photoKey || null,
        category: (typeof e.category === 'string' && e.category.trim()) || 'otros',
        createdAt: nowIso(),
      };
      group.expenses.push(expense);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);

      // Aviso push a quienes participan en el reparto (menos a quien lo creó).
      const expenseCreator = group.members.find((m) => m.id === createdBy);
      const shareByMember = {};
      expense.splits.forEach((s) => { shareByMember[s.memberId] = s.amount; });
      const expenseTargets = group.members.filter((m) => m.id !== createdBy && shareByMember[m.id] !== undefined);
      await Promise.all(expenseTargets.map((m) => pushToMember(m, {
        title: `Nuevo gasto en ${group.name}`,
        body: `${expenseCreator ? expenseCreator.name : 'Alguien'} añadió "${expense.description}" · te tocan ${(shareByMember[m.id] / 100).toFixed(2).replace('.', ',')}€`,
        tag: 'apokina-expense',
      })));

      return json(200, { group });
    }

    if (action === 'delete_expense') {
      group.expenses = group.expenses.filter((x) => x.id !== payload.expenseId);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group });
    }

    if (action === 'add_payment') {
      const p = payload.payment || {};
      const amount = Math.round(Number(p.amount));
      if (!amount || amount <= 0) return json(400, { error: 'El importe no es válido' });
      if (!p.fromMemberId || !p.toMemberId) return json(400, { error: 'Faltan los participantes del pago' });
      if (p.fromMemberId === p.toMemberId) return json(400, { error: 'No puedes pagarte a ti mismo' });

      const paymentCreatedBy = (p.createdBy && group.members.some((m) => m.id === p.createdBy)) ? p.createdBy : p.fromMemberId;

      const payment = {
        id: genId('p'),
        fromMemberId: p.fromMemberId,
        toMemberId: p.toMemberId,
        amount,
        createdBy: paymentCreatedBy,
        date: p.date || nowIso().slice(0, 10),
        note: (p.note || '').trim(),
        createdAt: nowIso(),
      };
      group.payments.push(payment);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);

      // Aviso push a la otra persona implicada en el pago (quien no lo registró).
      const fromMember = group.members.find((m) => m.id === p.fromMemberId);
      const toMember = group.members.find((m) => m.id === p.toMemberId);
      const paymentTarget = paymentCreatedBy === p.fromMemberId ? toMember : fromMember;
      await pushToMember(paymentTarget, {
        title: `Pago registrado en ${group.name}`,
        body: `${fromMember ? fromMember.name : '?'} pagó ${(amount / 100).toFixed(2).replace('.', ',')}€ a ${toMember ? toMember.name : '?'}`,
        tag: 'apokina-payment',
      });

      return json(200, { group });
    }

    if (action === 'delete_payment') {
      group.payments = group.payments.filter((x) => x.id !== payload.paymentId);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group });
    }

    if (action === 'set_member_photo') {
      const memberId = payload.memberId;
      const member = group.members.find((m) => m.id === memberId);
      if (!member) return json(404, { error: 'No se encuentra a esa persona en el grupo' });
      member.photoKey = payload.photoKey || null;
      // Marca de tiempo para forzar que el navegador recargue la foto en vez de
      // seguir enseñando la anterior (la URL de la foto siempre es la misma).
      member.photoUpdatedAt = nowIso();
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group });
    }

    if (action === 'save_push_subscription') {
      const memberId = payload.memberId;
      const member = group.members.find((m) => m.id === memberId);
      if (!member) return json(404, { error: 'No se encuentra a esa persona en el grupo' });
      const subscription = payload.subscription;
      if (!subscription || !subscription.endpoint) return json(400, { error: 'Suscripción no válida' });
      member.pushSubscription = subscription;
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group });
    }

    if (action === 'remove_push_subscription') {
      const memberId = payload.memberId;
      const member = group.members.find((m) => m.id === memberId);
      if (member) {
        member.pushSubscription = null;
        group.updatedAt = nowIso();
        await store.setJSON(code, group);
      }
      return json(200, { group });
    }

    if (action === 'send_message') {
      const itemType = payload.itemType === 'payment' ? 'payment' : 'expense';
      const itemId = (payload.itemId || '').trim();
      const text = (payload.text || '').trim();
      const memberId = payload.memberId;
      if (!itemId) return json(400, { error: 'Falta el movimiento' });
      if (!text) return json(400, { error: 'Escribe un mensaje' });
      if (text.length > 500) return json(400, { error: 'El mensaje es demasiado largo' });
      if (!memberId || !group.members.some((m) => m.id === memberId)) {
        return json(400, { error: 'Remitente no válido' });
      }

      if (!group.messages) group.messages = [];
      const message = { id: genId('msg'), itemType, itemId, memberId, text, createdAt: nowIso() };
      group.messages.push(message);
      group.updatedAt = nowIso();
      await store.setJSON(code, group);

      // Aviso push a las demás personas implicadas en este movimiento.
      let involvedIds = [];
      if (itemType === 'expense') {
        const exp = group.expenses.find((e) => e.id === itemId);
        if (exp) involvedIds = [exp.paidBy, exp.createdBy, ...exp.splits.map((s) => s.memberId)];
      } else {
        const pay = group.payments.find((p) => p.id === itemId);
        if (pay) involvedIds = [pay.fromMemberId, pay.toMemberId, pay.createdBy];
      }
      const sender = group.members.find((m) => m.id === memberId);
      const chatTargets = group.members.filter((m) => involvedIds.includes(m.id) && m.id !== memberId);
      await Promise.all(chatTargets.map((m) => pushToMember(m, {
        title: `${sender ? sender.name : 'Alguien'} te ha escrito`,
        body: text.length > 80 ? text.slice(0, 77) + '...' : text,
        tag: 'apokina-chat',
      })));

      return json(200, { group });
    }

    if (action === 'rename_group') {
      const name = (payload.groupName || '').trim();
      if (!name) return json(400, { error: 'Falta el nombre del grupo' });
      group.name = name;
      group.updatedAt = nowIso();
      await store.setJSON(code, group);
      return json(200, { group });
    }

    return json(400, { error: 'Acción desconocida' });
  } catch (err) {
    return json(500, { error: 'Error del servidor: ' + err.message });
  }
};

export const config = {
  path: '/api',
};
