// Keyboard + pointer input. Keyboard listens on window (by KeyboardEvent.code);
// pointer events are scoped to the game canvas. See InputManager in ../types.

import type { GameAction, InputManager, KeyBindings } from '../types'

const ACTIONS: readonly GameAction[] = [
  'aimLeft',
  'aimRight',
  'rotateCW',
  'rotateCCW',
  'launch',
  'useCurse',
  'pause',
]

/** Editable elements keep their keys: no game actions, no preventDefault. */
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable
}

/** Controls that activate on Space/Enter, or navigate with the arrow keys. */
function isActivatable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'OPTION') return true
  if (tag === 'A' && t.hasAttribute('href')) return true
  return t.getAttribute('role') === 'button'
}

/** Keys the browser owns while a control is focused; the game must not eat them. */
const CONTROL_KEYS = new Set(['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

export function createInput(target: HTMLElement, bindings: KeyBindings): InputManager {
  let current = bindings
  const codeToAction = new Map<string, GameAction>()
  const down = new Set<string>()
  const actionCbs = new Set<(action: GameAction) => void>()
  const aimCbs = new Set<(px: number, py: number) => void>()
  const launchCbs = new Set<() => void>()
  const rotateCbs = new Set<() => void>()
  let rebindCb: ((code: string | null) => void) | null = null

  function rebuildMap(): void {
    codeToAction.clear()
    for (const action of ACTIONS) {
      for (const code of current[action]) codeToAction.set(code, action)
    }
  }
  rebuildMap()

  const onKeyDown = (e: KeyboardEvent): void => {
    if (rebindCb !== null) {
      // One-shot capture: swallow the event entirely, Escape cancels.
      const cb = rebindCb
      rebindCb = null
      e.preventDefault()
      e.stopImmediatePropagation()
      cb(e.code === 'Escape' ? null : e.code)
      return
    }
    if (isEditable(e.target)) return
    // A focused button must still activate on Space: swallowing it here would
    // make the menus mouse-only. Escape is not a control key, so pause still
    // works from anywhere.
    if (isActivatable(e.target) && CONTROL_KEYS.has(e.code)) return
    down.add(e.code)
    const action = codeToAction.get(e.code)
    if (action === undefined) return
    // Bound game keys (Space/Arrows...) must not scroll the page.
    e.preventDefault()
    if (e.repeat) return
    for (const fn of actionCbs) fn(action)
  }

  const onKeyUp = (e: KeyboardEvent): void => {
    down.delete(e.code)
  }

  const onWindowBlur = (): void => {
    down.clear()
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (aimCbs.size === 0) return
    const rect = target.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    for (const fn of aimCbs) fn(px, py)
  }

  const onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return
    for (const fn of launchCbs) fn()
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    for (const fn of rotateCbs) fn()
  }

  const onAuxClick = (e: MouseEvent): void => {
    // Middle click only; right click is handled (and suppressed) by contextmenu.
    if (e.button !== 1) return
    e.preventDefault()
    for (const fn of rotateCbs) fn()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onWindowBlur)
  target.addEventListener('pointermove', onPointerMove)
  target.addEventListener('click', onClick)
  target.addEventListener('contextmenu', onContextMenu)
  target.addEventListener('auxclick', onAuxClick)

  return {
    get bindings(): KeyBindings {
      return current
    },
    setBindings(b: KeyBindings): void {
      current = b
      rebuildMap()
    },
    isDown(action: GameAction): boolean {
      for (const code of current[action]) {
        if (down.has(code)) return true
      }
      return false
    },
    onAction(fn: (action: GameAction) => void): () => void {
      actionCbs.add(fn)
      return () => {
        actionCbs.delete(fn)
      }
    },
    onPointerAim(fn: (px: number, py: number) => void): () => void {
      aimCbs.add(fn)
      return () => {
        aimCbs.delete(fn)
      }
    },
    onPointerLaunch(fn: () => void): () => void {
      launchCbs.add(fn)
      return () => {
        launchCbs.delete(fn)
      }
    },
    onPointerRotate(fn: () => void): () => void {
      rotateCbs.add(fn)
      return () => {
        rotateCbs.delete(fn)
      }
    },
    startRebind(cb: (code: string | null) => void): void {
      rebindCb = cb
    },
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)
      target.removeEventListener('pointermove', onPointerMove)
      target.removeEventListener('click', onClick)
      target.removeEventListener('contextmenu', onContextMenu)
      target.removeEventListener('auxclick', onAuxClick)
      rebindCb = null
      down.clear()
      actionCbs.clear()
      aimCbs.clear()
      launchCbs.clear()
      rotateCbs.clear()
    },
  }
}
