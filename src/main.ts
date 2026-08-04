import './style.css'
import {
  AIM_KEY_SPEED,
  CURSE_DURATION,
  DIFFICULTIES,
  STONE_HEX,
  LAUNCH_X,
  LAUNCH_Y,
  MAX_AIM_ANGLE,
  type CurseKind,
  type Game,
  type GamePhase,
  type NetSession,
  type OpponentView,
  type SaveGame,
  type Settings,
  type VersusController,
} from './types'
import { createGame, loadGame, computeAimPath } from './core/game'
import { createJuice } from './fx/juice'
import { createParticles } from './fx/particles'
import { createAudio } from './audio/audio'
import { createRenderer } from './render/renderer'
import { COLOR_HEX, POWER_COLOR, drawPieceThumb } from './render/theme'
import { createInput } from './input/input'
import {
  clearSave,
  loadBest,
  loadSave,
  loadSettings,
  storeBest,
  storeSave,
  storeSettings,
  installAutoSave,
} from './save/persistence'
import { createMenu } from './ui/menu'
import { createHud } from './ui/hud'
import { hostSession, joinSession } from './net/p2p'
import { createVersus } from './net/versus'

const CURSE_LABEL: Record<CurseKind, string> = {
  garbage: 'Garbage 🧱',
  speed: 'Speed up ⚡',
  fog: 'Fog 🌫️',
  scramble: 'Scramble 🎲',
  mirror: 'Mirror 🪞',
  lockRotate: 'Rotation lock 🔒',
}

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement
const uiRoot = document.getElementById('ui') as HTMLElement

let settings: Settings = loadSettings()

const juice = createJuice()
const particles = createParticles()
const audio = createAudio()
const renderer = createRenderer({ canvas, juice, particles })
const input = createInput(canvas, settings.bindings)
const hud = createHud(uiRoot, drawPieceThumb)

type Mode = 'menu' | 'solo' | 'versus'
let mode: Mode = 'menu'
let game: Game | null = null
let unwireGame: (() => void) | null = null
let paused = false

// A SaveGame cannot describe a piece in flight or a cascade in progress, so we
// only ever persist the board at rest. Saving mid-flight would hand the player
// their piece back on resume; saving mid-cascade would duplicate the piece that
// just locked. Refreshed on each transition back to aiming.
let lastCoherentSave: SaveGame | null = null
let lastPhase: GamePhase | null = null

// Attract-mode board rendered behind the menus.
const demoGame = createGame({ seed: 42 })

// Versus session state
let session: NetSession | null = null
let versus: VersusController | null = null
let opponentView: OpponentView | null = null
let pendingConnect: { cancel(): void } | null = null
let unsubSessionMsg: (() => void) | null = null
/** Guards against a superseded lobby attempt resolving or rejecting late. */
let versusAttempt = 0

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

function reducedMotion(): boolean {
  if (settings.reducedMotion === 'on') return true
  if (settings.reducedMotion === 'off') return false
  return motionQuery.matches
}

function applyMotionPrefs(): void {
  const rm = reducedMotion()
  juice.setReducedMotion(rm)
  particles.setReducedMotion(rm)
  // The Settings override has to reach CSS too, or DOM animations keep running
  // when the player asked for calm. The media query alone cannot see it.
  document.documentElement.dataset.reducedMotion = rm ? 'on' : 'off'
}

motionQuery.addEventListener('change', applyMotionPrefs)

function applySettings(): void {
  audio.setMasterVolume(settings.masterVolume)
  audio.setSfxVolume(settings.sfxVolume)
  audio.setMusicVolume(settings.musicVolume)
  input.setBindings(settings.bindings)
  applyMotionPrefs()
}

// ---------------------------------------------------------------------------
// Game event wiring (fx + audio + hud)
// ---------------------------------------------------------------------------

function cellToScreen(cx: number, cy: number): { x: number; y: number } {
  return renderer.toScreen(cx, cy)
}

