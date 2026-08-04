// Procedural WebAudio engine: all SFX are synthesized (oscillators + one shared
// noise buffer), music is a generative loop driven by a lookahead scheduler.
// The loop reads a TrackConfig (scale, chords, tempo, timbres, swing), so the
// same scheduler renders every base track and every event variation.
// No asset files, no imports beyond shared types.

import type { AudioEngine, MusicEvent, SfxName } from '../types'

// ---------------------------------------------------------------------------
// Internal types & constants
// ---------------------------------------------------------------------------

interface Graph {
  ac: AudioContext
  master: GainNode
  sfx: GainNode
  music: GainNode
  /** Shared lowpass for pad + arp; cutoff follows intensity. */
  musicFilter: BiquadFilterNode
  /** Fades the whole music loop in/out, below the user music volume. */
  musicBus: GainNode
  noise: AudioBuffer
}

/** One playing SFX: an output gain plus every scheduled source under it. */
interface Voice {
  out: GainNode
  srcs: AudioScheduledSourceNode[]
  end: number
}

const MAX_VOICES = 16
const VOL_SMOOTH = 0.03
const LOOKAHEAD = 0.12
const TICK_MS = 25
/** 8th-note steps per bar of 4/4; track swaps land on one of these. */
const STEPS_PER_BAR = 8
/** Cross-fade: exponential tau + the wall time we assume it takes to go quiet. */
const FADE_TAU = 0.16
const FADE_SECONDS = 0.6
/** Tempo lift from intensity: 92 BPM -> 122 BPM at full energy (as before). */
const TEMPO_SPAN = 0.326

const semiFreq = (base: number, semi: number): number => base * Math.pow(2, semi / 12)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// ---------------------------------------------------------------------------
// Music tracks (data, not code: one scheduler renders all of them)
// ---------------------------------------------------------------------------

/**
 * Everything the generative scheduler needs to render one track. Pitches are
 * semitone offsets: `scale` above `arpRoot` (melody), `chords` above `padRoot`.
 */
interface TrackConfig {
  /** Unique — identity is how the cross-fade knows a swap is a real change. */
  id: string
  /** Ascending scale degrees, ~2 octaves, the arp walks this. */
  scale: readonly number[]
  /** Chord voicings, cycled one per `stepsPerChord` steps. */
  chords: readonly (readonly number[])[]
  padRoot: number
  arpRoot: number
  bpm: number
  stepsPerChord: number
  /** A pluck always fires on steps divisible by this; others are random fills. */
  arpEvery: number
  /** Fill probability, plus how much intensity adds to it. */
  density: number
  densityGain: number
  /** Fraction of a step that off-beat plucks are pushed late (0 = straight). */
  swing: number
  /** Semitones applied to every voice. */
  transpose: number
  /** Extra semitones for the melody only. */
  octaveBias: number
  padType: OscillatorType
  /** Cents the two pad layers are spread by. */
  padDetune: number
  padLevel: number
  pluckType: OscillatorType
  pluckLevel: number
  /** Added to pluckLevel at full intensity. */
  pluckGain: number
  cutoffBase: number
  cutoffSpan: number
  filterQ: number
  /** Probability an arp note gets a minor-second stab on top. */
  stab: number
  /** Intensity above which the kick enters. */
  kickAt: number
}

/** A-minor pentatonic over two octaves — the original Tribble melody scale. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24]
const DORIAN = [0, 2, 3, 5, 7, 9, 10, 12, 14, 15, 17, 19, 21, 22, 24]
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10, 12, 13, 15, 17, 19, 20, 22, 24]
const LYDIAN = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24]
const BLUES = [0, 3, 5, 6, 7, 10, 12, 15, 17, 18, 19, 22, 24]
const MIXOLYDIAN = [0, 2, 4, 5, 7, 9, 10, 12, 14, 16, 17, 19, 21, 22, 24]
/** Half-step heavy, for the curse variation. */
const CURSED = [0, 1, 4, 5, 7, 8, 11, 12, 13, 16, 17, 19, 20, 23, 24]

