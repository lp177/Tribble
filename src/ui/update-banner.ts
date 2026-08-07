// The "new version" prompt, and the offline indicator.
//
// Deliberately a corner banner rather than a modal: an update landing mid-run
// must never steal the board or the keyboard. It is polite, dismissible, and
// waits as long as the player wants it to.

export interface UpdateBannerCallbacks {
  onReload(): void
  onDismiss(): void
}

export interface UpdateBannerApi {
  showUpdate(): void
  hideUpdate(): void
  setOffline(offline: boolean): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function createUpdateBanner(
  root: HTMLElement,
  cb: UpdateBannerCallbacks,
): UpdateBannerApi {
  const banner = el('div', 'update-banner')
  banner.hidden = true
  // Announced politely: an update is not worth interrupting a screen reader
  // mid-sentence for.
  banner.setAttribute('role', 'status')
  banner.setAttribute('aria-live', 'polite')

  const text = el('div', 'update-banner__text')
  text.append(
    el('strong', 'update-banner__title', 'New version available'),
    el('span', 'update-banner__hint', 'Your game is saved — reloading is safe.'),
  )

  const actions = el('div', 'update-banner__actions')
  const reload = el('button', 'btn btn--filled btn--small', 'Reload')
  reload.type = 'button'
  const later = el('button', 'btn btn--text btn--small', 'Later')
  later.type = 'button'
  actions.append(later, reload)
  banner.append(text, actions)

  reload.addEventListener('click', () => cb.onReload())
  later.addEventListener('click', () => {
    banner.hidden = true
    cb.onDismiss()
  })

  const offline = el('div', 'offline-chip')
  offline.hidden = true
  offline.setAttribute('role', 'status')
  offline.append(el('span', 'offline-chip__dot'), el('span', undefined, 'Offline — playing from cache'))

  root.append(offline, banner)

  return {
    showUpdate() {
      banner.hidden = false
    },
    hideUpdate() {
      banner.hidden = true
    },
    setOffline(isOffline) {
      offline.hidden = !isOffline
    },
  }
}