function wireGame(g: Game): () => void {
  const subs: Array<() => void> = []
  const ev = g.events

  subs.push(
    ev.on('launch', () => {
      audio.play('launch')
      juice.shake(0.12, 0.15)
    }),
    ev.on('rotate', () => audio.play('click', { volume: 0.5 })),
    ev.on('bounce', ({ x, y }) => {
      audio.play('bounce')
      const p = cellToScreen(x, y)
      particles.burst(p.x, p.y, '#ffffff', { count: 6, speed: 90, life: 0.3 })
      juice.shake(0.08, 0.1)
    }),
    ev.on('impact', ({ x, y, speed }) => {
      const v = Math.min(1, speed / 30)
      audio.play('impact', { volume: 0.5 + v * 0.5 })
      juice.shake(0.18 + v * 0.2, 0.22)
      const p = cellToScreen(x, y)
      particles.burst(p.x, p.y, '#ffffff', { count: 10, speed: 140, life: 0.35 })
    }),
    ev.on('lock', () => audio.play('lock')),
    ev.on('clear', (info) => {
      const chainMul = Math.max(1, info.chain)
      if (info.lines.length > 0) {
        audio.play('clearLine', { pitch: 1 + (info.lines.length - 1) * 0.15 })
        juice.shake(0.35 + info.lines.length * 0.12, 0.35)
        if (info.lines.length >= 2 && !reducedMotion()) juice.hitStop(0.04)
        for (const row of info.lines) {
          for (let col = 0; col < g.state.grid[0].length; col++) {
            const p = cellToScreen(col + 0.5, row + 0.5)
            particles.burst(p.x, p.y, COLOR_HEX[(col % 4) as 0 | 1 | 2 | 3], {
              count: 4,
              speed: 170,
              life: 0.5,
            })
          }
        }
      }
      for (const m of info.matches) {
        audio.play('match', { pitch: 1 + (chainMul - 1) * 0.18 })
        for (const c of m.cells) {
          const p = cellToScreen(c.col + 0.5, c.row + 0.5)
          particles.burst(p.x, p.y, COLOR_HEX[m.color], { count: 6, speed: 150, life: 0.45 })
        }
      }
      const sp = cellToScreen(info.cx, info.cy)
      particles.floatText(sp.x, sp.y, `+${info.score}`, { size: Math.min(28, 14 + info.score / 60) })
      juice.flash('#ffffff', 0.12)
    }),
    ev.on('chainStep', ({ chain }) => {
      audio.play('chain', { pitch: 1 + chain * 0.14 })
      hud.announce(`CHAIN ×${chain}!`, 'good')
      const m = renderer.boardMetrics()
      particles.floatText(m.originX + m.width / 2, m.originY + m.height * 0.35, `CHAIN ×${chain}`, {
        color: '#b388ff',
        size: 30,
      })
      if (!reducedMotion()) juice.hitStop(Math.min(0.09, 0.04 + chain * 0.015))
      juice.flash('#b388ff', 0.2)
      juice.shake(0.3 + chain * 0.08, 0.3)
    }),
    ev.on('rise', () => {
      audio.play('rise')
      juice.shake(0.28, 0.4)
    }),
    ev.on('riseWarning', () => audio.play('riseWarning')),
    ev.on('danger', ({ on }) => {
      // The stack reaching the kill zone is the biggest pace change there is,
      // so the score follows it and returns to a fresh track on the way out.
      if (on) {
        audio.play('danger')
        audio.pushMusicEvent('danger', 'danger')
      } else {
        audio.popMusicEvent('danger')
      }
    }),
    ev.on('levelUp', ({ level }) => {
      audio.play('levelUp')
      hud.announce(`Level ${level}`, 'info')
      juice.flash('#4cc9f0', 0.25)
      // Every few levels the rise speed has moved enough to warrant a new track.
      if (level % 3 === 1) audio.shuffleMusic()
    }),
    ev.on('gameOver', () => {
      if (mode !== 'solo') return
      audio.play('gameOver')
      juice.shake(0.8, 0.8)
      audio.stopMusic()
      clearSave()
      lastCoherentSave = null
      const score = g.state.score
      const best = Math.max(loadBest(), score)
      storeBest(best)
      menu.setHasSave(false)
      hud.setVisible(false)
      menu.show('gameover', { score, best, level: g.state.level })
      mode = 'menu'
    }),
    ev.on('powerSpawn', () => audio.play('hover', { volume: 0.7 })),
    ev.on('powerCaught', ({ kind }) => {
      audio.play('powerCatch')
      hud.announce(`Power stored: ${CURSE_LABEL[kind]} — press C to send`, 'good')
      juice.flash(POWER_COLOR, 0.2)
      // Holding power brightens the score until you spend the last one.
      audio.pushMusicEvent('power', 'power')
    }),
    ev.on('curseApplied', ({ kind }) => {
      audio.play('curseHit')
      juice.shake(0.45, 0.4)
      juice.flash('#ff5c8a', 0.3)
      hud.announce(`Cursed: ${CURSE_LABEL[kind]}`, 'bad')
      // A timed curse owns the music until it expires (see curseExpired). An
      // instant one has no end to wait for, so it just shakes up the track.
      if (CURSE_DURATION[kind] > 0) audio.pushMusicEvent(`curse:${kind}`, 'curse')
      else audio.shuffleMusic()
    }),
    ev.on('curseExpired', ({ kind }) => {
      audio.popMusicEvent(`curse:${kind}`)
      hud.announce(`${CURSE_LABEL[kind]} wore off`, 'good')
    }),
    // The renderer draws the on-board banner and the HUD owns the countdown and
    // the announcement, so this handler only adds the felt reaction.
    ev.on('hazardStart', ({ kind }) => {
      audio.play('curseHit')
      audio.pushMusicEvent(`hazard:${kind}`, kind === 'rush' ? 'surge' : 'curse')
      juice.shake(0.5, 0.5)
      juice.flash(kind === 'stone' ? STONE_HEX : '#ff5c8a', 0.35)
    }),
    ev.on('hazardEnd', ({ kind }) => {
      audio.popMusicEvent(`hazard:${kind}`)
      audio.play('levelUp', { volume: 0.6 })
    }),
    ev.on('armorHit', ({ row, col }) => {
      // Armour absorbing a clear needs to read as a hit, not as nothing.
      audio.play('bounce', { pitch: 0.6, volume: 0.9 })
      const p = cellToScreen(col + 0.5, row + 0.5)
      particles.burst(p.x, p.y, '#c9d1e0', { count: 8, speed: 120, life: 0.35 })
      juice.shake(0.12, 0.12)
    }),
  )

  return () => {
    for (const u of subs) u()
  }
}