const TRACKS: readonly TrackConfig[] = [
  {
    // The original loop, note for note: A minor pentatonic over Am F C G.
    id: 'emberfall',
    scale: PENTA,
    chords: [
      [0, 7, 15],
      [-4, 3, 12],
      [3, 10, 19],
      [-2, 5, 14],
    ],
    padRoot: 110, // A2
    arpRoot: 220, // A3
    bpm: 92,
    stepsPerChord: 32,
    arpEvery: 8,
    density: 0.3,
    densityGain: 0.55,
    swing: 0,
    transpose: 0,
    octaveBias: 0,
    padType: 'sawtooth',
    padDetune: 7,
    padLevel: 0.09,
    pluckType: 'triangle',
    pluckLevel: 0.09,
    pluckGain: 0.07,
    cutoffBase: 500,
    cutoffSpan: 3800,
    filterQ: 0.6,
    stab: 0,
    kickAt: 0.6,
  },
  {
    // D dorian, wide and floaty: Dm G Am C.
    id: 'driftwood',
    scale: DORIAN,
    chords: [
      [0, 7, 15],
      [5, 14, 21],
      [7, 14, 22],
      [10, 17, 22],
    ],
    padRoot: 73.42, // D2
    arpRoot: 146.83, // D3
    bpm: 88,
    stepsPerChord: 32,
    arpEvery: 6,
    density: 0.26,
    densityGain: 0.5,
    swing: 0.06,
    transpose: 0,
    octaveBias: 12,
    padType: 'sawtooth',
    padDetune: 12,
    padLevel: 0.085,
    pluckType: 'sine',
    pluckLevel: 0.1,
    pluckGain: 0.08,
    cutoffBase: 620,
    cutoffSpan: 4200,
    filterQ: 0.5,
    stab: 0,
    kickAt: 0.62,
  },
  {
    // E phrygian, the brooding one: Em F Em G.
    id: 'nightglass',
    scale: PHRYGIAN,
    chords: [
      [0, 7, 15],
      [1, 8, 17],
      [0, 7, 15],
      [3, 10, 19],
    ],
    padRoot: 82.41, // E2
    arpRoot: 164.81, // E3
    bpm: 84,
    stepsPerChord: 32,
    arpEvery: 8,
    density: 0.24,
    densityGain: 0.5,
    swing: 0.08,
    transpose: 0,
    octaveBias: 12,
    padType: 'sawtooth',
    padDetune: 11,
    padLevel: 0.095,
    pluckType: 'triangle',
    pluckLevel: 0.08,
    pluckGain: 0.06,
    cutoffBase: 420,
    cutoffSpan: 2900,
    filterQ: 1.1,
    stab: 0.06,
    kickAt: 0.55,
  },
  {
    // C lydian, bright and open: C D Em D.
    id: 'solstice',
    scale: LYDIAN,
    chords: [
      [0, 7, 16],
      [2, 9, 18],
      [4, 11, 19],
      [2, 9, 18],
    ],
    padRoot: 130.81, // C3
    arpRoot: 261.63, // C4
    bpm: 104,
    stepsPerChord: 16,
    arpEvery: 4,
    density: 0.34,
    densityGain: 0.5,
    swing: 0,
    transpose: 0,
    octaveBias: 0,
    padType: 'triangle',
    padDetune: 14,
    padLevel: 0.1,
    pluckType: 'triangle',
    pluckLevel: 0.085,
    pluckGain: 0.07,
    cutoffBase: 900,
    cutoffSpan: 5200,
    filterQ: 0.4,
    stab: 0,
    kickAt: 0.5,
  },
  {
    // F minor blues, slow shuffle: Fm Bbm Cm Fm.
    id: 'undertow',
    scale: BLUES,
    chords: [
      [0, 7, 15],
      [5, 12, 20],
      [7, 14, 22],
      [0, 7, 15],
    ],
    padRoot: 87.31, // F2
    arpRoot: 174.61, // F3
    bpm: 76,
    stepsPerChord: 32,
    arpEvery: 6,
    density: 0.28,
    densityGain: 0.5,
    swing: 0.16,
    transpose: 0,
    octaveBias: 12,
    padType: 'sawtooth',
    padDetune: 5,
    padLevel: 0.09,
    pluckType: 'square',
    pluckLevel: 0.055,
    pluckGain: 0.05,
    cutoffBase: 380,
    cutoffSpan: 2800,
    filterQ: 1.6,
    stab: 0.05,
    kickAt: 0.45,
  },
  {
    // G mixolydian, the driving one: G F C G.
    id: 'voltage',
    scale: MIXOLYDIAN,
    chords: [
      [0, 7, 16],
      [10, 17, 22],
      [5, 12, 21],
      [0, 7, 16],
    ],
    padRoot: 98, // G2
    arpRoot: 196, // G3
    bpm: 118,
    stepsPerChord: 16,
    arpEvery: 2,
    density: 0.42,
    densityGain: 0.45,
    swing: 0,
    transpose: 0,
    octaveBias: 12,
    padType: 'sawtooth',
    padDetune: 9,
    padLevel: 0.08,
    pluckType: 'sawtooth',
    pluckLevel: 0.055,
    pluckGain: 0.05,
    cutoffBase: 700,
    cutoffSpan: 4600,
    filterQ: 0.8,
    stab: 0,
    kickAt: 0.35,
  },
]

/**
 * Bend a track towards a dramatic moment. Applied in stack order, so the most
 * recently pushed event overrides the ones under it while still inheriting
 * their character ('surge' on top of 'curse' = a faster, darker track).
 */
