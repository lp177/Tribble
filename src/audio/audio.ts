// Procedural WebAudio engine: all SFX are synthesized (oscillators + one shared
// noise buffer), music is a generative A-minor-pentatonic loop driven by a
// lookahead scheduler. No asset files, no imports beyond shared types.

import type { AudioEngine, SfxName } from '../types'

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
/** 8th-note steps per chord: 4 bars of 4/4. */
const STEPS_PER_CHORD = 32
/** A-minor pentatonic, semitones above A3 (220 Hz), two octaves. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24]
/** Am, F, C, G — open voicings as semitones above A2 (110 Hz). */
const CHORDS = [
  [0, 7, 15],
  [-4, 3, 12],
  [3, 10, 19],
  [-2, 5, 14],
]
const PAD_LEVEL = 0.09

const semiFreq = (base: number, semi: number): number => base * Math.pow(2, semi / 12)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

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
  const padSrcs: OscillatorNode[] = []

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
    musicFilter.frequency.value = 900
    musicFilter.Q.value = 0.6
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

  function schedulePad(G: Graph, chord: number[], t: number, dur: number): void {
    const cg = G.ac.createGain()
    cg.gain.setValueAtTime(0.0001, t)
    cg.gain.linearRampToValueAtTime(PAD_LEVEL, t + 1.6)
    cg.gain.setTargetAtTime(0.0001, t + dur, 0.5)
    cg.connect(G.musicFilter)
    for (const semi of chord) {
      for (const det of [-7, 7]) {
        const o = G.ac.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = semiFreq(110, semi)
        o.detune.value = det
        o.connect(cg)
        o.start(t)
        o.stop(t + dur + 1.8)
        padSrcs.push(o)
        o.onended = () => {
          const i = padSrcs.indexOf(o)
          if (i >= 0) padSrcs.splice(i, 1)
        }
      }
    }
  }

  function schedulePluck(G: Graph, t: number): void {
    const stride = Math.random() < 0.3 ? 2 : 1
    arpIdx += Math.random() < 0.5 ? -stride : stride
    if (arpIdx < 0) arpIdx = 1
    if (arpIdx >= PENTA.length) arpIdx = PENTA.length - 2
    const o = G.ac.createOscillator()
    o.type = 'triangle'
    o.frequency.value = semiFreq(220, PENTA[arpIdx])
    const g = envGain(G.ac, t, 0.005, 0.09 + 0.07 * intensity, 0.3)
    o.connect(g)
    g.connect(G.musicFilter)
    o.start(t)
    o.stop(t + 0.4)
  }

  function scheduleKick(G: Graph, t: number): void {
    const level = (intensity - 0.6) / 0.4
    if (level <= 0.01) return
    const o = G.ac.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(105, t)
    o.frequency.exponentialRampToValueAtTime(40, t + 0.1)
    const g = envGain(G.ac, t, 0.002, 0.38 * level, 0.14)
    o.connect(g)
    g.connect(G.musicBus)
    o.start(t)
    o.stop(t + 0.2)
  }

  function scheduleStep(G: Graph, s: number, t: number, secPerStep: number): void {
    if (s % STEPS_PER_CHORD === 0) {
      const chord = CHORDS[Math.floor(s / STEPS_PER_CHORD) % CHORDS.length]
      schedulePad(G, chord, t, STEPS_PER_CHORD * secPerStep)
    }
    const density = 0.3 + 0.55 * intensity
    if (s % 8 === 0 || Math.random() < density) schedulePluck(G, t)
    if (intensity > 0.6 && s % 2 === 0) scheduleKick(G, t)
  }

  function tick(): void {
    const G = graph
    if (!G || !musicOn) return
    intensity += (intensityTarget - intensity) * 0.05
    const cutoff = 500 + 3800 * intensity
    if (Math.abs(cutoff - lastCutoff) > 5) {
      lastCutoff = cutoff
      G.musicFilter.frequency.setTargetAtTime(cutoff, G.ac.currentTime, 0.2)
    }
    const now = G.ac.currentTime
    if (nextTime < now - 0.25) nextTime = now + 0.02 // tab was throttled: skip ahead
    while (nextTime < now + LOOKAHEAD) {
      const secPerStep = 30 / (92 + 30 * intensity) // 92..122 BPM, 8th notes
      scheduleStep(G, step, nextTime, secPerStep)
      nextTime += secPerStep
      step++
    }
  }

  function beginMusic(G: Graph): void {
    if (schedId !== null) return
    const now = G.ac.currentTime
    G.musicBus.gain.cancelScheduledValues(now)
    G.musicBus.gain.setTargetAtTime(1, now, 0.2)
    step = 0
    nextTime = now + 0.06
    schedId = window.setInterval(tick, TICK_MS)
    tick()
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
      musicOn = true
      if (graph) beginMusic(graph)
    },

    stopMusic() {
      if (!musicOn) return
      musicOn = false
      if (schedId !== null) {
        clearInterval(schedId)
        schedId = null
      }
      const G = graph
      if (G) {
        const now = G.ac.currentTime
        G.musicBus.gain.cancelScheduledValues(now)
        G.musicBus.gain.setTargetAtTime(0, now, 0.12)
        for (const o of padSrcs) o.stop(now + 0.8)
        padSrcs.length = 0
      }
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
      if (!graph) graph = initGraph()
      const G = graph
      if (!G) return
      if (G.ac.state === 'suspended') {
        G.ac.resume().catch(() => {})
      }
      if (musicOn) beginMusic(G)
    },
  }
}
