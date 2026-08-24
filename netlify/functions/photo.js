import { getStore } from '@netlify/blobs';

function getPhotoStore() {
  return getStore({ name: 'photos' });
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  const store = getPhotoStore();
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const key = url.searchParams.get('key');
    if (!key) return new Response('Falta la foto', { status: 400 });
    try {
      const data = await store.get(key, { type: 'arrayBuffer' });
      if (!data) return new Response('No encontrada', { status: 404 });
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch (err) {
      return new Response('Error del servidor: ' + err.message, { status: 500 });
    }
  }

  if (req.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }

  try {
    const payload = await req.json();
    const code = (payload.groupCode || '').toUpperCase().trim();
    const base64 = (payload.imageBase64 || '').replace(/^data:image\/\w+;base64,/, '');
    const isGlobalAvatar = !!(payload.global && payload.avatarFor);

    if (!base64) return json(400, { error: 'Faltan datos de la foto' });
    if (!isGlobalAvatar && !code) return json(400, { error: 'Faltan datos de la foto' });

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 3 * 1024 * 1024) return json(400, { error: 'La foto es demasiado grande' });

    // Las fotos de perfil usan una clave fija por persona, para que al cambiarla
    // se sustituya en vez de acumular fotos viejas sin usar.
    // Las fotos de perfil "globales" (avatarId del dispositivo) no llevan el
    // código de grupo por delante, así se pueden reutilizar en cualquier grupo.
    const key = isGlobalAvatar
      ? `avatars/${payload.avatarFor}`
      : payload.avatarFor
        ? `${code}/avatar-${payload.avatarFor}`
        : `${code}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.jpg`;
    await store.set(key, buffer);
    return json(200, { photoKey: key });
  } catch (err) {
    return json(500, { error: 'Error del servidor: ' + err.message });
  }
};

export const config = {
  path: '/photo',
};
