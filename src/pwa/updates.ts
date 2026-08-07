// Service worker registration and the update handshake.
//
// The worker serves the app from cache so it starts instantly and plays
// offline, which means a new deploy is NOT picked up by a plain refresh — the
// cached shell is what refreshes. So the app has to go looking for updates
// itself, and hand the decision to the player rather than swapping the bundle
// out from under a run in progress.

export interface UpdateController {
  /** Fires once a new version is installed and parked, waiting to take over. */
  onUpdateReady(fn: () => void): void
  /** Fires on connectivity changes (versus needs the network; the game does not). */
  onOnlineChange(fn: (online: boolean) => void): void
  /** Ask the waiting worker to take over, then reload onto the new version. */
  applyUpdate(): void
  /** Poll for a new deploy. Safe to call often; a no-op when unsupported. */
  checkForUpdate(): void
  readonly online: boolean
}

/** How often a left-open tab re-checks for a new deploy. */
const POLL_MS = 15 * 60 * 1000
/** How often we confirm the network is actually reachable. */
const PROBE_MS = 20 * 1000

export function initUpdates(): UpdateController {
  const readyFns: Array<() => void> = []
  const onlineFns: Array<(online: boolean) => void> = []
  let registration: ServiceWorkerRegistration | null = null
  let announced = false
  let reloading = false

  const announce = (): void => {
    if (announced) return
    announced = true
    for (const fn of readyFns) fn()
  }

  const watch = (worker: ServiceWorker | null): void => {
    if (!worker) return
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      announce()
      return
    }
    worker.addEventListener('statechange', () => {
      // A worker reaching `installed` while one already controls the page means
      // a genuine update. Without a controller this is just the first install,
      // which is not something to interrupt anyone about.
      if (worker.state === 'installed' && navigator.serviceWorker.controller) announce()
    })
  }

  const supported = 'serviceWorker' in navigator
  if (supported && !import.meta.env.DEV) {
    // Registering after load keeps the worker off the critical path.
    window.addEventListener('load', () => {
      navigator.serviceWorker
        // Resolved against the DOCUMENT, not this module: the bundle lives in
        // assets/, and registering from there would scope the worker to
        // assets/ and never control the page.
        // `updateViaCache: 'none'` so the worker script itself is never served
        // from the HTTP cache — otherwise the update check can be stale.
        .register(new URL('sw.js', document.baseURI).href, {
          type: 'classic',
          updateViaCache: 'none',
        })
        .then((reg) => {
          registration = reg
          if (reg.waiting && navigator.serviceWorker.controller) announce()
          watch(reg.installing)
          reg.addEventListener('updatefound', () => watch(reg.installing))
        })
        .catch(() => {
          /* No worker: the game still runs, just without offline support. */
        })
    })

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloading) return
      reloading = false
      window.location.reload()
    })

    // A tab left open for days should still notice a deploy.
    window.setInterval(() => registration?.update().catch(() => {}), POLL_MS)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration?.update().catch(() => {})
    })
  }

  // `navigator.onLine` only reports whether an interface exists — it stays true
  // behind a captive portal or a dead uplink — so it is treated as a hint that
  // triggers a probe, never as the answer. A HEAD is not a GET, so the worker
  // passes it straight through to the network instead of serving it from cache.
  let online = navigator.onLine
  const setOnline = (next: boolean): void => {
    if (next === online) return
    online = next
    for (const fn of onlineFns) fn(next)
  }

  const probe = async (): Promise<void> => {
    if (!navigator.onLine) {
      setOnline(false)
      return
    }
    try {
      await fetch(new URL('sw.js', document.baseURI).href, {
        method: 'HEAD',
        cache: 'no-store',
      })
      setOnline(true)
    } catch {
      setOnline(false)
    }
  }

  window.addEventListener('online', () => void probe())
  window.addEventListener('offline', () => setOnline(false))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void probe()
  })
  window.setInterval(() => void probe(), PROBE_MS)
  void probe()

  return {
    onUpdateReady(fn) {
      readyFns.push(fn)
      if (announced) fn()
    },
    onOnlineChange(fn) {
      onlineFns.push(fn)
      // The first probe may already have resolved, so hand over current state
      // rather than leaving the caller waiting for a change that has passed.
      fn(online)
    },
    applyUpdate() {
      const waiting = registration?.waiting
      if (!waiting) {
        window.location.reload()
        return
      }
      reloading = true
      waiting.postMessage({ type: 'SKIP_WAITING' })
      // If the worker never activates (edge cases, or it was already gone),
      // reload anyway rather than leaving the player stuck on a dead prompt.
      window.setTimeout(() => {
        if (reloading) {
          reloading = false
          window.location.reload()
        }
      }, 3000)
    },
    checkForUpdate() {
      registration?.update().catch(() => {})
      void probe()
    },
    get online() {
      return online
    },
  }
}