function attachGame(g: Game): void {
  if (unwireGame) unwireGame()
  game = g
  unwireGame = wireGame(g)
}

// ---------------------------------------------------------------------------
// Solo flow
// ---------------------------------------------------------------------------

function startSolo(fromSave: boolean): void {
  teardownVersus()
  let g: Game | null = null
  if (fromSave) {
    const save = loadSave()
    if (save) g = loadGame(save)
  }
  if (!g) {
    clearSave()
    g = createGame({ seed: (Math.random() * 0x7fffffff) | 0, difficulty: settings.difficulty })
  }
  attachGame(g)
  lastCoherentSave = g.serialize()
  lastPhase = g.state.phase
  mode = 'solo'
  paused = false
  opponentView = null
  hud.setOpponent(null, 0)
  hud.setVisible(true)
  menu.hideAll()
  audio.startMusic()
}

function pauseSolo(): void {
  // Versus has no pause: the opponent keeps playing, so freezing the local sim
  // would just stop our snapshots and hand them the match.
  if (mode !== 'solo' || paused) return
  paused = true
  menu.show('paused')
}

function resumeFromPause(): void {
  paused = false
  menu.hideAll()
}

// A versus match cannot pause — the opponent plays on — so leaving is a
// forfeit, and a stray Escape should not cost someone the game.
let forfeitArmedUntil = 0

function confirmForfeit(): void {
  const now = performance.now()
  if (now < forfeitArmedUntil) {
    forfeitArmedUntil = 0
    quitToTitle()
    return
  }
  forfeitArmedUntil = now + 2500
  hud.announce('Press Escape again to forfeit the match', 'bad')
}

function quitToTitle(): void {
  if (mode === 'solo' && lastCoherentSave !== null) {
    // Keep the run resumable from the title screen.
    storeSave(lastCoherentSave)
  }
  teardownVersus()
  mode = 'menu'
  paused = false
  game = null
  if (unwireGame) {
    unwireGame()
    unwireGame = null
  }
  audio.stopMusic()
  hud.setVisible(false)
  menu.setHasSave(loadSave() !== null)
  menu.show('title')
}

// ---------------------------------------------------------------------------
// Versus flow
// ---------------------------------------------------------------------------

function teardownVersus(): void {
  versusAttempt++
  if (pendingConnect) {
    pendingConnect.cancel()
    pendingConnect = null
  }
  if (unsubSessionMsg) {
    unsubSessionMsg()
    unsubSessionMsg = null
  }
  if (versus) {
    versus.dispose()
    versus = null
  }
  if (session) {
    session.close()
    session = null
  }
  opponentView = null
}

