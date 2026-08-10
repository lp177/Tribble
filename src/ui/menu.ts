// Tribble — menus. Builds every screen as DOM inside the UI overlay root.
// Dark Material / paper-elements flavored; all styling lives in src/style.css.

import {
  BOT_LEVELS,
  BOT_LEVEL_ORDER,
  DEFAULT_BINDINGS,
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  type BotLevel,
  type Difficulty,
  type GameAction,
  type GameOverData,
  type KeyBindings,
  type MenuApi,
  type MenuCallbacks,
  type Screen,
  type Settings,
  type VersusEndData,
} from '../types'
import { CODE_LENGTH, currentInviteUrl, extractRoomCode, normalizeCode } from '../net/invite'

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

const COPY_LABEL = 'Copy invite link'
/** How long the copy button stays in its "done" state before reverting. */
const COPY_FEEDBACK_MS = 2400

let motionQuery: MediaQueryList | null = null

/**
 * The AI level the player last picked. It is deliberately not part of Settings
 * — it is a per-session choice — but it lives at module scope so re-entering
 * the lobby (or rebuilding the menu) offers the same opponent again.
 */
let botLevel: BotLevel = 'skilled'

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

/** Stored settings can predate a tier (or be hand-edited); fall back to normal. */
function normalizeDifficulty(d: Difficulty): Difficulty {
  return DIFFICULTY_ORDER.includes(d) ? d : 'normal'
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
    difficulty: normalizeDifficulty(s.difficulty),
  }
}

