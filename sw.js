/* BibleWay service worker: offline-first shell + verse pages, network-first APIs.
 * Versioned cache; old caches are purged on activate. No build step: plain JS served as-is. */
const VERSION = "bw-v2";
const STATIC = `${VERSION}-static`;
const PAGES = `${VERSION}-pages`;

const PRECACHE = ["/", "/offline", "/manifest.webmanifest", "/icon.svg", "/globals.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })))).catch(() => {}).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

const isApi = (url) => url.pathname.startsWith("/api/");
const disallowsCaching = (response) => (response.headers.get("Cache-Control") || "")
  .split(",").some((directive) => /^(?:private|no-store)(?:\s*=|$)/i.test(directive.trim()));
const isPage = (req, url) =>
  req.method === "GET" && req.mode === "navigate" && !url.pathname.startsWith("/api/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts, supabase, tiles: leave alone
  if (request.method !== "GET") return;

  if (isApi(url)) {
    // Stale-while-revalidate for read-only APIs (words, xrefs, context, learn, passage).
    const lookup = caches.open(PAGES).then(async (cache) => {
      let hit = await cache.match(request);
      // Older workers stored cookie-dependent passages despite private, no-store.
      if (hit && disallowsCaching(hit)) { hit = undefined; await cache.delete(request).catch(() => {}); }
      return { cache, hit };
    });
    const net = lookup.then(async ({ cache }) => {
      const res = await fetch(request);
      if (disallowsCaching(res)) await cache.delete(request).catch(() => {});
      else if (res.ok) await cache.put(request, res.clone()).catch(() => {});
      return res;
    });
    // A cached response can finish before revalidation; keep its fetch and cache write alive.
    event.waitUntil(net.then(() => {}, () => {}));
    event.respondWith(lookup.then(({ hit }) => hit || net.catch(() => Response.error())));
    return;
  }
  if (isPage(request, url)) {
    // Network-first pages with cache fallback, then the offline page.
    event.respondWith(
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(PAGES).then((c) => { if (res.ok) c.put(request, copy); }).catch(() => {});
        return res;
      }).catch(async () => {
        const cache = await caches.open(PAGES);
        return (await cache.match(request)) || (await cache.match("/offline")) || Response.error();
      }),
    );
  }
});
