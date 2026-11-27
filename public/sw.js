// Service Worker seguro de FacturaYa Venezuela (v5.6.0)
// REGLA FISCAL INQUEBRANTABLE: JAMÁS cachea /api/*, /descargar-cf/* ni peticiones POST/PUT/DELETE.
// Solo resguarda la carcasa estática para arranque instantáneo y aviso limpio cuando no hay internet.
const CACHE_NAME = "facturaya-shell-v560";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/estilos.css",
  "/logo-oficial.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/manifest.webmanifest",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Nunca interceptar rutas de API, descargas ni scripts internos de vista previa
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/descargar-cf/") ||
    url.pathname === "/__preview_compat.js" ||
    url.pathname.endsWith(".zip")
  ) {
    return;
  }

  // Estrategia Network-First para HTML, JS y CSS: siempre toma la versión más fresca en producción
  // y solo recurre al caché si no hay conexión a internet.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copia = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === "navigate") {
          const idx = await caches.match("/index.html", { ignoreSearch: true });
          if (idx) return idx;
        }
        return new Response("Sin conexión a internet. Reconecta para continuar operando FacturaYa Venezuela.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })
  );
});