function deriveEvent(kind: MusicEvent, base: TrackConfig): TrackConfig {
  const id = `${base.id}>${kind}`
  switch (kind) {
    case 'curse':
      // A semitone down, half-step voicings, filter clamped shut.
      return {
        ...base,
        id,
        scale: CURSED,
        chords: [
          [0, 7, 13],
          [0, 6, 13],
          [-1, 6, 12],
          [0, 1, 12],
        ],
        bpm: base.bpm * 0.94,
        stepsPerChord: 16,
        transpose: base.transpose - 1,
        padType: 'sawtooth',
        padDetune: base.padDetune + 14,
        pluckType: 'triangle',
        cutoffBase: base.cutoffBase * 0.5,
        cutoffSpan: base.cutoffSpan * 0.45,
        filterQ: 2.2,
        stab: 0.35,
        swing: 0,
      }
    case 'danger':
      // Faster, tighter, tritone-flavoured, kick in early.
      return {
        ...base,
        id,
        chords: [
          [0, 7, 14],
          [0, 6, 13],
          [0, 7, 15],
          [-1, 6, 11],
        ],
        bpm: base.bpm * 1.28,
        stepsPerChord: 16,
        arpEvery: 2,
        density: 0.5,
        densityGain: 0.4,
        swing: 0,
        padDetune: base.padDetune + 4,
        pluckType: 'square',
        pluckLevel: 0.06,
        pluckGain: 0.05,
        cutoffBase: base.cutoffBase + 250,
        cutoffSpan: base.cutoffSpan * 0.8,
        filterQ: 1.5,
        stab: 0.08,
        kickAt: 0.28,
      }
    case 'power':
      // Lydian shimmer an octave up, filter wide open.
      return {
        ...base,
        id,
        scale: LYDIAN,
        chords: [
          [0, 7, 16],
          [2, 9, 18],
          [7, 14, 23],
          [0, 7, 16],
        ],
        bpm: base.bpm * 1.06,
        stepsPerChord: 16,
        octaveBias: base.octaveBias + 12,
        padType: 'triangle',
        padDetune: 18,
        padLevel: base.padLevel * 1.1,
        pluckType: 'triangle',
        cutoffBase: Math.max(base.cutoffBase, 1200),
        cutoffSpan: Math.max(base.cutoffSpan, 4800),
        filterQ: 0.4,
        stab: 0,
        swing: 0,
      }
    case 'surge':
      // Same track, more of it.
      return {
        ...base,
        id,
        bpm: base.bpm * 1.18,
        arpEvery: Math.max(1, Math.round(base.arpEvery / 2)),
        density: base.density + 0.18,
        padLevel: base.padLevel * 1.05,
        pluckLevel: base.pluckLevel * 1.2,
        cutoffBase: base.cutoffBase + 400,
        cutoffSpan: base.cutoffSpan * 1.1,
        swing: base.swing * 0.5,
        kickAt: Math.min(base.kickAt, 0.3),
      }
  }
}

let distCurveCache: Float32Array<ArrayBuffer> | null = null
function distCurve(): Float32Array<ArrayBuffer> {
  if (!distCurveCache) {
    const n = 512
    const curve = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(3.5 * x)
    }
    distCurveCache = curve
  }
  return distCurveCache
}

// ---------------------------------------------------------------------------
// Synthesis helpers
// ---------------------------------------------------------------------------

/** Gain node with linear attack to `peak`, then exponential decay ending at t0+dur. */
function envGain(ac: BaseAudioContext, t0: number, attack: number, peak: number, dur: number): GainNode {
  const g = ac.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0004, t0 + dur)
  return g
}

interface ToneOpts {
  type: OscillatorType
  f0: number
  f1?: number
  t0: number
  dur: number
  peak: number
  attack?: number
  detune?: number
  /** Static lowpass cutoff inserted before the envelope. */
  lp?: number
}

function tone(G: Graph, v: Voice, o: ToneOpts): void {
  const osc = G.ac.createOscillator()
  osc.type = o.type
  osc.frequency.setValueAtTime(o.f0, o.t0)
  if (o.f1 !== undefined && o.f1 !== o.f0) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), o.t0 + o.dur)
  }
  if (o.detune !== undefined) osc.detune.value = o.detune
  const g = envGain(G.ac, o.t0, o.attack ?? 0.004, o.peak, o.dur)
  let head: AudioNode = osc
  if (o.lp !== undefined) {
    const f = G.ac.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = o.lp
    osc.connect(f)
    head = f
  }
  head.connect(g)
  g.connect(v.out)
  osc.start(o.t0)
  osc.stop(o.t0 + o.dur + 0.05)
  v.srcs.push(osc)
}

interface NoiseOpts {
  t0: number
  dur: number
  peak: number
  attack?: number
  filter?: BiquadFilterType
  f0?: number
  f1?: number
  q?: number
  /** Playback rate; < 1 darkens the noise. */
  rate?: number
}

