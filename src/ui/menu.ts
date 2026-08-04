// Tribble — menus. Builds every screen as DOM inside the UI overlay root.
// Dark Material / paper-elements flavored; all styling lives in src/style.css.

import {
  DEFAULT_BINDINGS,
  type GameAction,
  type GameOverData,
  type KeyBindings,
  type MenuApi,
  type MenuCallbacks,
  type Screen,
  type Settings,
  type VersusEndData,
} from '../types'

const ACTIONS: readonly GameAction[] = [
  'aimLeft',
  'aimRight',
  'rotateCW',
  'rotateCCW',
  'launch',
  'useCurse',
  'pause',
]

const ACTION_LABEL: Record<GameAction, string> = {
  aimLeft: 'Aim left',
  aimRight: 'Aim right',
  rotateCW: 'Rotate clockwise',
  rotateCCW: 'Rotate counter-clockwise',
  launch: 'Launch piece',
  useCurse: 'Send curse',
  pause: 'Pause',
}

const NAMED_KEYS: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/** Ripple animation length in style.css, plus slack: the removal safety net. */
const RIPPLE_FALLBACK_MS = 900

let motionQuery: MediaQueryList | null = null

/**
 * True when menu animations must be suppressed: the system preference, or the
 * app's own override if it marked the document root with one.
 */
function prefersReducedMotion(): boolean {
  const rootEl = document.documentElement
  const flag = rootEl.dataset.reducedMotion
  if (flag === 'on' || flag === 'true') return true
  if (flag === 'off' || flag === 'false') return false
  if (rootEl.classList.contains('reduced-motion')) return true
  if (motionQuery === null) motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  return motionQuery.matches
}