function beginVersusMatch(seed: number): void {
  if (!session) return
  const g = createGame({ seed, versus: true })
  attachGame(g)
  const s = session
  const hooks = {
    onOpponentUpdate(view: OpponentView) {
      opponentView = view
      hud.setOpponent(view.name, view.score)
    },
    onCurseIncoming(kind: CurseKind) {
      hud.announce(`${s.peerName} sent: ${CURSE_LABEL[kind]}`, 'bad')
    },
    onEnd(result: 'win' | 'lose' | 'disconnect') {
      if (mode !== 'versus') return
      audio.stopMusic()
      audio.play(result === 'lose' ? 'gameOver' : 'win')
      hud.setVisible(false)
      menu.show('versus-end', { result, score: game ? game.state.score : 0 })
      if (result === 'disconnect') teardownVersus()
    },
    onRematch(newSeed: number) {
      const ng = createGame({ seed: newSeed, versus: true })
      attachGame(ng)
      if (versus) versus.setGame(ng)
      opponentView = null
      paused = false
      hud.setVisible(true)
      menu.hideAll()
      audio.startMusic()
      hud.announce('Rematch!', 'info')
    },
  }
  versus = createVersus(g, s, hooks)
  mode = 'versus'
  paused = false
  hud.setVisible(true)
  menu.hideAll()
  audio.startMusic()
  hud.announce(`VS ${s.peerName} — fight!`, 'info')
}

async function hostVersus(): Promise<void> {
  teardownVersus()
  const attempt = ++versusAttempt
  menu.setVersusStatus('Creating room…')
  try {
    const p = hostSession(settings.playerName, (code) => {
      if (attempt !== versusAttempt) return
      menu.setVersusCode(code)
      menu.setVersusStatus('Waiting for an opponent… share the code!')
    })
    pendingConnect = p
    const s = await p
    if (attempt !== versusAttempt) {
      // Superseded while connecting: this session is nobody's, so drop it.
      s.close()
      return
    }
    session = s
    pendingConnect = null
    const seed = (Math.random() * 0x7fffffff) | 0
    s.send({ t: 'start', seed })
    beginVersusMatch(seed)
  } catch (err) {
    if (attempt !== versusAttempt) return
    pendingConnect = null
    if ((err as Error).message !== 'cancelled') {
      menu.setVersusStatus(`Could not host: ${(err as Error).message}`)
    }
  }
}