function noiz(G: Graph, v: Voice, o: NoiseOpts): void {
  const src = G.ac.createBufferSource()
  src.buffer = G.noise
  src.loop = true
  if (o.rate !== undefined) src.playbackRate.value = o.rate
  let head: AudioNode = src
  if (o.filter) {
    const f = G.ac.createBiquadFilter()
    f.type = o.filter
    f.frequency.setValueAtTime(o.f0 ?? 1000, o.t0)
    if (o.f1 !== undefined) {
      f.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), o.t0 + o.dur)
    }
    if (o.q !== undefined) f.Q.value = o.q
    src.connect(f)
    head = f
  }
  const g = envGain(G.ac, o.t0, o.attack ?? 0.004, o.peak, o.dur)
  head.connect(g)
  g.connect(v.out)
  src.start(o.t0, Math.random() * 0.4)
  src.stop(o.t0 + o.dur + 0.05)
  v.srcs.push(src)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createAudio(): AudioEngine {
  let graph: Graph | null = null
  let warned = false

  let masterVol = 0.8
  let sfxVol = 1
  let musicVol = 0.6

  const voices: Voice[] = []
  const dying: Voice[] = []

  // Music state
  let musicOn = false
  let schedId: number | null = null
  let step = 0
  let nextTime = 0
  let intensity = 0
  let intensityTarget = 0
  let lastCutoff = -1
  let arpIdx = 4
  /** Long pad oscillators, killed on swap/stop. */
  const padSrcs: OscillatorNode[] = []
  /** Short music notes (plucks, stabs, kicks), killed on swap so none survive it. */
  const noteSrcs: OscillatorNode[] = []

  /** Index into TRACKS of the base track; -1 before the first roll. */
  let baseIdx = -1
  let baseCfg = TRACKS[0]
  /** What the scheduler renders right now. */
  let activeCfg = TRACKS[0]
  /** Dramatic moments taking the music over, oldest first, last one wins. */
  const eventStack: Array<{ id: string; kind: MusicEvent }> = []
  /** A cross-fade in flight: swap to `cfg` once the scheduler reaches `atStep`. */
  let pending: { cfg: TrackConfig; atStep: number } | null = null

  function initGraph(): Graph | null {
    if (typeof AudioContext === 'undefined') {
      if (!warned) {
        warned = true
        console.warn('Tribble audio: WebAudio unavailable, sound disabled')
      }
      return null
    }
    let ac: AudioContext
    try {
      ac = new AudioContext()
    } catch {
      if (!warned) {
        warned = true
        console.warn('Tribble audio: AudioContext creation failed, sound disabled')
      }
      return null
    }
    const master = ac.createGain()
    const sfx = ac.createGain()
    const music = ac.createGain()
    const comp = ac.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 18
    comp.ratio.value = 5
    comp.attack.value = 0.003
    comp.release.value = 0.25
    sfx.connect(master)
    music.connect(master)
    master.connect(comp)
    comp.connect(ac.destination)
    master.gain.value = masterVol
    sfx.gain.value = sfxVol
    music.gain.value = musicVol

    const musicFilter = ac.createBiquadFilter()
    musicFilter.type = 'lowpass'
    musicFilter.frequency.value = activeCfg.cutoffBase
    musicFilter.Q.value = activeCfg.filterQ
    const musicBus = ac.createGain()
    musicBus.gain.value = 0
    musicFilter.connect(musicBus)
    musicBus.connect(music)

    const noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1

    return { ac, master, sfx, music, musicFilter, musicBus, noise }
  }

  // -- SFX voice management -------------------------------------------------

  function makeVoice(G: Graph, dur: number): Voice {
    const now = G.ac.currentTime
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i]
      if (v.end <= now) {
        v.out.disconnect()
        voices.splice(i, 1)
      }
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const v = dying[i]
      if (v.end <= now) {
        v.out.disconnect()
        dying.splice(i, 1)
      }
    }
    if (voices.length >= MAX_VOICES) {
      const v = voices.shift()
      if (v) {
        v.out.gain.cancelScheduledValues(now)
        v.out.gain.setTargetAtTime(0, now, 0.004)
        for (const s of v.srcs) s.stop(now + 0.04)
        v.end = now + 0.08
        dying.push(v)
      }
    }
    const out = G.ac.createGain()
    out.connect(G.sfx)
    const v: Voice = { out, srcs: [], end: now + dur + 0.15 }
    voices.push(v)
    return v
  }

  // -- SFX recipes ----------------------------------------------------------

  function playSfx(G: Graph, name: SfxName, pit: number, vol: number): void {
    const t0 = G.ac.currentTime
    switch (name) {
      case 'launch': {
        // Airy swoosh: noise through a rising bandpass.
        const v = makeVoice(G, 0.35)
        noiz(G, v, { t0, dur: 0.32, peak: 0.45 * vol, attack: 0.02, filter: 'bandpass', f0: 320, f1: 2600, q: 1.4 })
        break
      }
      case 'bounce': {
        const v = makeVoice(G, 0.1)
        tone(G, v, { type: 'square', f0: 480 * pit, f1: 430 * pit, t0, dur: 0.07, peak: 0.16 * vol, attack: 0.002, lp: 2200 })
        break
      }
      case 'impact': {
        // Low thump + noise crack; velocity comes in via vol.
        const v = makeVoice(G, 0.32)
        tone(G, v, { type: 'sine', f0: 115, f1: 42, t0, dur: 0.28, peak: 0.85 * vol, attack: 0.003 })
        noiz(G, v, { t0, dur: 0.05, peak: 0.3 * vol, attack: 0.001, filter: 'bandpass', f0: 2100, q: 0.8 })
        break
      }
      case 'lock': {
        const v = makeVoice(G, 0.08)
        noiz(G, v, { t0, dur: 0.05, peak: 0.25 * vol, attack: 0.001, filter: 'lowpass', f0: 750 })
        tone(G, v, { type: 'sine', f0: 190, t0, dur: 0.06, peak: 0.12 * vol, attack: 0.002 })
        break
      }
      case 'match': {
        // Bubble pop; pit rises per chain step.
        const v = makeVoice(G, 0.17)
        tone(G, v, { type: 'sine', f0: 620 * pit, f1: 250 * pit, t0, dur: 0.13, peak: 0.45 * vol, attack: 0.003 })
        noiz(G, v, { t0, dur: 0.03, peak: 0.1 * vol, attack: 0.001, filter: 'bandpass', f0: 1600 * pit, q: 1.2 })
        break
      }
      case 'clearLine': {
        const v = makeVoice(G, 0.45)
        tone(G, v, { type: 'sawtooth', f0: 300, f1: 1200, t0, dur: 0.38, peak: 0.3 * vol, attack: 0.01, lp: 2800 })
        noiz(G, v, { t0, dur: 0.35, peak: 0.1 * vol, attack: 0.04, filter: 'highpass', f0: 3500 })
        break
      }
      case 'chain': {
        // Quick major-pentatonic run, scaled by pit.
        const v = makeVoice(G, 0.45)
        const base = 500 * pit
        const semis = [0, 4, 7, 12]
        for (let i = 0; i < semis.length; i++) {
          tone(G, v, { type: 'triangle', f0: semiFreq(base, semis[i]), t0: t0 + i * 0.07, dur: 0.2, peak: 0.28 * vol, attack: 0.003 })
        }
        break
      }
      case 'rise': {
        const v = makeVoice(G, 0.55)
        noiz(G, v, { t0, dur: 0.5, peak: 0.7 * vol, attack: 0.08, filter: 'lowpass', f0: 130, q: 1, rate: 0.6 })
        tone(G, v, { type: 'sine', f0: 52, f1: 38, t0, dur: 0.5, peak: 0.25 * vol, attack: 0.05 })
        break
      }
      case 'riseWarning': {
        const v = makeVoice(G, 0.25)
        tone(G, v, { type: 'triangle', f0: 900, t0, dur: 0.05, peak: 0.14 * vol, attack: 0.002 })
        tone(G, v, { type: 'triangle', f0: 900, t0: t0 + 0.16, dur: 0.05, peak: 0.14 * vol, attack: 0.002 })
        break
      }
      case 'danger': {
        // Two soft pulses of a minor-second dyad.
        const v = makeVoice(G, 0.4)
        for (const dt of [0, 0.22]) {
          tone(G, v, { type: 'square', f0: 520, t0: t0 + dt, dur: 0.12, peak: 0.09 * vol, attack: 0.005, lp: 1500 })
          tone(G, v, { type: 'square', f0: 551, t0: t0 + dt, dur: 0.12, peak: 0.09 * vol, attack: 0.005, lp: 1500 })
        }
        break
      }
      case 'levelUp': {
        const v = makeVoice(G, 0.6)
        const semis = [0, 4, 7, 12]
        for (let i = 0; i < semis.length; i++) {
          tone(G, v, { type: 'triangle', f0: semiFreq(620, semis[i]), t0: t0 + i * 0.09, dur: 0.4, peak: 0.2 * vol, attack: 0.004 })
        }
        noiz(G, v, { t0, dur: 0.5, peak: 0.06 * vol, attack: 0.05, filter: 'highpass', f0: 5000 })
        break
      }
      case 'gameOver': {
        // Slow detuned saw fall.
        const v = makeVoice(G, 1.55)
        tone(G, v, { type: 'sawtooth', f0: 235, f1: 52, t0, dur: 1.45, peak: 0.28 * vol, attack: 0.02, detune: -9, lp: 1100 })
        tone(G, v, { type: 'sawtooth', f0: 235, f1: 52, t0, dur: 1.45, peak: 0.28 * vol, attack: 0.02, detune: 9, lp: 1100 })
        break
      }
      case 'win': {
        const v = makeVoice(G, 1.2)
        const semis = [0, 4, 7, 12, 16]
        for (let i = 0; i < semis.length; i++) {
          tone(G, v, { type: 'triangle', f0: semiFreq(440, semis[i]), t0: t0 + i * 0.1, dur: 0.5, peak: 0.22 * vol, attack: 0.005 })
        }
        noiz(G, v, { t0: t0 + 0.4, dur: 0.6, peak: 0.08 * vol, attack: 0.1, filter: 'highpass', f0: 5200 })
        break
      }
      case 'click': {
        const v = makeVoice(G, 0.05)
        tone(G, v, { type: 'square', f0: 1050, t0, dur: 0.035, peak: 0.09 * vol, attack: 0.001, lp: 3800 })
        break
      }
      case 'hover': {
        const v = makeVoice(G, 0.04)
        tone(G, v, { type: 'sine', f0: 1500, t0, dur: 0.03, peak: 0.035 * vol, attack: 0.001 })
        break
      }
      case 'powerCatch': {
        // Glissando sparkle upward.
        const v = makeVoice(G, 0.4)
        tone(G, v, { type: 'sine', f0: 480, f1: 1900, t0, dur: 0.3, peak: 0.28 * vol, attack: 0.005 })
        tone(G, v, { type: 'triangle', f0: 720, f1: 2850, t0, dur: 0.3, peak: 0.14 * vol, attack: 0.005 })
        noiz(G, v, { t0, dur: 0.3, peak: 0.07 * vol, attack: 0.03, filter: 'highpass', f0: 4200 })
        break
      }
      case 'curseSent': {
        const v = makeVoice(G, 0.4)
        tone(G, v, { type: 'sawtooth', f0: 640, f1: 85, t0, dur: 0.34, peak: 0.35 * vol, attack: 0.004, lp: 1600 })
        tone(G, v, { type: 'square', f0: 320, f1: 50, t0, dur: 0.34, peak: 0.18 * vol, attack: 0.004, lp: 900 })
        break
      }
      case 'curseHit': {
        // Tritone saw dyad through a waveshaper.
        const v = makeVoice(G, 0.4)
        const drive = G.ac.createGain()
        drive.gain.value = 5
        const shaper = G.ac.createWaveShaper()
        shaper.curve = distCurve()
        const lp = G.ac.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 2400
        const g = envGain(G.ac, t0, 0.004, 0.5 * vol, 0.32)
        drive.connect(shaper)
        shaper.connect(lp)
        lp.connect(g)
        g.connect(v.out)
        for (const f of [98, 139]) {
          const o = G.ac.createOscillator()
          o.type = 'sawtooth'
          o.frequency.setValueAtTime(f, t0)
          o.frequency.exponentialRampToValueAtTime(f * 0.5, t0 + 0.3)
          o.connect(drive)
          o.start(t0)
          o.stop(t0 + 0.4)
          v.srcs.push(o)
        }
        break
      }
    }
  }

  // -- Music ----------------------------------------------------------------

  /** Track a short music note so a swap can silence it and it frees its nodes. */
  function trackNote(o: OscillatorNode, g: GainNode): void {
    noteSrcs.push(o)
    o.onended = () => {
      o.disconnect()
      g.disconnect()
      const i = noteSrcs.indexOf(o)
      if (i >= 0) noteSrcs.splice(i, 1)
    }
  }

  function schedulePad(G: Graph, chord: readonly number[], t: number, dur: number): void {
    const cfg = activeCfg
    const cg = G.ac.createGain()
    cg.gain.setValueAtTime(0.0001, t)
    cg.gain.linearRampToValueAtTime(clamp(cfg.padLevel, 0.01, 0.18), t + 1.6)
    cg.gain.setTargetAtTime(0.0001, t + dur, 0.5)
    cg.connect(G.musicFilter)
    let live = 0
    for (const semi of chord) {
      for (const det of [-cfg.padDetune, cfg.padDetune]) {
        const o = G.ac.createOscillator()
        o.type = cfg.padType
        o.frequency.value = semiFreq(cfg.padRoot, semi + cfg.transpose)
        o.detune.value = det
        o.connect(cg)
        o.start(t)
        o.stop(t + dur + 1.8)
        padSrcs.push(o)
        live++
        o.onended = () => {
          o.disconnect()
          const i = padSrcs.indexOf(o)
          if (i >= 0) padSrcs.splice(i, 1)
          if (--live === 0) cg.disconnect()
        }
      }
    }
  }

  function schedulePluck(G: Graph, t: number): void {
    const cfg = activeCfg
    const stride = Math.random() < 0.3 ? 2 : 1
    arpIdx += Math.random() < 0.5 ? -stride : stride
    if (arpIdx < 0) arpIdx = 1
    if (arpIdx >= cfg.scale.length) arpIdx = cfg.scale.length - 2
    const semi = cfg.scale[arpIdx] + cfg.transpose + cfg.octaveBias
    const peak = clamp(cfg.pluckLevel + cfg.pluckGain * intensity, 0.01, 0.22)
    const o = G.ac.createOscillator()
    o.type = cfg.pluckType
    o.frequency.value = semiFreq(cfg.arpRoot, semi)
    const g = envGain(G.ac, t, 0.005, peak, 0.3)
    o.connect(g)
    g.connect(G.musicFilter)
    o.start(t)
    o.stop(t + 0.4)
    trackNote(o, g)
    if (cfg.stab > 0 && Math.random() < cfg.stab) {
      // Minor second above the arp note: cheap, reliable dread.
      const s = G.ac.createOscillator()
      s.type = 'square'
      s.frequency.value = semiFreq(cfg.arpRoot, semi + 1)
      const sg = envGain(G.ac, t, 0.004, peak * 0.55, 0.18)
      s.connect(sg)
      sg.connect(G.musicFilter)
      s.start(t)
      s.stop(t + 0.26)
      trackNote(s, sg)
    }
  }

  function scheduleKick(G: Graph, t: number): void {
    const cfg = activeCfg
    const level = (intensity - cfg.kickAt) / Math.max(0.05, 1 - cfg.kickAt)
    if (level <= 0.01) return
    const o = G.ac.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(105, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.1)
    const g = envGain(G.ac, t, 0.002, 0.38 * Math.min(1, level), 0.14)
    o.connect(g)
    g.connect(G.musicBus)
    o.start(t)
    o.stop(t + 0.2)
    trackNote(o, g)
  }

  function scheduleStep(G: Graph, s: number, t: number, secPerStep: number): void {
    const cfg = activeCfg
    if (s % cfg.stepsPerChord === 0) {
      const chord = cfg.chords[Math.floor(s / cfg.stepsPerChord) % cfg.chords.length]
      schedulePad(G, chord, t, cfg.stepsPerChord * secPerStep)
    }
    const density = cfg.density + cfg.densityGain * intensity
    // Swing pushes the off-beats late; pad and kick stay on the grid.
    const swing = s % 2 === 1 ? cfg.swing * secPerStep : 0
    if (s % cfg.arpEvery === 0 || Math.random() < density) schedulePluck(G, t + swing)
    if (intensity > cfg.kickAt && s % 2 === 0) scheduleKick(G, t)
  }

  /** Seconds per 8th note: the track tempo, lifted by intensity. */
  function stepDuration(): number {
    return 30 / clamp(activeCfg.bpm * (1 + TEMPO_SPAN * intensity), 55, 200)
  }

  /** Take the new config over at time `t`, leaving nothing of the old one ringing. */
  function swapTrack(G: Graph, cfg: TrackConfig, t: number): void {
    for (const o of padSrcs) o.stop(t)
    padSrcs.length = 0
    for (const o of noteSrcs) o.stop(t)
    noteSrcs.length = 0
    activeCfg = cfg
    step = 0
    arpIdx = clamp(arpIdx, 0, cfg.scale.length - 1)
    lastCutoff = -1
    G.musicFilter.Q.setTargetAtTime(cfg.filterQ, t, 0.15)
    G.musicBus.gain.setTargetAtTime(1, t, 0.18)
  }

  /**
   * Cross-fade to `cfg`: duck the bus now, swap on the next bar line past the
   * fade, ramp back up. Silent engines just adopt the config directly.
   */
  function crossFadeTo(cfg: TrackConfig): void {
    const G = graph
    if (!G || !musicOn || schedId === null) {
      activeCfg = cfg
      pending = null
      return
    }
    if (cfg.id === (pending ? pending.cfg.id : activeCfg.id)) return
    const now = G.ac.currentTime
    G.musicBus.gain.setTargetAtTime(0.0001, now, FADE_TAU)
    const ahead = Math.max(1, Math.ceil(FADE_SECONDS / stepDuration()))
    let at = step + ahead
    at += (STEPS_PER_BAR - (at % STEPS_PER_BAR)) % STEPS_PER_BAR
    pending = { cfg, atStep: at }
  }

  /** Base track folded through the event stack, oldest first. */
  function computeTarget(): TrackConfig {
    let cfg = baseCfg
    for (const e of eventStack) cfg = deriveEvent(e.kind, cfg)
    return cfg
  }

  /** Pick a base track, never the one that is already selected. */
  function rollBaseTrack(): void {
    if (baseIdx < 0 || TRACKS.length < 2) {
      baseIdx = Math.floor(Math.random() * TRACKS.length)
    } else {
      let i = Math.floor(Math.random() * (TRACKS.length - 1))
      if (i >= baseIdx) i++
      baseIdx = i
    }
    baseCfg = TRACKS[baseIdx]
  }

  function tick(): void {
    const G = graph
    if (!G || !musicOn) return
    intensity += (intensityTarget - intensity) * 0.05
    const cutoff = activeCfg.cutoffBase + activeCfg.cutoffSpan * intensity
    if (Math.abs(cutoff - lastCutoff) > 5) {
      lastCutoff = cutoff
      G.musicFilter.frequency.setTargetAtTime(cutoff, G.ac.currentTime, 0.2)
    }
    const now = G.ac.currentTime
    if (nextTime < now - 0.25) nextTime = now + 0.02 // tab was throttled: skip ahead
    while (nextTime < now + LOOKAHEAD) {
      if (pending && step >= pending.atStep) {
        swapTrack(G, pending.cfg, nextTime)
        pending = null
      }
      const secPerStep = stepDuration()
      scheduleStep(G, step, nextTime, secPerStep)
      nextTime += secPerStep
      step++
    }
  }

  function beginMusic(G: Graph): void {
    if (schedId !== null) return
    const now = G.ac.currentTime
    pending = null
    G.musicFilter.Q.cancelScheduledValues(now)
    G.musicFilter.Q.setTargetAtTime(activeCfg.filterQ, now, 0.05)
    G.musicBus.gain.cancelScheduledValues(now)
    G.musicBus.gain.setTargetAtTime(1, now, 0.2)
    step = 0
    lastCutoff = -1
    nextTime = now + 0.06
    schedId = window.setInterval(tick, TICK_MS)
    tick()
  }

  /** Stop the scheduler and silence everything the music graph is holding. */
  function haltMusic(G: Graph | null): void {
    if (schedId !== null) {
      clearInterval(schedId)
      schedId = null
    }
    pending = null
    if (!G) {
      padSrcs.length = 0
      noteSrcs.length = 0
      return
    }
    const now = G.ac.currentTime
    G.musicBus.gain.cancelScheduledValues(now)
    G.musicBus.gain.setTargetAtTime(0, now, 0.12)
    for (const o of padSrcs) o.stop(now + 0.8)
    padSrcs.length = 0
    for (const o of noteSrcs) o.stop(now + 0.4)
    noteSrcs.length = 0
  }

  /** Drop a dead context (Safari can close ours) so resume() can rebuild one. */
  function disposeGraph(G: Graph): void {
    haltMusic(null)
    voices.length = 0
    dying.length = 0
    lastCutoff = -1
    if (G.ac.state !== 'closed') {
      G.ac.close().catch(() => {})
    }
  }

  // -- Public API -----------------------------------------------------------

  return {
    play(name, opts) {
      const G = graph
      if (!G || G.ac.state !== 'running') return
      const pit = clamp(opts?.pitch ?? 1, 0.25, 4)
      const vol = clamp(opts?.volume ?? 1, 0, 2)
      if (vol <= 0) return
      playSfx(G, name, pit, vol)
    },

    startMusic() {
      if (musicOn) return
      rollBaseTrack()
      activeCfg = computeTarget()
      musicOn = true
      if (graph) beginMusic(graph)
    },

    stopMusic() {
      musicOn = false
      eventStack.length = 0
      haltMusic(graph)
    },

    shuffleMusic() {
      rollBaseTrack()
      crossFadeTo(computeTarget())
    },

    pushMusicEvent(id, kind) {
      const i = eventStack.findIndex((e) => e.id === id)
      if (i >= 0) eventStack.splice(i, 1)
      eventStack.push({ id, kind })
      crossFadeTo(computeTarget())
    },

    popMusicEvent(id) {
      const i = eventStack.findIndex((e) => e.id === id)
      if (i < 0) return
      eventStack.splice(i, 1)
      // The moment is over: come back on a fresh base track, not the old one.
      if (eventStack.length === 0) rollBaseTrack()
      crossFadeTo(computeTarget())
    },

    setIntensity(v) {
      intensityTarget = clamp(v, 0, 1)
    },

    setMasterVolume(v) {
      masterVol = clamp(v, 0, 1)
      const G = graph
      if (G) G.master.gain.setTargetAtTime(masterVol, G.ac.currentTime, VOL_SMOOTH)
    },

    setSfxVolume(v) {
      sfxVol = clamp(v, 0, 1)
      const G = graph
      if (G) G.sfx.gain.setTargetAtTime(sfxVol, G.ac.currentTime, VOL_SMOOTH)
    },

    setMusicVolume(v) {
      musicVol = clamp(v, 0, 1)
      const G = graph
      if (G) G.music.gain.setTargetAtTime(musicVol, G.ac.currentTime, VOL_SMOOTH)
    },

    resume() {
      // A closed context never comes back — throw it away and build a new one.
      if (graph && graph.ac.state === 'closed') {
        disposeGraph(graph)
        graph = null
      }
      if (!graph) graph = initGraph()
      const G = graph
      if (!G) return
      // Safari parks a context in 'interrupted' (call, backgrounding); it is not
      // in the DOM typings and never recovers unless we resume it explicitly.
      const state: string = G.ac.state
      if (state === 'suspended' || state === 'interrupted') {
        G.ac.resume().catch(() => {})
      }
      if (musicOn) beginMusic(G)
    },
  }
}
