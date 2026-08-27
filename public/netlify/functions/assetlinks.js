// Sirve el archivo de verificacion de Android (Digital Asset Links) en
// /.well-known/assetlinks.json sin necesidad de subir un archivo suelto
// con carpeta oculta a GitHub. Esta funcion genera esa respuesta directamente.

const ASSET_LINKS = [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'app.apokinapasta.twa',
      sha256_cert_fingerprints: [
        '2A:EA:16:DE:BF:68:1B:37:94:4A:06:5F:A7:C9:44:6C:B1:03:34:32:7A:95:38:FC:9D:3E:45:93:F9:DA:81:FE',
      ],
    },
  },
];

export default async () => {
  return new Response(JSON.stringify(ASSET_LINKS), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/.well-known/assetlinks.json',
};
