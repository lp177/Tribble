// localStorage persistence: save game, settings, best score, auto-save.
// Every storage access is wrapped so private mode / quota errors degrade to
// "no save" instead of throwing.

import {
  COLS,
  DEFAULT_SETTINGS,
  ROWS,
  type GameAction,
  type KeyBindings,
  type SaveGame,
  type Settings,
} from '../types'

const SAVE_KEY = 'tribble.save.v1'
const SETTINGS_KEY = 'tribble.settings.v1'
const BEST_KEY = 'tribble.best.v1'
const AUTOSAVE_INTERVAL_MS = 5000

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Quota exceeded / private mode: silently drop.
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore.
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// -- Save game ---------------------------------------------------------------

export function loadSave(): SaveGame | null {
  const raw = read(SAVE_KEY)
  if (raw === null) return null
  try {
    const data: unknown = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return null
    const s = data as Partial<SaveGame>
    if (s.version !== 1) return null
    if (!Array.isArray(s.grid) || s.grid.length !== ROWS * COLS) return null
    if (typeof s.current !== 'object' || s.current === null) return null
    if (typeof s.next !== 'object' || s.next === null) return null
    if (!Array.isArray(s.bag)) return null
    if (
      typeof s.bagRngState !== 'number' ||
      typeof s.miscRngState !== 'number' ||
      typeof s.score !== 'number' ||
      typeof s.riseTimer !== 'number' ||
      typeof s.riseInterval !== 'number'
    ) {
      return null
    }
    return s as SaveGame
  } catch {
    return null
  }
}

export function storeSave(save: SaveGame): void {
  write(SAVE_KEY, JSON.stringify(save))
}

export function clearSave(): void {
  remove(SAVE_KEY)
}

// -- Settings ----------------------------------------------------------------

/**
 * Stored partials are deep-merged over DEFAULT_SETTINGS so fields or actions
 * added in later versions keep their defaults instead of being lost.
 */
export function loadSettings(): Settings {
  let stored: Partial<Settings> = {}
  const raw = read(SETTINGS_KEY)
  if (raw !== null) {
    try {
      const data: unknown = JSON.parse(raw)
      if (typeof data === 'object' && data !== null) stored = data as Partial<Settings>
    } catch {
      // Corrupt JSON: fall through to defaults.
    }
  }

  // Bindings merge per action; unknown/invalid entries fall back to defaults.
  const storedBindings =
    typeof stored.bindings === 'object' && stored.bindings !== null
      ? (stored.bindings as Partial<Record<GameAction, unknown>>)
      : null
  const bindings = {} as KeyBindings
  for (const action of Object.keys(DEFAULT_SETTINGS.bindings) as GameAction[]) {
    const codes = storedBindings === null ? undefined : storedBindings[action]
    bindings[action] =
      Array.isArray(codes) && codes.every((c): c is string => typeof c === 'string')
        ? [...codes]
        : [...DEFAULT_SETTINGS.bindings[action]]
  }

  const merged: Settings = { ...DEFAULT_SETTINGS, bindings }
  if (typeof stored.masterVolume === 'number') {
    merged.masterVolume = clamp01(stored.masterVolume)
  }
  if (typeof stored.sfxVolume === 'number') merged.sfxVolume = clamp01(stored.sfxVolume)
  if (typeof stored.musicVolume === 'number') {
    merged.musicVolume = clamp01(stored.musicVolume)
  }
  if (
    stored.reducedMotion === 'auto' ||
    stored.reducedMotion === 'on' ||
    stored.reducedMotion === 'off'
  ) {
    merged.reducedMotion = stored.reducedMotion
  }
  if (typeof stored.playerName === 'string' && stored.playerName.length > 0) {
    merged.playerName = stored.playerName
  }
  return merged
}

export function storeSettings(settings: Settings): void {
  write(SETTINGS_KEY, JSON.stringify(settings))
}

// -- Best score --------------------------------------------------------------

export function loadBest(): number {
  const raw = read(BEST_KEY)
  if (raw === null) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function storeBest(best: number): void {
  write(BEST_KEY, String(best))
}

// -- Auto-save ---------------------------------------------------------------

/**
 * Saves on tab hide, page unload and every 5 s. `get()` returning null means
 * "nothing to save right now" — the existing save is left untouched.
 * Returns an uninstall function.
 */
export function installAutoSave(get: () => SaveGame | null): () => void {
  const persist = (): void => {
    const save = get()
    if (save !== null) storeSave(save)
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') persist()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', persist)
  const interval = window.setInterval(persist, AUTOSAVE_INTERVAL_MS)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', persist)
    window.clearInterval(interval)
  }
}
