// Guarda la app en el teléfono para que abra sin conexión.
// Primero intenta la red (así cada cambio publicado llega enseguida) y, si no hay o tarda, usa la copia guardada.
// Solo toca los archivos de la app: la planilla, las tasas y el lector de tickets siguen yendo siempre a internet.
const CACHE = 'cuentas-casa-v14';
const SHELL = ['./', 'index.html', 'styles.css', 'lib.js', 'charts.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];
const ESPERA_MS = 3500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(desdeLaRed(req));
});

async function desdeLaRed(req) {
  const cache = await caches.open(CACHE);
  // El # y los parámetros no cambian el archivo: la app abierta desde el enlace de conexión también funciona.
  const clave = req.mode === 'navigate' ? 'index.html' : req;
  const red = fetch(req).then((res) => {
    if (res.ok) cache.put(clave, res.clone());
    return res;
  });
  const guardada = await cache.match(clave, { ignoreSearch: true });
  if (!guardada) return red;
  const lenta = new Promise((ok) => setTimeout(() => ok(guardada), ESPERA_MS));
  return Promise.race([red.catch(() => guardada), lenta]);
}