function keyLabel(code: string): string {
  const named = NAMED_KEYS[code]
  if (named !== undefined) return named
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function cloneSettings(s: Settings): Settings {
  const bindings = {} as KeyBindings
  for (const action of ACTIONS) bindings[action] = s.bindings[action].slice()
  return {
    version: s.version,
    bindings,
    masterVolume: s.masterVolume,
    sfxVolume: s.sfxVolume,
    musicVolume: s.musicVolume,
    reducedMotion: s.reducedMotion,
    playerName: s.playerName,
  }
}

/** An in-flight key capture, so it can be cancelled when the user walks away. */
interface RebindCapture {
  action: GameAction
  row: HTMLButtonElement
  /** Generation counter; a callback with a stale token is ignored. */
  token: number
  /** The callback handed to the input layer; null releases its one-shot. */
  done: (code: string | null) => void
}

function isGameOverData(d: GameOverData | VersusEndData | undefined): d is GameOverData {
  return d !== undefined && 'best' in d
}

function isVersusEndData(d: GameOverData | VersusEndData | undefined): d is VersusEndData {
  return d !== undefined && 'result' in d
}

export function createMenu(
  root: HTMLElement,
  settings: Settings,
  cb: MenuCallbacks,
): MenuApi {
  let current: Settings = cloneSettings(settings)
  let visible: Screen | null = null
  /** Where Escape / Back returns from settings & how-to. */
  let origin: Screen = 'title'
  /** Set while the input layer is capturing a key for a rebind. */
  let capture: RebindCapture | null = null
  /** Bumped per capture so a callback from a cancelled one is ignored. */
  let captureToken = 0

  const layer = el('div', 'menu-layer')
  const screens = new Map<Screen, HTMLElement>()

  // -- helpers --------------------------------------------------------------

  function playRipple(host: HTMLElement, cx: number, cy: number): void {
    // Reduced motion hides the ripple in CSS, so its animation never ends and
    // the span would leak: don't create one at all.
    if (prefersReducedMotion()) return
    const rect = host.getBoundingClientRect()
    const radius = Math.hypot(
      Math.max(cx, rect.width - cx),
      Math.max(cy, rect.height - cy),
    )
    const span = el('span', 'ripple')
    span.style.width = `${radius * 2}px`
    span.style.height = `${radius * 2}px`
    span.style.left = `${cx - radius}px`
    span.style.top = `${cy - radius}px`
    // Belt and braces: if animationend never arrives (hidden tab, a CSS
    // override, an interrupted animation), the timer still removes the node.
    let timer = 0
    const remove = (): void => {
      window.clearTimeout(timer)
      span.remove()
    }
    timer = window.setTimeout(remove, RIPPLE_FALLBACK_MS)
    span.addEventListener('animationend', remove)
    host.appendChild(span)
  }

  function attachInteractions(node: HTMLElement): void {
    node.addEventListener('pointerdown', (e) => {
      const rect = node.getBoundingClientRect()
      playRipple(node, e.clientX - rect.left, e.clientY - rect.top)
    })
    node.addEventListener('click', (e) => {
      // detail === 0 means keyboard activation: ripple from the centre.
      if (e.detail === 0) {
        playRipple(node, node.clientWidth / 2, node.clientHeight / 2)
      }
      cb.onUiSound('click')
    })
    node.addEventListener('pointerenter', () => cb.onUiSound('hover'))
  }

  function button(
    label: string,
    variant: 'filled' | 'tonal' | 'text' | 'accent' | 'danger',
    onClick: () => void,
    extra?: string,
  ): HTMLButtonElement {
    const b = el('button', `btn btn--${variant}${extra !== undefined ? ` ${extra}` : ''}`, label)
    b.type = 'button'
    attachInteractions(b)
    b.addEventListener('click', onClick)
    return b
  }

  function section(id: Screen, headingId: string): HTMLElement {
    const s = el('section', 'screen')
    s.id = `screen-${id}`
    s.hidden = true
    s.setAttribute('aria-labelledby', headingId)
    layer.appendChild(s)
    screens.set(id, s)
    return s
  }

  function focusables(host: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = []
    const nodes = host.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    for (const n of nodes) {
      if (n.hidden) continue
      if (n.getClientRects().length === 0) continue
      out.push(n)
    }
    return out
  }

  function emitSettings(): void {
    cb.onSettingsChanged(cloneSettings(current))
  }

  // -- Title ----------------------------------------------------------------

  const titleScreen = section('title', 'title-heading')
  const titleCard = el('div', 'card card--narrow title-card')
  const wordmark = el('h1', 'wordmark', 'TRIBBLE')
  wordmark.id = 'title-heading'
  const tagline = el(
    'p',
    'tagline',
    'Tetris meets bubble shooter — aim, rotate, launch, and keep the stack down.',
  )
  const titleMenu = el('nav', 'title-menu')
  titleMenu.setAttribute('aria-label', 'Main menu')

  const resumeBtn = button('Resume run', 'filled', () => cb.onResume(), 'btn--lg btn--block')
  resumeBtn.hidden = true
  const newGameBtn = button('New game', 'filled', () => cb.onNewGame(), 'btn--lg btn--block')
  const versusBtn = button('Versus', 'tonal', () => cb.onOpenVersus(), 'btn--block')
  const howtoBtn = button(
    'How to play',
    'tonal',
    () => {
      origin = 'title'
      show('howto')
    },
    'btn--block',
  )
  const settingsBtn = button(
    'Settings',
    'text',
    () => {
      origin = 'title'
      show('settings')
    },
    'btn--block',
  )
  titleMenu.append(resumeBtn, newGameBtn, versusBtn, howtoBtn, settingsBtn)
  titleCard.append(
    wordmark,
    tagline,
    titleMenu,
    el('p', 'title-foot', 'Clear full lines — or connect 3+ blocks of the same colour.'),
  )
  titleScreen.appendChild(titleCard)

  // -- Settings -------------------------------------------------------------

  const settingsScreen = section('settings', 'settings-heading')
  const settingsCard = el('div', 'card')
  const settingsHeading = el('h2', 'card-title', 'Settings')
  settingsHeading.id = 'settings-heading'
  const settingsBody = el('div', 'card-body scroll-y')

  function slider(
    labelText: string,
    id: string,
    get: () => number,
    set: (v: number) => void,
  ): { row: HTMLElement; sync: () => void; input: HTMLInputElement } {
    const row = el('div', 'slider-row')
    const label = el('label', 'field-label', labelText)
    label.htmlFor = id
    const value = el('span', 'slider-value')
    const input = el('input', 'slider')
    input.type = 'range'
    input.id = id
    input.min = '0'
    input.max = '1'
    input.step = '0.01'
    const sync = (): void => {
      const v = get()
      input.value = String(v)
      const pct = `${Math.round(v * 100)}%`
      input.style.setProperty('--slider-fill', pct)
      value.textContent = pct
      input.setAttribute('aria-valuetext', pct)
    }
    input.addEventListener('input', () => {
      set(Number(input.value))
      sync()
      emitSettings()
    })
    row.append(label, value, input)
    return { row, sync, input }
  }

  const masterSlider = slider(
    'Master volume',
    'set-master',
    () => current.masterVolume,
    (v) => {
      current.masterVolume = v
    },
  )
  const sfxSlider = slider(
    'Sound effects',
    'set-sfx',
    () => current.sfxVolume,
    (v) => {
      current.sfxVolume = v
    },
  )
  const musicSlider = slider(
    'Music',
    'set-music',
    () => current.musicVolume,
    (v) => {
      current.musicVolume = v
    },
  )

  const audioGroup = el('div', 'settings-group')
  audioGroup.append(
    el('h3', 'group-title', 'Audio'),
    masterSlider.row,
    sfxSlider.row,
    musicSlider.row,
  )

  const motionField = el('div', 'field')
  const motionLabel = el('label', 'field-label', 'Reduced motion')
  motionLabel.htmlFor = 'set-motion'
  const motionSelect = el('select', 'select')
  motionSelect.id = 'set-motion'
  for (const [value, text] of [
    ['auto', 'Auto (follow system)'],
    ['on', 'On (calm visuals)'],
    ['off', 'Off (full juice)'],
  ] as const) {
    const opt = el('option', undefined, text)
    opt.value = value
    motionSelect.appendChild(opt)
  }
  motionSelect.addEventListener('change', () => {
    const v = motionSelect.value
    current.reducedMotion = v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto'
    emitSettings()
  })
  motionField.append(motionLabel, motionSelect)

  const nameField = el('div', 'field')
  const nameLabel = el('label', 'field-label', 'Player name (versus)')
  nameLabel.htmlFor = 'set-name'
  const nameInput = el('input', 'text-input')
  nameInput.id = 'set-name'
  nameInput.type = 'text'
  nameInput.maxLength = 16
  nameInput.autocomplete = 'off'
  nameInput.placeholder = 'Player'
  nameInput.addEventListener('input', () => {
    current.playerName = nameInput.value.slice(0, 16)
    emitSettings()
  })
  nameField.append(nameLabel, nameInput)

  const generalGroup = el('div', 'settings-group')
  generalGroup.append(el('h3', 'group-title', 'General'), motionField, nameField)

  const bindGroup = el('div', 'settings-group')
  const bindList = el('ul', 'bind-list')
  const bindKeyNodes = new Map<GameAction, HTMLElement>()
  const bindRowNodes = new Map<GameAction, HTMLButtonElement>()

  function renderBindKeys(action: GameAction): void {
    const host = bindKeyNodes.get(action)
    if (host === undefined) return
    host.textContent = ''
    const codes = current.bindings[action]
    if (codes.length === 0) {
      host.appendChild(el('kbd', 'keycap keycap--empty', 'unbound'))
      return
    }
    for (const code of codes) host.appendChild(el('kbd', 'keycap', keyLabel(code)))
  }

  function renderAllBindKeys(): void {
    for (const action of ACTIONS) renderBindKeys(action)
  }

  /**
   * Give `code` to `action` alone: any other action holding it loses it, so a
   * key is never bound twice (an action left with none renders as unbound).
   */
  function assignBinding(action: GameAction, code: string): void {
    for (const other of ACTIONS) {
      if (other === action) continue
      const codes = current.bindings[other]
      const at = codes.indexOf(code)
      if (at >= 0) codes.splice(at, 1)
    }
    current.bindings[action] = [code]
    renderAllBindKeys()
    emitSettings()
  }

  /** Drop an armed capture: restore the row and release the input one-shot. */
  function cancelRebind(): void {
    const active = capture
    if (active === null) return
    capture = null
    active.row.classList.remove('is-listening')
    renderBindKeys(active.action)
    // Same path Escape takes, so the input layer stops waiting for a key.
    active.done(null)
  }

  for (const action of ACTIONS) {
    const item = el('li')
    const row = el('button', 'bind-row')
    row.type = 'button'
    row.setAttribute('aria-label', `${ACTION_LABEL[action]}: change key binding`)
    const name = el('span', 'bind-name', ACTION_LABEL[action])
    const keys = el('span', 'bind-keys')
    row.append(name, keys)
    attachInteractions(row)
    row.addEventListener('click', () => {
      if (capture !== null) return
      const token = ++captureToken
      const done = (code: string | null): void => {
        // A late answer from a capture we already cancelled must change nothing.
        if (capture === null || capture.token !== token) return
        capture = null
        row.classList.remove('is-listening')
        if (code !== null) {
          assignBinding(action, code)
        } else {
          renderBindKeys(action)
        }
        row.focus()
      }
      capture = { action, row, token, done }
      row.classList.add('is-listening')
      keys.textContent = ''
      keys.appendChild(el('span', 'bind-hint', 'Press a key… (Esc cancels)'))
      cb.onRebindRequest(action, done)
    })
    bindKeyNodes.set(action, keys)
    bindRowNodes.set(action, row)
    item.appendChild(row)
    bindList.appendChild(item)
  }

  const resetBindingsBtn = button('Reset to defaults', 'text', () => {
    for (const action of ACTIONS) current.bindings[action] = DEFAULT_BINDINGS[action].slice()
    renderAllBindKeys()
    emitSettings()
  })

  bindGroup.append(
    el('h3', 'group-title', 'Controls'),
    el(
      'p',
      'card-sub',
      'Select a row, then press the key you want. Mouse: move to aim, click to launch, right-click to rotate.',
    ),
    bindList,
    resetBindingsBtn,
  )

  const settingsActions = el('div', 'card-actions')
  const settingsBackBtn = button('Back', 'filled', () => goBack())
  settingsActions.append(settingsBackBtn)

  settingsBody.append(audioGroup, el('hr', 'divider'), generalGroup, el('hr', 'divider'), bindGroup)
  settingsCard.append(settingsHeading, settingsBody, settingsActions)
  settingsScreen.appendChild(settingsCard)

  // -- How to play ----------------------------------------------------------

  const howtoScreen = section('howto', 'howto-heading')
  const howtoCard = el('div', 'card')
  const howtoHeading = el('h2', 'card-title', 'How to play')
  howtoHeading.id = 'howto-heading'
  const howtoBody = el('div', 'card-body scroll-y')
  const howtoList = el('ul', 'howto-list')

  const HOWTO: ReadonlyArray<readonly [string, string]> = [
    ['🎯', 'Aim with the dotted line — it bounces off the side walls, so bank your shots.'],
    ['🔄', 'Rotate before AND during flight. Mid-air rotations are the whole skill ceiling.'],
    ['🚀', 'Launch the piece downward onto the stack. It snaps into place and settles.'],
    ['📏', 'Clear a full horizontal line, Tetris style.'],
    ['🎨', 'Or connect 3 or more blocks of the same colour — they pop, bubble-shooter style.'],
    ['⛓️', 'Blocks fall after a clear: trigger a new clear and you score a chain (×2 per step).'],
    ['⬆️', 'The stack keeps rising from the bottom. If it reaches the launcher zone, you lose.'],
    ['🔮', 'In versus, clears spawn power bubbles — catch one with your flying piece to store it.'],
    ['💀', 'Send stored curses to your opponent: garbage 🧱, speed ⚡, fog 🌫️, scramble 🎲, mirror 🪞, rotation lock 🔒.'],
  ]
  for (const [emoji, text] of HOWTO) {
    const li = el('li')
    const icon = el('span', 'howto-emoji', emoji)
    icon.setAttribute('aria-hidden', 'true')
    li.append(icon, el('span', undefined, text))
    howtoList.appendChild(li)
  }

  const howtoKeys = el('div', 'howto-keys')
  const howtoKeyNodes = new Map<GameAction, HTMLElement>()
  for (const action of ACTIONS) {
    const row = el('div', 'howto-key-row')
    const keys = el('span', 'bind-keys')
    row.append(el('span', undefined, ACTION_LABEL[action]), keys)
    howtoKeyNodes.set(action, keys)
    howtoKeys.appendChild(row)
  }

  function renderHowtoKeys(): void {
    for (const action of ACTIONS) {
      const host = howtoKeyNodes.get(action)
      if (host === undefined) continue
      host.textContent = ''
      const codes = current.bindings[action]
      if (codes.length === 0) {
        host.appendChild(el('kbd', 'keycap keycap--empty', 'unbound'))
        continue
      }
      for (const code of codes) host.appendChild(el('kbd', 'keycap', keyLabel(code)))
    }
  }

  const howtoActions = el('div', 'card-actions')
  howtoActions.append(button('Back', 'filled', () => goBack()))
  howtoBody.append(
    howtoList,
    el('hr', 'divider'),
    el('h3', 'group-title', 'Controls'),
    howtoKeys,
  )
  howtoCard.append(howtoHeading, howtoBody, howtoActions)
  howtoScreen.appendChild(howtoCard)

  // -- Versus lobby ---------------------------------------------------------

  const lobbyScreen = section('versus-lobby', 'lobby-heading')
  const lobbyCard = el('div', 'card card--wide')
  const lobbyHeading = el('h2', 'card-title', 'Versus')
  lobbyHeading.id = 'lobby-heading'
  const lobbyBody = el('div', 'card-body scroll-y')
  const lobbyPanels = el('div', 'lobby-panels')

  const hostPanel = el('div', 'panel')
  const hostBtn = button('Host game', 'filled', () => {
    setVersusCode(null)
    setVersusStatus('Creating room…')
    cb.onHostGame()
  })
  const roomCode = el('output', 'room-code')
  roomCode.hidden = true
  roomCode.id = 'room-code'
  const hostNote = el('p', 'panel-note', 'Create a room and share the 5-character code.')
  hostPanel.append(el('h3', 'panel-title', 'Host game'), hostNote, hostBtn, roomCode)

  const joinPanel = el('div', 'panel')
  const joinField = el('div', 'field')
  const joinLabel = el('label', 'field-label', 'Room code')
  joinLabel.htmlFor = 'join-code'
  const joinInput = el('input', 'text-input text-input--code')
  joinInput.id = 'join-code'
  joinInput.type = 'text'
  joinInput.maxLength = 5
  joinInput.autocomplete = 'off'
  joinInput.spellcheck = false
  joinInput.placeholder = 'ABC23'
  joinInput.setAttribute('autocapitalize', 'characters')
  joinInput.addEventListener('input', () => {
    const clean = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (clean !== joinInput.value) joinInput.value = clean
    joinBtn.disabled = clean.length === 0
  })
  joinField.append(joinLabel, joinInput)
  const joinBtn = button('Join', 'accent', () => {
    const code = joinInput.value.trim().toUpperCase()
    if (code.length === 0) return
    setVersusCode(null)
    setVersusStatus('Joining room…')
    cb.onJoinGame(code)
  })
  joinBtn.disabled = true
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && joinInput.value.trim().length > 0) {
      e.preventDefault()
      joinBtn.click()
    }
  })
  joinPanel.append(
    el('h3', 'panel-title', 'Join game'),
    el('p', 'panel-note', "Enter the code your opponent gave you."),
    joinField,
    joinBtn,
  )

  lobbyPanels.append(hostPanel, joinPanel)
  const lobbyStatus = el('p', 'status-line')
  lobbyStatus.setAttribute('role', 'status')
  lobbyStatus.setAttribute('aria-live', 'polite')
  const lobbyActions = el('div', 'card-actions')
  lobbyActions.append(button('Cancel', 'text', () => cb.onCancelVersus()))
  lobbyBody.append(
    el('p', 'card-sub', 'Both players play their own board with the same piece sequence. Top out and you lose.'),
    lobbyPanels,
    lobbyStatus,
  )
  lobbyCard.append(lobbyHeading, lobbyBody, lobbyActions)
  lobbyScreen.appendChild(lobbyCard)

  // -- Paused ---------------------------------------------------------------

  const pausedScreen = section('paused', 'paused-heading')
  const pausedCard = el('div', 'card card--narrow')
  const pausedHeading = el('h2', 'card-title', 'Paused')
  pausedHeading.id = 'paused-heading'
  const pausedActions = el('div', 'card-actions card-actions--stack')
  pausedActions.append(
    button('Resume', 'filled', () => cb.onPauseResume(), 'btn--lg btn--block'),
    button(
      'Settings',
      'tonal',
      () => {
        origin = 'paused'
        show('settings')
      },
      'btn--block',
    ),
    button(
      'How to play',
      'tonal',
      () => {
        origin = 'paused'
        show('howto')
      },
      'btn--block',
    ),
    button('Quit to title', 'danger', () => cb.onQuitToTitle(), 'btn--block'),
  )
  pausedCard.append(pausedHeading, el('p', 'card-sub', 'Your run is saved automatically.'), pausedActions)
  pausedScreen.appendChild(pausedCard)

  // -- Game over ------------------------------------------------------------

  const overScreen = section('gameover', 'gameover-heading')
  const overCard = el('div', 'card card--narrow')
  const overHeading = el('h2', 'card-title', 'Game over')
  overHeading.id = 'gameover-heading'
  const overStats = el('div', 'stat-grid')
  const overScoreValue = el('span', 'stat-value', '0')
  const overBestValue = el('span', 'stat-value', '0')
  const overLevelValue = el('span', 'stat-value', '1')

  function stat(label: string, value: HTMLElement, hero?: boolean): HTMLElement {
    const box = el('div', hero === true ? 'stat stat--hero' : 'stat')
    box.append(el('span', 'stat-label', label), value)
    return box
  }

  overStats.append(
    stat('Score', overScoreValue, true),
    stat('Best', overBestValue),
    stat('Level', overLevelValue),
  )
  const overActions = el('div', 'card-actions')
  overActions.append(
    button('Title', 'text', () => cb.onQuitToTitle()),
    button('Play again', 'filled', () => cb.onRetry()),
  )
  overCard.append(overHeading, overStats, overActions)
  overScreen.appendChild(overCard)

  // -- Versus end -----------------------------------------------------------

  const vsEndScreen = section('versus-end', 'versus-end-heading')
  const vsEndCard = el('div', 'card card--narrow')
  const vsEndHeading = el('h2', 'visually-hidden', 'Match result')
  vsEndHeading.id = 'versus-end-heading'
  const vsBanner = el('p', 'result-banner', 'WIN')
  const vsStats = el('div', 'stat-grid')
  const vsScoreValue = el('span', 'stat-value', '0')
  vsStats.append(stat('Your score', vsScoreValue, true))
  const vsActions = el('div', 'card-actions')
  const rematchBtn = button('Rematch', 'filled', () => cb.onRematch())
  vsActions.append(button('Title', 'text', () => cb.onQuitToTitle()), rematchBtn)
  vsEndCard.append(vsEndHeading, vsBanner, vsStats, vsActions)
  vsEndScreen.appendChild(vsEndCard)

  // -- Navigation -----------------------------------------------------------

  function goBack(): void {
    show(origin === 'paused' ? 'paused' : 'title')
  }

  function show(screen: Screen, data?: GameOverData | VersusEndData): void {
    // Leaving (or re-entering) a screen never leaves a capture armed.
    cancelRebind()
    if (screen === 'gameover' && isGameOverData(data)) {
      overScoreValue.textContent = String(Math.round(data.score))
      overBestValue.textContent = String(Math.round(data.best))
      overLevelValue.textContent = String(data.level)
    }
    if (screen === 'versus-end' && isVersusEndData(data)) {
      vsBanner.dataset.result = data.result
      vsBanner.textContent =
        data.result === 'win' ? 'WIN' : data.result === 'lose' ? 'LOSE' : 'OPPONENT LEFT'
      vsScoreValue.textContent = String(Math.round(data.score))
      rematchBtn.disabled = data.result === 'disconnect'
    }
    if (screen === 'howto') renderHowtoKeys()
    if (screen === 'settings') syncControls()

    for (const [name, node] of screens) node.hidden = name !== screen
    visible = screen

    const host = screens.get(screen)
    if (host === undefined) return
    const items = focusables(host)
    if (items.length > 0) items[0].focus()
  }

  function hideAll(): void {
    cancelRebind()
    for (const node of screens.values()) node.hidden = true
    visible = null
  }

  function setVersusStatus(text: string): void {
    lobbyStatus.textContent = text
  }

  function setVersusCode(code: string | null): void {
    if (code === null) {
      roomCode.hidden = true
      roomCode.textContent = ''
      return
    }
    roomCode.textContent = code
    roomCode.hidden = false
  }

  function syncControls(): void {
    masterSlider.sync()
    sfxSlider.sync()
    musicSlider.sync()
    motionSelect.value = current.reducedMotion
    nameInput.value = current.playerName
    renderAllBindKeys()
  }

  // Clicking anything but the listening row abandons the capture (the Back
  // button, another row, the board…). Capture phase: it must run before the
  // click that would arm a new one.
  document.addEventListener(
    'pointerdown',
    (e) => {
      const active = capture
      if (active === null) return
      const target = e.target
      if (target instanceof Node && active.row.contains(target)) return
      cancelRebind()
    },
    true,
  )

  layer.addEventListener('keydown', (e) => {
    if (visible === null || capture !== null) return
    if (e.key === 'Escape') {
      if (visible === 'settings' || visible === 'howto') {
        e.preventDefault()
        e.stopPropagation()
        goBack()
        return
      }
      if (visible === 'versus-lobby') {
        e.preventDefault()
        e.stopPropagation()
        cb.onCancelVersus()
        return
      }
      return
    }
    if (e.key !== 'Tab') return
    const host = screens.get(visible)
    if (host === undefined) return
    const items = focusables(host)
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    const inside = active instanceof HTMLElement && host.contains(active)
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      e.preventDefault()
      first.focus()
    }
  })

  syncControls()
  root.appendChild(layer)

  return {
    show,
    hideAll,
    get current(): Screen | null {
      return visible
    },
    setHasSave(has: boolean): void {
      resumeBtn.hidden = !has
    },
    setVersusStatus,
    setVersusCode,
    refreshSettings(s: Settings): void {
      // The settings object is being replaced; a capture aimed at the old one
      // must not land on the new one.
      cancelRebind()
      current = cloneSettings(s)
      syncControls()
      renderHowtoKeys()
    },
  }
}