async function joinVersus(code: string): Promise<void> {
  teardownVersus()
  const attempt = ++versusAttempt
  menu.setVersusStatus('Joining room…')
  try {
    const p = joinSession(code, settings.playerName)
    pendingConnect = p
    const s = await p
    if (attempt !== versusAttempt) {
      s.close()
      return
    }
    session = s
    pendingConnect = null
    menu.setVersusStatus(`Connected to ${s.peerName} — starting…`)
    unsubSessionMsg = s.onMessage((msg) => {
      if (msg.t === 'start' && attempt === versusAttempt) {
        if (unsubSessionMsg) {
          unsubSessionMsg()
          unsubSessionMsg = null
        }
        beginVersusMatch(msg.seed)
      }
    })
  } catch (err) {
    if (attempt !== versusAttempt) return
    pendingConnect = null
    if ((err as Error).message !== 'cancelled') {
      menu.setVersusStatus(`Could not join: ${(err as Error).message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

const menu = createMenu(uiRoot, settings, {
  onNewGame() {
    clearSave()
    startSolo(false)
  },
  onResume() {
    startSolo(true)
  },
  onOpenVersus() {
    menu.setVersusCode(null)
    menu.setVersusStatus('')
    menu.show('versus-lobby')
  },
  onHostGame() {
    void hostVersus()
  },
  onJoinGame(code: string) {
    void joinVersus(code)
  },
  onCancelVersus() {
    teardownVersus()
    menu.show('title')
  },
  onSettingsChanged(s: Settings) {
    settings = s
    storeSettings(s)
    applySettings()
  },
  onRebindRequest(_action, done) {
    input.startRebind(done)
  },
  onPauseResume() {
    resumeFromPause()
  },
  onQuitToTitle() {
    quitToTitle()
  },
  onRetry() {
    clearSave()
    startSolo(false)
  },
  onRematch() {
    if (versus) {
      hud.announce('Rematch requested…', 'info')
      versus.requestRematch()
    }
  },
  onUiSound(kind) {
    audio.resume()
    audio.play(kind)
  },
})

menu.setHasSave(loadSave() !== null)
menu.show('title')
applySettings()

// ---------------------------------------------------------------------------
// Input wiring
// ---------------------------------------------------------------------------

function mirrored(): boolean {
  return game !== null && game.state.activeCurses.some((c) => c.kind === 'mirror')
}

function fogged(): boolean {
  return game !== null && game.state.activeCurses.some((c) => c.kind === 'fog')
}

input.onAction((action) => {
  audio.resume()
  if (action === 'pause') {
    if (mode === 'menu') return
    if (menu.current === 'paused') resumeFromPause()
    else if (mode === 'versus' && menu.current === null) confirmForfeit()
    else if (menu.current === null) pauseSolo()
    return
  }
  if (menu.current !== null || mode === 'menu' || paused || !game) return
  switch (action) {
    case 'rotateCW':
      game.rotate(1)
      break
    case 'rotateCCW':
      game.rotate(-1)
      break
    case 'launch':
      game.launch()
      break
    case 'useCurse': {
      const kind = game.useCurse()
      if (kind && versus) {
        versus.sendCurse(kind)
        audio.play('curseSent')
        hud.announce(`Sent: ${CURSE_LABEL[kind]}`, 'good')
        if (game.state.inventory.length === 0) audio.popMusicEvent('power')
      }
      break
    }
  }
})

input.onPointerAim((px, py) => {
  if (menu.current !== null || !game || paused) return
  const m = renderer.boardMetrics()
  const cx = (px - m.originX) / m.cellSize
  const cy = (py - m.originY) / m.cellSize
  const dy = Math.max(0.15, cy - LAUNCH_Y)
  let angle = Math.atan2(cx - LAUNCH_X, dy)
  if (mirrored()) angle = -angle
  game.setAim(Math.max(-MAX_AIM_ANGLE, Math.min(MAX_AIM_ANGLE, angle)))
})

input.onPointerLaunch(() => {
  audio.resume()
  if (menu.current !== null || !game || paused) return
  game.launch()
})

input.onPointerRotate(() => {
  if (menu.current !== null || !game || paused) return
  game.rotate(1)
})

window.addEventListener('pointerdown', () => audio.resume(), { once: true })

// ---------------------------------------------------------------------------
// Auto-save + lifecycle
// ---------------------------------------------------------------------------

installAutoSave(() => (mode === 'solo' ? lastCoherentSave : null))

document.addEventListener('visibilitychange', () => {
  if (document.hidden && mode === 'solo' && menu.current === null) pauseSolo()
})

window.addEventListener('resize', () => renderer.resize())
renderer.resize()

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let last = performance.now()

function frame(now: number): void {
  const realDt = Math.min(0.05, (now - last) / 1000)
  last = now

  juice.update(realDt)
  particles.update(realDt)

  const active = game && !paused && menu.current === null && mode !== 'menu' ? game : null

  if (active) {
    // Keyboard aiming (mirror curse inverts).
    const dir = (input.isDown('aimRight') ? 1 : 0) - (input.isDown('aimLeft') ? 1 : 0)
    if (dir !== 0) active.aimBy((mirrored() ? -dir : dir) * AIM_KEY_SPEED * realDt)

    active.update(realDt * juice.timeScale)

    if (mode === 'solo') {
      const phase = active.state.phase
      if (phase === 'aiming' && lastPhase !== 'aiming') lastCoherentSave = active.serialize()
      lastPhase = phase
    }

    if (versus) versus.update(realDt)

    if (active.state.flying) {
      const p = cellToScreen(active.state.flying.x, active.state.flying.y)
      particles.trail(p.x, p.y, COLOR_HEX[active.state.flying.piece.colors[0]])
    }

    const intensity = Math.min(
      1,
      0.22 + (active.state.level - 1) * 0.07 + (active.state.danger ? 0.4 : 0),
    )
    audio.setIntensity(intensity)
    hud.update(active.state)
  }

  const shown = active ?? (game && menu.current !== 'title' ? game : demoGame)
  if (shown === demoGame) {
    demoGame.setAim(Math.sin(now / 1600) * 0.9)
  }
  const isAiming = shown.state.phase === 'aiming'
  // Hardcore hides the guide entirely: you learn the bounces or you don't.
  const guideAllowed = DIFFICULTIES[shown.state.difficulty].aimGuide
  const showAim = guideAllowed && (shown === active ? isAiming && !fogged() : isAiming)
  renderer.render(shown.state, {
    aimPath: showAim ? computeAimPath(shown.state) : null,
    opponent: mode === 'versus' ? opponentView : null,
    fogged: shown === active && fogged(),
    reducedMotion: reducedMotion(),
  })

  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
