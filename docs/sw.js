/*
 * Tribble service worker.
 *
 * Plain JS on purpose: this file is not part of the app bundle. It ships as-is
 * except for the two placeholders below, which `scripts/build-sw.mjs` replaces
 * with the real build id and the hashed filenames Vite emitted.
 *
 * Strategy, per resource kind:
 *   navigations   -> the precached shell, cache-first (instant, works offline)
 *   /assets/*     -> cache-first (filenames are content-hashed, so immutable)
 *   other GETs    -> stale-while-revalidate
 *   cross-origin  -> not intercepted at all (PeerJS signalling must stay live)
 *
 * Updates are driven by this file changing: a new build changes BUILD_ID, the
 * browser byte-compares sw.js, installs the new worker and parks it in
 * `waiting`. We deliberately do NOT skipWaiting on our own — swapping the
 * bundle under a running game would be rude — so the page asks the player and
 * posts SKIP_WAITING when they accept.
 */

const BUILD_ID = '5f7c9e23b542'
const PRECACHE = [
  "./index.html",
  "./manifest.webmanifest",
  "./assets/index-CxUyBSQX.js",
  "./assets/index-RHAimDPD.css",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png"
]

const CACHE = `tribble-${BUILD_ID}`
/** Everything we serve the shell for; keep in sync with the app's routes. */
const SHELL = './index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // reload: bypass the HTTP cache while precaching, or a stale index.html
      // sitting in the browser cache would be baked into the new version.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.map((name) =>
          name !== CACHE && name.startsWith('tribble-') ? caches.delete(name) : undefined,
        ),
      )
      // Enable navigation preload where supported so a cache miss on a
      // navigation does not wait for the worker to boot.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {})
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting()
  if (data && data.type === 'GET_BUILD_ID') {
    event.source?.postMessage({ type: 'BUILD_ID', buildId: BUILD_ID })
  }
})

async function cacheFirst(request, preload) {
  const cached = await caches.match(request, { ignoreSearch: false })
  if (cached) return cached
  try {
    const preloaded = preload ? await preload : null
    const response = preloaded ?? (await fetch(request))
    if (response && response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const shell = await caches.match(SHELL)
    return shell ?? Response.error()
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request)
  const network = fetch(request)
    .then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE)
        cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => null)
  const response = cached ?? (await network)
  return response ?? Response.error()
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Never touch the signalling server or any other origin: intercepting those
  // would break versus mode and gain nothing.
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shell = await caches.match(SHELL)
        if (shell) return shell
        return cacheFirst(request, event.preloadResponse)
      })(),
    )
    return
  }

  // Content-hashed bundles never change under a given name.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request, null))
    return
  }

  event.respondWith(staleWhileRevalidate(request))
})