/** One difficulty radiogroup; several exist and all of them stay in sync. */
interface DifficultyPicker {
  node: HTMLElement
  sync(): void
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
      // Roving-tabindex members (the unselected difficulty options) are not tab
      // stops, so the trap must not count them either.
      if (n.tabIndex < 0) continue
      if (n.getClientRects().length === 0) continue
      out.push(n)
    }
    return out
  }

  function emitSettings(): void {
    cb.onSettingsChanged(cloneSettings(current))
  }

  // -- Difficulty picker ----------------------------------------------------

  const difficultyPickers: DifficultyPicker[] = []

  function syncDifficulty(): void {
    for (const picker of difficultyPickers) picker.sync()
  }

  function chooseDifficulty(id: Difficulty): void {
    if (current.difficulty === id) return
    current.difficulty = id
    syncDifficulty()
    emitSettings()
  }

  /**
   * A radiogroup of difficulty cards (label + blurb). Standard radio keyboard
   * model: one tab stop, arrows move the selection, Home/End jump to the ends.
   */
  function difficultyGroup(idPrefix: string): DifficultyPicker {
    const group = el('div', 'difficulty-group')
    const heading = el('h3', 'group-title', 'Difficulty')
    heading.id = `${idPrefix}-difficulty-label`
    const list = el('div', 'difficulty-picker')
    list.setAttribute('role', 'radiogroup')
    list.setAttribute('aria-labelledby', heading.id)
    const options = new Map<Difficulty, HTMLButtonElement>()

    for (const id of DIFFICULTY_ORDER) {
      const config = DIFFICULTIES[id]
      const opt = el('button', 'difficulty-option')
      opt.type = 'button'
      opt.id = `${idPrefix}-difficulty-${id}`
      opt.dataset.difficulty = id
      opt.setAttribute('role', 'radio')
      opt.setAttribute('aria-checked', 'false')
      opt.tabIndex = -1
      opt.append(
        el('span', 'difficulty-name', config.label),
        el('span', 'difficulty-blurb', config.blurb),
      )
      attachInteractions(opt)
      opt.addEventListener('click', () => chooseDifficulty(id))
      opt.addEventListener('keydown', (e) => {
        const at = DIFFICULTY_ORDER.indexOf(id)
        const last = DIFFICULTY_ORDER.length - 1
        let to = -1
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = at === last ? 0 : at + 1
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = at === 0 ? last : at - 1
        else if (e.key === 'Home') to = 0
        else if (e.key === 'End') to = last
        if (to < 0) return
        // Arrows belong to the group, not to the screen behind it.
        e.preventDefault()
        e.stopPropagation()
        const next = DIFFICULTY_ORDER[to]
        chooseDifficulty(next)
        const target = options.get(next)
        if (target !== undefined) target.focus()
      })
      options.set(id, opt)
      list.appendChild(opt)
    }

    group.append(heading, list)
    return {
      node: group,
      sync(): void {
        for (const [id, opt] of options) {
          const on = id === current.difficulty
          opt.setAttribute('aria-checked', on ? 'true' : 'false')
          opt.classList.toggle('is-selected', on)
          opt.tabIndex = on ? 0 : -1
        }
      },
    }
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

  const titleDifficulty = difficultyGroup('title')
  difficultyPickers.push(titleDifficulty)

  const resumeBtn = button('Resume run', 'filled', () => cb.onResume(), 'btn--lg btn--block')
  resumeBtn.hidden = true
  // The picker sits above the menu, but the run buttons still take first focus.
  resumeBtn.dataset.initialFocus = ''
  const newGameBtn = button('New game', 'filled', () => cb.onNewGame(), 'btn--lg btn--block')
  newGameBtn.dataset.initialFocus = ''
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
    titleDifficulty.node,
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

  const settingsDifficulty = difficultyGroup('set')
  difficultyPickers.push(settingsDifficulty)
  const difficultyGroupBox = el('div', 'settings-group')
  difficultyGroupBox.append(
    settingsDifficulty.node,
    el('p', 'card-sub', 'Applies to the next new game — a run in progress keeps the tier it started on.'),
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

  settingsBody.append(
    difficultyGroupBox,
    el('hr', 'divider'),
    audioGroup,
    el('hr', 'divider'),
    generalGroup,
    el('hr', 'divider'),
    bindGroup,
  )
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
    ['🛡️', 'Armoured blocks crack instead of clearing: they need more than one break.'],
    ['🔮', 'In versus, clears spawn power bubbles — catch one with your flying piece to store it.'],
    ['💀', 'Send stored curses to your opponent: garbage 🧱, speed ⚡, fog 🌫️, scramble 🎲, mirror 🪞, rotation lock 🔒.'],
  ]

  /** Random events that run for a few seconds; the HUD calls out the active one. */
  const HAZARDS_HELP: ReadonlyArray<readonly [string, string]> = [
    ['🪨', 'Stone — every block turns to stone: colours are dead, only full lines clear.'],
    ['🛡️', 'Reinforced — the pieces you land arrive armoured and take two breaks.'],
    ['🧩', 'Giants — oversized five-cell pieces instead of the usual four.'],
    ['⏩', 'Rush — the stack climbs twice as fast until it passes.'],
  ]

  function fillHowtoList(host: HTMLElement, rows: ReadonlyArray<readonly [string, string]>): void {
    for (const [emoji, text] of rows) {
      const li = el('li')
      const icon = el('span', 'howto-emoji', emoji)
      icon.setAttribute('aria-hidden', 'true')
      li.append(icon, el('span', undefined, text))
      host.appendChild(li)
    }
  }

  fillHowtoList(howtoList, HOWTO)

  const howtoTiers = el('ul', 'howto-tiers')
  for (const id of DIFFICULTY_ORDER) {
    const config = DIFFICULTIES[id]
    const li = el('li', 'howto-tier')
    li.dataset.difficulty = id
    li.append(
      el('span', 'howto-tier-name', config.label),
      el('span', 'howto-tier-blurb', config.blurb),
    )
    howtoTiers.appendChild(li)
  }

  const howtoHazards = el('ul', 'howto-list')
  fillHowtoList(howtoHazards, HAZARDS_HELP)

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
    el('h3', 'group-title', 'Difficulty'),
    el(
      'p',
      'card-sub',
      'Pick a tier on the title screen. It sets how fast the stack rises, how often hazards strike and how much armour you meet — and it scales your score.',
    ),
    howtoTiers,
    el('hr', 'divider'),
    el('h3', 'group-title', 'Hazards'),
    el(
      'p',
      'card-sub',
      'From Normal upwards, a random hazard takes over for a few seconds. The HUD names the one that is running and counts it down.',
    ),
    howtoHazards,
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

  // The AI panel comes first: it is the only option that needs nothing from
  // anyone else — no friend, no code, no connection.
  const botPanel = el('div', 'panel panel--bot')
  const botLevelHeading = el('h4', 'group-title', 'Opponent level')
  botLevelHeading.id = 'bot-level-label'
  const botLevelList = el('div', 'level-picker')
  botLevelList.setAttribute('role', 'radiogroup')
  botLevelList.setAttribute('aria-labelledby', botLevelHeading.id)
  const botLevelOptions = new Map<BotLevel, HTMLButtonElement>()

  function syncBotLevel(): void {
    for (const [id, opt] of botLevelOptions) {
      const on = id === botLevel
      opt.setAttribute('aria-checked', on ? 'true' : 'false')
      opt.classList.toggle('is-selected', on)
      opt.tabIndex = on ? 0 : -1
    }
  }

  function chooseBotLevel(id: BotLevel): void {
    if (botLevel === id) return
    botLevel = id
    syncBotLevel()
  }

  // Same radio model as the difficulty picker: one tab stop, arrows move the
  // selection, Home/End jump to the ends.
  for (const id of BOT_LEVEL_ORDER) {
    const config = BOT_LEVELS[id]
    const opt = el('button', 'level-option')
    opt.type = 'button'
    opt.id = `bot-level-${id}`
    opt.dataset.botLevel = id
    opt.setAttribute('role', 'radio')
    opt.setAttribute('aria-checked', 'false')
    opt.tabIndex = -1
    const name = el('span', 'level-name', config.label)
    name.id = `bot-level-${id}-name`
    const blurb = el('span', 'level-blurb', config.blurb)
    blurb.id = `bot-level-${id}-blurb`
    // Name the radio after the tier alone and let the blurb describe it, so it
    // reads as "Skilled, radio" rather than as a whole sentence.
    opt.setAttribute('aria-labelledby', name.id)
    opt.setAttribute('aria-describedby', blurb.id)
    opt.append(name, blurb)
    attachInteractions(opt)
    opt.addEventListener('click', () => chooseBotLevel(id))
    opt.addEventListener('keydown', (e) => {
      const at = BOT_LEVEL_ORDER.indexOf(id)
      const last = BOT_LEVEL_ORDER.length - 1
      let to = -1
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = at === last ? 0 : at + 1
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = at === 0 ? last : at - 1
      else if (e.key === 'Home') to = 0
      else if (e.key === 'End') to = last
      if (to < 0) return
      // Arrows belong to the group, not to the screen behind it.
      e.preventDefault()
      e.stopPropagation()
      const next = BOT_LEVEL_ORDER[to]
      chooseBotLevel(next)
      const target = botLevelOptions.get(next)
      if (target !== undefined) target.focus()
    })
    botLevelOptions.set(id, opt)
    botLevelList.appendChild(opt)
  }

  const botLevelGroup = el('div', 'level-group')
  botLevelGroup.append(botLevelHeading, botLevelList)
  const botBtn = button(
    'Play the machine',
    'filled',
    () => {
      // A code left over from an abandoned host attempt must not linger behind
      // the match that is starting instead.
      setVersusCode(null)
      setVersusStatus('Starting a match against the machine…')
      cb.onPlayBot(botLevel)
    },
    'btn--block',
  )
  // The offline option is the one that always works, so it takes first focus.
  botBtn.dataset.initialFocus = ''
  botPanel.append(
    el('h3', 'panel-title', 'Solo versus'),
    el(
      'p',
      'panel-note',
      'A full versus match against the AI: same rules, same power bubbles, same curses — no connection needed.',
    ),
    botLevelGroup,
    botBtn,
  )
  syncBotLevel()

  const hostPanel = el('div', 'panel')
  const hostBtn = button('Host game', 'filled', () => {
    setVersusCode(null)
    setVersusStatus('Creating room…')
    cb.onHostGame()
  })

  // Everything below only exists once a room does.
  const inviteBox = el('div', 'invite')
  inviteBox.hidden = true

  const inviteLabel = el('label', 'field-label', 'Invite link')
  inviteLabel.htmlFor = 'invite-link'
  const inviteInput = el('input', 'text-input invite-link')
  inviteInput.id = 'invite-link'
  inviteInput.type = 'text'
  inviteInput.readOnly = true
  inviteInput.spellcheck = false
  inviteInput.autocomplete = 'off'
  // Reading the link is not the point — grabbing it is. Any way in selects it,
  // which is also the fallback when the clipboard is off limits.
  inviteInput.addEventListener('focus', () => inviteInput.select())
  inviteInput.addEventListener('click', () => inviteInput.select())

  const inviteFeedback = el('p', 'invite-feedback')
  inviteFeedback.id = 'invite-feedback'
  inviteFeedback.setAttribute('role', 'status')
  inviteFeedback.setAttribute('aria-live', 'polite')
  inviteInput.setAttribute('aria-describedby', inviteFeedback.id)

  const roomCode = el('output', 'room-code')
  roomCode.hidden = true
  roomCode.id = 'room-code'
  const inviteCodeBox = el('div', 'invite-code')
  inviteCodeBox.append(
    el('span', 'invite-code-caption', 'Can’t send a link? Read out the room code:'),
    roomCode,
  )

  /** The link currently on offer; empty when there is no room. */
  let inviteHref = ''
  let copyResetTimer = 0

  function restoreCopyLabel(): void {
    window.clearTimeout(copyResetTimer)
    copyResetTimer = 0
    copyBtn.textContent = COPY_LABEL
    copyBtn.classList.remove('is-copied')
  }

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      // The async clipboard needs a secure context; on plain http it is absent.
      if (navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // Blocked or unavailable — the selection path below still gets there.
    }
    try {
      inviteInput.focus()
      inviteInput.select()
      return document.execCommand('copy')
    } catch {
      return false
    }
  }

  async function copyInvite(): Promise<void> {
    if (inviteHref === '') return
    const ok = await writeClipboard(inviteHref)
    window.clearTimeout(copyResetTimer)
    if (!ok) {
      inviteInput.focus()
      inviteInput.select()
      inviteFeedback.textContent = 'Copying was blocked — the link is selected, press Ctrl+C.'
      return
    }
    copyBtn.textContent = 'Link copied!'
    copyBtn.classList.add('is-copied')
    inviteFeedback.textContent = 'Invite link copied — send it to your friend.'
    copyResetTimer = window.setTimeout(restoreCopyLabel, COPY_FEEDBACK_MS)
  }

  async function shareInvite(): Promise<void> {
    if (inviteHref === '') return
    try {
      await navigator.share({
        title: 'Tribble',
        text: 'Join my Tribble match!',
        url: inviteHref,
      })
    } catch (err) {
      // Dismissing the share sheet is a normal outcome, not a failure.
      if (err instanceof Error && err.name === 'AbortError') return
      inviteFeedback.textContent = 'Sharing failed — copy the link instead.'
    }
  }

  const copyBtn = button(
    COPY_LABEL,
    'filled',
    () => {
      void copyInvite()
    },
    'btn--block',
  )
  const shareBtn = button(
    'Share…',
    'tonal',
    () => {
      void shareInvite()
    },
    'btn--block',
  )
  // Only phones and tablets really have a share sheet; elsewhere it would be a
  // button that leads nowhere.
  shareBtn.hidden = typeof navigator.share !== 'function'

  const inviteActions = el('div', 'invite-actions')
  inviteActions.append(copyBtn, shareBtn)
  inviteBox.append(inviteLabel, inviteInput, inviteActions, inviteFeedback, inviteCodeBox)

  hostPanel.append(
    el('h3', 'panel-title', 'Host game'),
    el(
      'p',
      'panel-note',
      'Create a room, then send the link. One tap and your friend is in the match — nothing to type.',
    ),
    hostBtn,
    inviteBox,
  )

  const joinPanel = el('div', 'panel')
  const joinField = el('div', 'field')
  const joinLabel = el('label', 'field-label', 'Invite link or room code')
  joinLabel.htmlFor = 'join-code'
  const joinInput = el('input', 'text-input text-input--code')
  joinInput.id = 'join-code'
  joinInput.type = 'text'
  // Long enough for a pasted link: the browser truncates on paste, before the
  // input handler ever gets to pull the code out of it.
  joinInput.maxLength = 300
  joinInput.autocomplete = 'off'
  joinInput.spellcheck = false
  joinInput.placeholder = 'ABC23'
  joinInput.setAttribute('autocapitalize', 'characters')
  joinInput.addEventListener('input', () => {
    const raw = joinInput.value
    const code = extractRoomCode(raw)
    if (code !== null) {
      // A pasted link collapses to the code it carries.
      if (raw !== code) joinInput.value = code
    } else if (!/[:/#?]/.test(raw)) {
      // Plain typing: keep it to code shape. A half-typed URL is left alone.
      const clean = normalizeCode(raw).slice(0, CODE_LENGTH)
      if (clean !== raw) joinInput.value = clean
    }
    syncJoinButton()
  })
  joinField.append(joinLabel, joinInput)
  const joinBtn = button('Join', 'accent', () => {
    const code = extractRoomCode(joinInput.value)
    if (code === null) return
    setVersusCode(null)
    setVersusStatus('Joining room…')
    cb.onJoinGame(code)
  })
  joinBtn.disabled = true

  function syncJoinButton(): void {
    joinBtn.disabled = extractRoomCode(joinInput.value) === null
  }

  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) {
      e.preventDefault()
      joinBtn.click()
    }
  })
  joinPanel.append(
    el('h3', 'panel-title', 'Join game'),
    el('p', 'panel-note', 'Paste the link your opponent sent — or type their room code.'),
    joinField,
    joinBtn,
  )

  lobbyPanels.append(botPanel, hostPanel, joinPanel)
  const lobbyStatus = el('p', 'status-line')
  lobbyStatus.setAttribute('role', 'status')
  lobbyStatus.setAttribute('aria-live', 'polite')
  const lobbyActions = el('div', 'card-actions')
  lobbyActions.append(button('Cancel', 'text', () => cb.onCancelVersus()))
  lobbyBody.append(
    el(
      'p',
      'card-sub',
      'Two boards, the same piece sequence, curses flying both ways. Top out and you lose — whether the other board belongs to the machine or to a friend.',
    ),
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
    if (screen === 'settings' || screen === 'title') syncControls()

    for (const [name, node] of screens) node.hidden = name !== screen
    visible = screen

    const host = screens.get(screen)
    if (host === undefined) return
    const items = focusables(host)
    if (items.length === 0) return
    let target = items[0]
    for (const node of items) {
      if (node.dataset.initialFocus !== undefined) {
        target = node
        break
      }
    }
    target.focus()
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
    restoreCopyLabel()
    inviteFeedback.textContent = ''
    if (code === null) {
      inviteHref = ''
      inviteInput.value = ''
      inviteBox.hidden = true
      roomCode.hidden = true
      roomCode.textContent = ''
      return
    }
    inviteHref = currentInviteUrl(code)
    inviteInput.value = inviteHref
    roomCode.textContent = code
    roomCode.hidden = false
    inviteBox.hidden = false
    revealInvite()
  }

  /**
   * The room only opens after a network round trip, so the link appears in a
   * lobby the player has already scrolled — often below the fold. Bring it into
   * view and put the cursor on the one thing left to do, unless they have
   * meanwhile moved on to something else on the screen.
   */
  function revealInvite(): void {
    const active = document.activeElement
    if (active === null || active === document.body || active === hostBtn) {
      copyBtn.focus({ preventScroll: true })
    }
    inviteBox.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }

  function setJoinCode(code: string): void {
    joinInput.value = normalizeCode(code).slice(0, CODE_LENGTH)
    syncJoinButton()
  }

  function syncControls(): void {
    masterSlider.sync()
    sfxSlider.sync()
    musicSlider.sync()
    motionSelect.value = current.reducedMotion
    nameInput.value = current.playerName
    syncDifficulty()
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
    setJoinCode,
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
