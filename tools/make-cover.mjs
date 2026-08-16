#!/usr/bin/env node
/**
 * Tribble — social cover art generator (key art, not a screenshot).
 *
 * Draws the poster procedurally on a Canvas2D surface at 2400x1260 inside a
 * headless Chrome page, then downsamples to the 1200x630 Open Graph card.
 * Nothing is captured from the game: the palette and the block/orb language are
 * ported from src/render/theme.ts + src/style.css, everything else is composed
 * for the cover.
 *
 * The image: one hero — a glass bubble with a four-colour tetromino fused
 * inside it — caught in flight, wake streaming off behind it toward the top
 * left, bearing down on a silhouetted wall of bubbles cropped by the right
 * edge. Title owns the bottom-left band and never touches the hero.
 *
 * Run it:
 *   node tools/make-cover.mjs
 *
 * Writes:
 *   docs/social-card.png     (GitHub Pages serves docs/)
 *   public/social-card.png   (so a future vite build keeps it)
 *
 * Options:
 *   --debug-dir <dir>   also dump the full-size 2400x1260 render there
 *
 * Needs: playwright (devDependency) and /usr/bin/google-chrome.
 * /usr/bin/magick is used for the downscale when present; without it the script
 * falls back to an in-page high-quality canvas downscale, so it still runs.
 * The render is seeded, so re-running produces an identical PNG.
 */

import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir, readFile, rm, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const debugDir = argv.includes('--debug-dir') ? argv[argv.indexOf('--debug-dir') + 1] : null

const BIG_W = 2400
const BIG_H = 1260
const OUT_W = 1200
const OUT_H = 630
const MAGICK = '/usr/bin/magick'

// ---------------------------------------------------------------------------
// The page: two <canvas> (full-size render + downscale target) and the art.
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#000;}
  canvas{display:block;position:absolute;left:0;}
  #big{top:0;}
  #small{top:${BIG_H}px;}
</style>
<canvas id="big" width="${BIG_W}" height="${BIG_H}"></canvas>
<canvas id="small" width="${OUT_W}" height="${OUT_H}"></canvas>
<script>
'use strict';
var W = ${BIG_W}, H = ${BIG_H};
var TAU = Math.PI * 2;

// -- palette, lifted from src/render/theme.ts and src/style.css --------------
var PAL = {
  pink:   '#ff5c8a',   // COLOR_HEX[0]
  yellow: '#ffd166',   // COLOR_HEX[1]
  green:  '#06d6a0',   // COLOR_HEX[2]
  cyan:   '#4cc9f0'    // COLOR_HEX[3]
};
var VIOLET  = '#b388ff';  // POWER_COLOR / --primary-light
var PRIMARY = '#7c4dff';  // --primary
var GROUND  = '#07060f';  // just under --bg #0f0f17 / theme-color #12121a

// -- colour helpers ---------------------------------------------------------
function rgbOf(hex) {
  var b = hex.slice(1);
  if (b.length === 3) b = b[0]+b[0]+b[1]+b[1]+b[2]+b[2];
  var v = parseInt(b, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function mixTo(hex, tr, tg, tb, t) {
  var c = rgbOf(hex);
  return [Math.round(c[0] + (tr - c[0]) * t),
          Math.round(c[1] + (tg - c[1]) * t),
          Math.round(c[2] + (tb - c[2]) * t)];
}
function lighten(hex, t) { var c = mixTo(hex, 255, 255, 255, t); return 'rgb('+c[0]+','+c[1]+','+c[2]+')'; }
function darken(hex, t)  { var c = mixTo(hex, 10, 8, 22, t);     return 'rgb('+c[0]+','+c[1]+','+c[2]+')'; }
function rgba(hex, a)    { var c = rgbOf(hex);                   return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; }
function rgbaL(hex, t, a){ var c = mixTo(hex, 255, 255, 255, t); return 'rgba('+c[0]+','+c[1]+','+c[2]+','+a+')'; }

// -- deterministic rng ------------------------------------------------------
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var R = mulberry(20260817);
function rr(a, b) { return a + (b - a) * R(); }
function pick(arr) { return arr[(R() * arr.length) | 0]; }

function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }

// ===========================================================================
// A block — the poster-grade version of theme.ts drawBlock(): graded body,
// glossy top face, seated bottom shadow, dark rim and a lit top-left edge.
// Drawn in local coords around (0,0) so pieces can group them rigidly.
// ===========================================================================
function block(c, x, y, s, hex, gloss) {
  var h = s / 2, rad = s * 0.20;

  var g = c.createLinearGradient(x - h, y - h * 1.2, x + h * 0.8, y + h);
  g.addColorStop(0, lighten(hex, 0.56));
  g.addColorStop(0.30, lighten(hex, 0.14));
  g.addColorStop(0.68, darken(hex, 0.26));
  g.addColorStop(1, darken(hex, 0.56));
  rrect(c, x - h, y - h, s, s, rad);
  c.fillStyle = g;
  c.fill();

  c.save();
  rrect(c, x - h, y - h, s, s, rad); c.clip();

  // inner floor shadow, bottom-right
  var sg = c.createRadialGradient(x + h * 0.6, y + h * 0.75, s * 0.04, x + h * 0.5, y + h * 0.6, s);
  sg.addColorStop(0, 'rgba(5,4,12,0.46)');
  sg.addColorStop(1, 'rgba(5,4,12,0)');
  c.fillStyle = sg;
  c.fillRect(x - h, y - h, s, s);

  // glossy top face (theme.ts bevel, graded). Softened and run wider than the
  // block so its own edges fall outside the clip — a hard-edged gloss panel is
  // what makes a rounded square read as a phone app icon.
  if (gloss !== false) {
    var tg = c.createLinearGradient(0, y - h * 0.98, 0, y + h * 0.06);
    tg.addColorStop(0, 'rgba(255,255,255,0.64)');
    tg.addColorStop(0.42, 'rgba(255,255,255,0.20)');
    tg.addColorStop(1, 'rgba(255,255,255,0)');
    c.filter = 'blur(' + (s * 0.030).toFixed(2) + 'px)';
    rrect(c, x - h * 1.06, y - h * 1.10, s * 1.06, s * 0.62, rad * 1.1);
    c.fillStyle = tg;
    c.fill();
    c.filter = 'none';
  }
  c.restore();

  // dark seating rim
  var lw = Math.max(1, s * 0.055);
  c.lineWidth = lw;
  c.strokeStyle = darken(hex, 0.70);
  rrect(c, x - h + lw / 2, y - h + lw / 2, s - lw, s - lw, Math.max(1, rad - lw / 2));
  c.stroke();

  // Lit outer edge, strongest along the top. Faded out with a gradient rather
  // than clipped to a rectangle: a clip leaves a hard horizontal cut across
  // both side edges, which is plainly visible once the block is poster-sized.
  var eg = c.createLinearGradient(0, y - h, 0, y + h * 0.45);
  eg.addColorStop(0, rgbaL(hex, 0.84, 0.95));
  eg.addColorStop(0.42, rgbaL(hex, 0.80, 0.46));
  eg.addColorStop(1, rgbaL(hex, 0.80, 0));
  c.lineWidth = lw * 0.9;
  c.strokeStyle = eg;
  rrect(c, x - h + lw / 2, y - h + lw / 2, s - lw, s - lw, Math.max(1, rad - lw / 2));
  c.stroke();
}

// ---------------------------------------------------------------------------
// Tetromino shapes, cell offsets in cell units around the piece centre.
// ---------------------------------------------------------------------------
var SHAPES = {
  I: [[-1.5, 0], [-0.5, 0], [0.5, 0], [1.5, 0]],
  O: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]],
  T: [[-1, -0.5], [0, -0.5], [1, -0.5], [0, 0.5]],
  L: [[-0.5, -1], [-0.5, 0], [-0.5, 1], [0.5, 1]],
  J: [[0.5, -1], [0.5, 0], [0.5, 1], [-0.5, 1]],
  S: [[-1, 0.5], [0, 0.5], [0, -0.5], [1, -0.5]],
  Z: [[-1, -0.5], [0, -0.5], [0, 0.5], [1, 0.5]]
};

/** A whole tetromino: one colour per cell, exactly how Tribble colours a piece. */
function drawPiece(c, cx, cy, cell, kind, cols, o) {
  o = o || {};
  var a = o.alpha === undefined ? 1 : o.alpha;
  if (a <= 0) return;
  var cells = SHAPES[kind];
  c.save();
  c.globalAlpha = a;
  c.translate(cx, cy);
  c.rotate(o.rot || 0);

  // emissive pool beneath the piece
  var glow = o.glow === undefined ? 0.6 : o.glow;
  if (glow > 0) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (var k = 0; k < cells.length; k++) {
      var q = cells[k], qc = cols[k % cols.length];
      var gg = c.createRadialGradient(q[0] * cell, q[1] * cell, 0, q[0] * cell, q[1] * cell, cell * 1.6);
      gg.addColorStop(0, rgba(qc, 0.46 * glow));
      gg.addColorStop(0.42, rgba(qc, 0.15 * glow));
      gg.addColorStop(1, rgba(qc, 0));
      c.fillStyle = gg;
      c.fillRect(q[0] * cell - cell * 1.8, q[1] * cell - cell * 1.8, cell * 3.6, cell * 3.6);
    }
    c.restore();
  }

  // glowOnly: just the emissive pools, no block bodies. Used for the bubbles in
  // the midground wall, where drawing real blocks turns into confetti and
  // drawing nothing turns into featureless grey.
  if (!o.glowOnly) {
    for (var i = 0; i < cells.length; i++) {
      block(c, cells[i][0] * cell, cells[i][1] * cell, cell * 0.965, cols[i % cols.length], o.gloss);
    }
  }
  c.restore();
}

/** Same piece, caught mid-flight: a light trail plus ghosts along (vx, vy). */
function drawPieceMoving(c, cx, cy, cell, kind, cols, vx, vy, o) {
  o = o || {};
  var n = o.ghosts === undefined ? 6 : o.ghosts;
  var base = o.alpha === undefined ? 1 : o.alpha;
  var len = Math.hypot(vx, vy);
  if (len > 2) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    var tg = c.createLinearGradient(cx, cy, cx - vx, cy - vy);
    tg.addColorStop(0, rgba(cols[0], 0.30 * base));
    tg.addColorStop(0.5, rgba(cols[0], 0.09 * base));
    tg.addColorStop(1, rgba(cols[0], 0));
    c.strokeStyle = tg;
    c.lineWidth = cell * 1.15;
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx - vx, cy - vy); c.stroke();
    c.restore();
  }
  c.save();
  for (var i = n; i >= 1; i--) {
    var f = i / n;
    c.filter = 'blur(' + (cell * 0.10 + cell * 0.34 * f).toFixed(1) + 'px)';
    drawPiece(c, cx - vx * f * 0.72, cy - vy * f * 0.72, cell * (1 - f * 0.06), kind, cols, {
      rot: (o.rot || 0) - (o.spin || 0) * f * 0.7,
      alpha: base * 0.24 * (1 - f * 0.9), glow: 0, gloss: false
    });
  }
  c.restore();
  drawPiece(c, cx, cy, cell, kind, cols, { rot: o.rot || 0, alpha: base, glow: o.glow });
}

// ===========================================================================
// The glass bubble. This is the hero object, so it is modelled rather than
// filled: form gradient, internal emission from the contents, refraction at
// the rim, occluded terminator, caustic, glass-shell thickness, a window
// reflection, a conic fresnel, a coloured rim light opposite the key, key
// speculars and a dispersion fringe. opts.contents paints inside, local coords.
// ===========================================================================
function drawOrb(c, cx, cy, r, o) {
  o = o || {};
  var tint  = o.tint || VIOLET;
  var rimC  = o.rimColor || PAL.pink;
  var lx = -0.52, ly = -0.58;                 // key light direction (upper-left)
  var detail = o.detail !== false;
  var a = o.alpha === undefined ? 1 : o.alpha;
  var emit = o.emit === undefined ? 0 : o.emit;   // how hard the contents glow

  c.save();
  c.globalAlpha = a;

  // 1. atmospheric bloom around the sphere
  c.save();
  c.globalCompositeOperation = 'lighter';
  var BR = r * (o.bloom || 2.2);
  var bl = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, BR);
  bl.addColorStop(0, rgba(tint, 0.30));
  bl.addColorStop(0.26, rgba(tint, 0.11));
  bl.addColorStop(1, rgba(tint, 0));
  c.fillStyle = bl;
  c.beginPath(); c.arc(cx, cy, BR, 0, TAU); c.fill();
  c.restore();

  // 2. glass body: dark core, brightening to a fresnel edge
  var body = c.createRadialGradient(cx + lx * r * 0.40, cy + ly * r * 0.40, r * 0.05, cx, cy, r);
  body.addColorStop(0, 'rgba(34,27,68,0.95)');
  body.addColorStop(0.40, 'rgba(15,12,32,0.97)');
  body.addColorStop(0.82, 'rgba(10,8,21,0.98)');
  body.addColorStop(0.955, rgba(tint, 0.30));
  body.addColorStop(1, rgbaL(tint, 0.32, 0.62));
  c.beginPath(); c.arc(cx, cy, r, 0, TAU);
  c.fillStyle = body;
  c.fill();

  // 2b. the contents light the glass from inside — enough to stop the hero
  //     being a dark hole, not so much that the glass turns to milk.
  if (emit > 0) {
    c.save();
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip();
    c.globalCompositeOperation = 'lighter';
    var em = c.createRadialGradient(cx, cy, 0, cx, cy, r * 1.02);
    em.addColorStop(0, rgbaL(tint, 0.40, 0.15 * emit));
    em.addColorStop(0.55, rgba(tint, 0.055 * emit));
    em.addColorStop(1, rgba(tint, 0));
    c.fillStyle = em;
    c.fillRect(cx - r, cy - r, r * 2, r * 2);
    c.restore();
  }

  // 3. contents, refracted: faint chromatic ghosts, then the sharp copy
  if (o.contents) {
    c.save();
    c.beginPath(); c.arc(cx, cy, r * 0.97, 0, TAU); c.clip();
    c.translate(cx, cy);
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.18;
    c.filter = 'blur(' + (r * 0.04).toFixed(2) + 'px)';
    c.save(); c.translate(-r * 0.024, -r * 0.011); o.contents(c, r); c.restore();
    c.save(); c.translate(r * 0.024, r * 0.011); o.contents(c, r); c.restore();
    c.filter = 'none';
    c.restore();
    o.contents(c, r);
    c.restore();

    // 3b. rim refraction: a thin band near the edge where the contents are
    //     magnified and smeared, which is what a sphere of glass does. Kept
    //     narrow and faint — pushed further it turns the whole ball milky.
    if (detail) {
      c.save();
      c.beginPath();
      c.arc(cx, cy, r * 0.965, 0, TAU);
      c.arc(cx, cy, r * 0.84, 0, TAU, true);
      c.clip('evenodd');
      c.translate(cx, cy);
      c.globalAlpha = 0.16;
      c.filter = 'blur(' + (r * 0.05).toFixed(2) + 'px)';
      c.scale(1.30, 1.30);
      o.contents(c, r);
      c.filter = 'none';
      c.restore();
    }
  }

  // everything below is surface, clipped to the sphere
  c.save();
  c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip();

  // 4. occlusion: the terminator, opposite the key. Kept light enough that the
  //    shadow side still separates from the background.
  var occ = c.createRadialGradient(cx - lx * r * 0.95, cy - ly * r * 0.95, r * 0.06,
                                   cx - lx * r * 0.45, cy - ly * r * 0.45, r * 1.45);
  occ.addColorStop(0, 'rgba(4,3,10,0.64)');
  occ.addColorStop(0.5, 'rgba(4,3,10,0.24)');
  occ.addColorStop(1, 'rgba(4,3,10,0)');
  c.fillStyle = occ;
  c.fillRect(cx - r, cy - r, r * 2, r * 2);

  // 5. caustic: light that came through the glass, pooled on the far inside rim
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(cx, cy);
  c.rotate(Math.atan2(-ly, -lx));
  var ca = c.createRadialGradient(r * 0.68, 0, r * 0.02, r * 0.74, 0, r * 0.58);
  ca.addColorStop(0, rgbaL(tint, 0.58, 0.40));
  ca.addColorStop(0.4, rgba(tint, 0.14));
  ca.addColorStop(1, rgba(tint, 0));
  c.fillStyle = ca;
  c.beginPath(); c.ellipse(r * 0.68, 0, r * 0.40, r * 0.60, 0, 0, TAU); c.fill();
  c.restore();

  if (detail) {
    // 6. internal bubbles, each with its own micro-highlight
    var bn = Math.round(r / 44);
    for (var i = 0; i < bn; i++) {
      var ba = R() * TAU, bd = Math.sqrt(R()) * r * 0.86, br = rr(r * 0.008, r * 0.024);
      var bx = cx + Math.cos(ba) * bd, by = cy + Math.sin(ba) * bd;
      c.beginPath(); c.arc(bx, by, br, 0, TAU);
      c.fillStyle = 'rgba(220,232,255,0.14)'; c.fill();
      c.beginPath(); c.arc(bx - br * 0.3, by - br * 0.35, br * 0.4, 0, TAU);
      c.fillStyle = 'rgba(255,255,255,0.6)'; c.fill();
    }

    // 6b. glass-shell thickness: a bright inner ring just under the surface
    c.save();
    c.globalCompositeOperation = 'lighter';
    var sh2 = c.createRadialGradient(cx, cy, r * 0.88, cx, cy, r);
    sh2.addColorStop(0, rgba(tint, 0));
    sh2.addColorStop(0.55, rgba(tint, 0.07));
    sh2.addColorStop(1, rgbaL(tint, 0.30, 0.15));
    c.fillStyle = sh2;
    c.fillRect(cx - r, cy - r, r * 2, r * 2);
    c.restore();
  }

  // 7. broad sheen over the upper third
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(cx, cy); c.rotate(-0.50);
  var sh = c.createLinearGradient(0, -r * 0.95, 0, -r * 0.02);
  sh.addColorStop(0, 'rgba(255,255,255,0.10)');
  sh.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = sh;
  c.beginPath(); c.ellipse(0, -r * 0.44, r * 0.88, r * 0.52, 0, 0, TAU); c.fill();
  c.restore();

  // 7b. window reflection — the small mullioned rectangle that instantly reads
  //     as "this is glass" rather than "this is a shaded circle". Small and
  //     crisp: a big soft one just looks like a smudge.
  if (detail) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.translate(cx - r * 0.46, cy - r * 0.46);
    c.rotate(-0.42);
    c.filter = 'blur(' + (r * 0.016).toFixed(2) + 'px)';
    var wg = c.createLinearGradient(0, -r * 0.20, 0, r * 0.20);
    wg.addColorStop(0, 'rgba(214,238,255,0.20)');
    wg.addColorStop(1, 'rgba(214,238,255,0.015)');
    c.fillStyle = wg;
    // four panes with mullion gaps — additive, so no destructive compositing
    var pw = r * 0.155, ph = r * 0.185, gp = r * 0.022, rd = r * 0.05;
    for (var px2 = 0; px2 < 2; px2++) {
      for (var py2 = 0; py2 < 2; py2++) {
        rrect(c, px2 ? gp : -pw - gp, py2 ? gp : -ph - gp, pw, ph, rd);
        c.fill();
      }
    }
    c.restore();
  }

  c.restore(); // unclip

  // 8. fresnel rim: cold and hard on the key side, tinted on the shadow side.
  //    Off for the motion ghosts — a stretched, cropped fresnel arc floating in
  //    the sky reads as a stray circle, not as blur.
  if (o.fresnel !== false) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  var lw = Math.max(1.5, r * 0.034);
  var cg = c.createConicGradient(Math.PI * 0.60, cx, cy);
  cg.addColorStop(0.00, rgba(tint, 0.07));
  cg.addColorStop(0.09, rgbaL(tint, 0.22, 0.72));
  cg.addColorStop(0.24, rgba(tint, 0.20));
  cg.addColorStop(0.46, 'rgba(150,200,255,0.12)');
  cg.addColorStop(0.60, 'rgba(232,247,255,0.98)');  // upper-left key edge
  cg.addColorStop(0.74, 'rgba(160,205,255,0.24)');
  cg.addColorStop(0.86, rgba(PAL.cyan, 0.40));      // cool bounce, lower-left
  cg.addColorStop(1.00, rgba(tint, 0.07));
  c.strokeStyle = cg;
  c.lineWidth = lw;
  c.beginPath(); c.arc(cx, cy, r - lw * 0.5, 0, TAU); c.stroke();
  c.restore();
  }

  // 9. THE rim light — a hot coloured edge on the side away from the key.
  //    Brief rule 4: the single most effective way to lift a figure off its
  //    background. Painted in segments so it falls off smoothly.
  if (o.rim !== false) {
    var ra = Math.atan2(-ly, -lx);                 // lower-right, opposite key
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'butt';
    for (var pass = 0; pass < 2; pass++) {
      c.filter = pass === 0 ? 'blur(' + (r * 0.05).toFixed(1) + 'px)' : 'none';
      var amp = pass === 0 ? 0.55 : 0.95;
      var wdt = pass === 0 ? r * 0.10 : r * 0.036;
      var N = 44, span = 1.30;
      for (var s = 0; s < N; s++) {
        var t0 = -span + (2 * span) * (s / N);
        var t1 = -span + (2 * span) * ((s + 1) / N);
        var f = Math.pow(Math.cos((t0 + t1) * 0.5 / span * Math.PI * 0.5), 2.1);
        c.strokeStyle = rgbaL(rimC, 0.30, amp * f);
        c.lineWidth = wdt;
        c.beginPath();
        c.arc(cx, cy, r - wdt * 0.42, ra + t0, ra + t1);
        c.stroke();
      }
    }
    c.filter = 'none';
    c.restore();
  }

  // 10. key speculars
  c.save();
  c.globalCompositeOperation = 'lighter';
  var hx = cx + lx * r * 0.76, hy = cy + ly * r * 0.76;
  c.translate(hx, hy); c.rotate(0.62);
  var sp = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.24);
  sp.addColorStop(0, 'rgba(255,255,255,0.86)');
  sp.addColorStop(0.24, 'rgba(228,243,255,0.32)');
  sp.addColorStop(1, 'rgba(200,228,255,0)');
  c.fillStyle = sp;
  c.beginPath(); c.ellipse(0, 0, r * 0.24, r * 0.125, 0, 0, TAU); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.98)';
  c.beginPath(); c.ellipse(-r * 0.02, -r * 0.008, r * 0.074, r * 0.037, 0, 0, TAU); c.fill();
  c.restore();

  // small secondary glint, low-left
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(cx - r * 0.56, cy + r * 0.54); c.rotate(-0.68);
  var sp2 = c.createRadialGradient(0, 0, 0, 0, 0, r * 0.17);
  sp2.addColorStop(0, rgbaL(PAL.cyan, 0.7, 0.28));
  sp2.addColorStop(1, rgba(PAL.cyan, 0));
  c.fillStyle = sp2;
  c.beginPath(); c.ellipse(0, 0, r * 0.17, r * 0.045, 0, 0, TAU); c.fill();
  c.restore();

  // 11. dispersion fringe: cyan splits up-left, magenta down-right
  if (detail) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineWidth = Math.max(1, r * 0.012);
    c.strokeStyle = rgba(PAL.cyan, 0.34);
    c.beginPath(); c.arc(cx - r * 0.012, cy - r * 0.014, r * 0.985, Math.PI * 0.92, Math.PI * 1.72); c.stroke();
    c.strokeStyle = rgba(PAL.pink, 0.28);
    c.beginPath(); c.arc(cx + r * 0.012, cy + r * 0.014, r * 0.985, Math.PI * -0.05, Math.PI * 0.70); c.stroke();
    c.restore();
  }

  c.restore();
}

// ===========================================================================
// Scene layout
// ===========================================================================
var HX = 1568, HY = 498, HR = 352;          // hero bubble
var TRAV = 0.44;                            // travel bearing: down and to the right
var DX = Math.cos(TRAV), DY = Math.sin(TRAV);

// The four cells of the hero piece, in Tribble's own per-cell colouring.
var HERO_COLS = [PAL.cyan, PAL.yellow, PAL.pink, PAL.green];

function background(c) {
  c.fillStyle = GROUND;
  c.fillRect(0, 0, W, H);

  function glow(x, y, r, hex, a0) {
    var g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(hex, a0));
    g.addColorStop(0.42, rgba(hex, a0 * 0.32));
    g.addColorStop(1, rgba(hex, 0));
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }
  glow(HX, HY - 10, 1120, PRIMARY, 0.34);
  glow(HX - 760, HY - 400, 900, PAL.cyan, 0.085);   // cool wash along the wake
  glow(2280, 1080, 820, PAL.pink, 0.075);           // warm accent behind the wall

  // motion streaks parallel to the shot — energy, kept nearly subliminal
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (var i = 0; i < 26; i++) {
    var ox = rr(-400, W), oy = rr(-120, H * 0.92);
    var ln = rr(300, 1150);
    var g = c.createLinearGradient(ox, oy, ox + DX * ln, oy + DY * ln);
    var col = R() < 0.5 ? PAL.cyan : VIOLET;
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(0.45, rgba(col, rr(0.020, 0.055)));
    g.addColorStop(1, rgba(col, 0));
    c.strokeStyle = g;
    c.lineWidth = rr(2, 11);
    c.lineCap = 'round';
    c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + DX * ln, oy + DY * ln); c.stroke();
  }
  c.restore();

  // drifting motes
  for (var m = 0; m < 110; m++) {
    var mx = R() * W, my = R() * H;
    c.fillStyle = rgba(pick([VIOLET, PAL.cyan, PAL.pink, '#ffffff']), rr(0.08, 0.42));
    c.beginPath(); c.arc(mx, my, rr(1.0, 3.0), 0, TAU); c.fill();
  }
}

// ---------------------------------------------------------------------------
// Midground layer 2: the wall of bubbles the shot is bearing down on. Dark,
// desaturated and softly out of focus so it reads as a silhouette behind the
// hero rather than as competition for it.
// ---------------------------------------------------------------------------
// Irregular and overlapping on purpose: an even lattice of them turns into a
// polka-dot pattern, and readable blocks inside each one turns into confetti.
// They are lit from within and edged by their fresnel, so they read as a packed
// mass of bubbles without ever competing with the hero for attention.
var WALL = [
  { x: 2352, y: 206,  r: 132, k: 'O', col: PAL.cyan },
  { x: 2160, y: 336,  r: 100, k: 'T', col: PAL.pink },
  { x: 2336, y: 404,  r: 116, k: 'S', col: VIOLET },
  { x: 2218, y: 524,  r: 126, k: 'L', col: PAL.green },
  { x: 2394, y: 586,  r: 110, k: 'Z', col: PAL.cyan },
  { x: 2148, y: 704,  r: 118, k: 'J', col: PAL.yellow },
  { x: 2302, y: 764,  r: 134, k: 'O', col: PAL.pink },
  { x: 2192, y: 902,  r: 108, k: 'T', col: PAL.cyan },
  { x: 2374, y: 944,  r: 120, k: 'S', col: PAL.green },
  { x: 2124, y: 1058, r: 124, k: 'L', col: VIOLET },
  { x: 2324, y: 1136, r: 112, k: 'Z', col: PAL.yellow }
];

function bubbleWall(c) {
  // a dark mass for them to sit against, so the right edge is a wall not a fringe
  var wg = c.createLinearGradient(1930, 0, 2400, 0);
  wg.addColorStop(0, 'rgba(6,5,16,0)');
  wg.addColorStop(1, 'rgba(9,7,24,0.72)');
  c.fillStyle = wg;
  c.fillRect(1900, 0, 500, H);

  c.save();
  c.filter = 'blur(7px)';
  for (var i = 0; i < WALL.length; i++) {
    var b = WALL[i];
    (function (b) {
      var lit = lighten(b.col, 0.30);
      drawOrb(c, b.x, b.y, b.r, {
        tint: b.col, bloom: 1.6, alpha: 0.50, detail: false, rim: false, emit: 1.4,
        contents: function (cc, r) {
          drawPiece(cc, 0, 0, r * 0.44, b.k, [lit, lit, lit, lit],
            { rot: 0.3, glow: 1.15, glowOnly: true });
        }
      });
    })(b);
  }
  c.restore();
}

// ---------------------------------------------------------------------------
// The wake: what makes the hero read as travelling rather than floating.
// A tapering cone of light, motion-blurred ghosts of the bubble itself
// receding up-left, and a scatter of trailing sparks.
// ---------------------------------------------------------------------------
function wake(c) {
  var bx = -DX, by = -DY;                       // backwards along travel
  var px = -DY, py = DX;                        // perpendicular

  // 1. the cone
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.filter = 'blur(46px)';
  var far = 2050, w0 = HR * 1.02, w1 = HR * 0.10;
  var g = c.createLinearGradient(HX, HY, HX + bx * far, HY + by * far);
  g.addColorStop(0, rgba(VIOLET, 0.30));
  g.addColorStop(0.22, rgba(VIOLET, 0.14));
  g.addColorStop(0.6, rgba(PAL.cyan, 0.055));
  g.addColorStop(1, rgba(PAL.cyan, 0));
  c.fillStyle = g;
  c.beginPath();
  c.moveTo(HX + px * w0, HY + py * w0);
  c.lineTo(HX + bx * far + px * w1, HY + by * far + py * w1);
  c.lineTo(HX + bx * far - px * w1, HY + by * far - py * w1);
  c.lineTo(HX - px * w0, HY - py * w0);
  c.closePath();
  c.fill();
  c.restore();

  // 1b. a hotter, narrower core cone right behind the bubble
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.filter = 'blur(24px)';
  var cfar = 900, cw0 = HR * 0.62;
  var cgd = c.createLinearGradient(HX, HY, HX + bx * cfar, HY + by * cfar);
  cgd.addColorStop(0, rgbaL(VIOLET, 0.45, 0.42));
  cgd.addColorStop(0.4, rgba(VIOLET, 0.16));
  cgd.addColorStop(1, rgba(PAL.cyan, 0));
  c.fillStyle = cgd;
  c.beginPath();
  c.moveTo(HX + px * cw0, HY + py * cw0);
  c.lineTo(HX + bx * cfar, HY + by * cfar);
  c.lineTo(HX - px * cw0, HY - py * cw0);
  c.closePath();
  c.fill();
  c.restore();

  // 2. bright filaments inside the cone
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round';
  var fil = [
    [0.30, 1.9, 0.62], [-0.44, 1.6, 0.48], [0.06, 2.8, 0.80], [-0.12, 1.2, 0.40],
    [0.58, 1.1, 0.30], [-0.70, 1.0, 0.24], [0.44, 0.9, 0.30], [-0.26, 1.4, 0.44]
  ];
  for (var i = 0; i < fil.length; i++) {
    var off = fil[i][0] * HR * 0.72, wdt = fil[i][1] * 4.4, al = fil[i][2];
    var len = rr(820, 1560);
    var sx = HX + px * off, sy = HY + py * off;
    var fg = c.createLinearGradient(sx, sy, sx + bx * len, sy + by * len);
    fg.addColorStop(0, 'rgba(232,246,255,' + (al * 0.95).toFixed(3) + ')');
    fg.addColorStop(0.26, rgba(VIOLET, al * 0.52));
    fg.addColorStop(0.62, rgba(PAL.cyan, al * 0.16));
    fg.addColorStop(1, rgba(PAL.cyan, 0));
    c.strokeStyle = fg;
    c.lineWidth = wdt;
    c.filter = 'blur(' + rr(2, 7).toFixed(1) + 'px)';
    c.beginPath();
    c.moveTo(sx + bx * HR * 0.8, sy + by * HR * 0.8);
    c.lineTo(sx + bx * len, sy + by * len);
    c.stroke();
  }
  c.restore();

  // 3. ghosts of the bubble itself, receding. Each is stretched along the
  //    travel axis and squashed across it — what motion blur actually does to
  //    a sphere — so they read as one smeared object, not four more bubbles.
  var gh = [
    { d: 1.55, s: 0.90, a: 0.30, b: 18 },
    { d: 2.95, s: 0.78, a: 0.16, b: 34 },
    { d: 4.55, s: 0.64, a: 0.085, b: 52 },
    { d: 6.40, s: 0.50, a: 0.04, b: 68 }
  ];
  for (var j = 0; j < gh.length; j++) {
    var q = gh[j];
    var gx = HX + bx * HR * q.d, gy = HY + by * HR * q.d;
    c.save();
    c.filter = 'blur(' + q.b + 'px)';
    c.translate(gx, gy);
    c.rotate(TRAV); c.scale(1.55 + j * 0.25, 0.86); c.rotate(-TRAV);
    c.translate(-gx, -gy);
    drawOrb(c, gx, gy, HR * q.s, {
      tint: VIOLET, bloom: 1.3, alpha: q.a, detail: false, rim: false,
      fresnel: false, emit: 0.55
    });
    c.restore();
  }

  // 4. trailing sparks, all sharing the one velocity direction
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round';
  var cols = [PAL.cyan, '#ffffff', VIOLET, PAL.pink];
  for (var k = 0; k < 90; k++) {
    var d = Math.pow(R(), 0.65) * 1750 + HR * 0.9;
    var sp = (R() - 0.5) * 2 * HR * (0.35 + d / 2600);
    var x = HX + bx * d + px * sp, y = HY + by * d + py * sp;
    var ln = rr(26, 150) * (1 - d / 3200);
    var col = pick(cols);
    var sg = c.createLinearGradient(x, y, x + bx * ln, y + by * ln);
    sg.addColorStop(0, rgbaL(col, 0.45, rr(0.30, 0.92) * (1 - d / 2400)));
    sg.addColorStop(1, rgba(col, 0));
    c.strokeStyle = sg;
    c.lineWidth = rr(1.4, 4.0);
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + bx * ln, y + by * ln); c.stroke();
  }
  c.restore();
}

/** The bow wave: one soft compression crescent ahead of the leading edge.
 *  Deliberately blurred — a crisp concentric ring reads as a HUD circle. */
function bowWave(c) {
  var ra = TRAV;
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'butt';
  var rings = [[1.17, 0.34, 16, 11], [1.42, 0.13, 9, 16]];
  for (var i = 0; i < rings.length; i++) {
    var rad = HR * rings[i][0], amp = rings[i][1], lw = rings[i][2];
    c.filter = 'blur(' + rings[i][3] + 'px)';
    var N = 34, span = 0.92;
    for (var s = 0; s < N; s++) {
      var t0 = -span + (2 * span) * (s / N);
      var t1 = -span + (2 * span) * ((s + 1) / N);
      var f = Math.pow(Math.cos((t0 + t1) * 0.5 / span * Math.PI * 0.5), 2.6);
      c.strokeStyle = rgbaL(PAL.cyan, 0.45, amp * f);
      c.lineWidth = lw;
      c.beginPath(); c.arc(HX, HY, rad, ra + t0, ra + t1); c.stroke();
    }
  }
  c.restore();
}

/** The tetromino suspended in the hero bubble: a T, one colour per cell. */
function heroPiece(c, r, alpha) {
  c.save();
  c.rotate(-0.16);
  drawPiece(c, r * 0.03, r * 0.045, r * 0.445, 'T', HERO_COLS,
    { glow: 1.0, alpha: alpha === undefined ? 1 : alpha });
  c.restore();
}

/** Loose pieces tumbling through the field, all on the same heading. */
function strays(c, layer) {
  var A = [PAL.cyan, PAL.pink, PAL.yellow, PAL.green];
  var B = [PAL.pink, PAL.yellow, PAL.cyan, PAL.green];
  var Cc = [PAL.green, PAL.cyan, PAL.pink, PAL.yellow];
  var items = layer === 'back' ? [
    { x: 424,  y: 636, cell: 66, k: 'L', cols: A,  rot: 0.42, spin: 0.5,  v: 250, a: 1.0, g: 0.95 },
    { x: 1898, y: 168, cell: 50, k: 'Z', cols: Cc, rot: 0.80, spin: 0.35, v: 195, a: 0.55, g: 0.55 }
  ] : [
    { x: 1668, y: 1112, cell: 70, k: 'J', cols: B, rot: 0.28, spin: -0.5, v: 275, a: 0.95, g: 0.8 }
  ];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    drawPieceMoving(c, it.x, it.y, it.cell, it.k, it.cols, DX * it.v, DY * it.v,
      { rot: it.rot, spin: it.spin, glow: it.g, alpha: it.a });
  }
}

/** Out-of-focus foreground — the depth cue that turns a diagram into a photo.
 *  Kept to soft blobs of pure colour: at 10 px+ of blur a tetromino silhouette
 *  is gone anyway, so these are drawn as honest bokeh rather than smeared
 *  blocks pretending to be in focus. */
function foreground(c) {
  function bokeh(x, y, r, hex, a) {
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.filter = 'blur(' + (r * 0.30).toFixed(1) + 'px)';
    var g = c.createRadialGradient(x, y, r * 0.2, x, y, r);
    g.addColorStop(0, rgba(hex, a));
    g.addColorStop(0.72, rgba(hex, a * 0.55));
    g.addColorStop(1, rgba(hex, 0));
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
    c.restore();
  }
  bokeh(178, 148, 116, PAL.cyan, 0.20);
  bokeh(2298, 92, 138, PAL.yellow, 0.17);
  bokeh(902, 1216, 150, VIOLET, 0.16);
  bokeh(1962, 1178, 104, PAL.pink, 0.15);
}

/** One far, small bubble to balance the upper left and say "there are more of
 *  these coming" — clearly subordinate: a third the hero's size, dim, soft. */
function farBubble(c) {
  c.save();
  c.filter = 'blur(4px)';
  drawOrb(c, 292, 296, 106, {
    tint: PAL.cyan, rimColor: VIOLET, bloom: 1.7, alpha: 0.74, emit: 0.7,
    contents: function (cc, r) {
      drawPiece(cc, 0, r * 0.04, r * 0.42, 'S',
        [PAL.green, PAL.cyan, PAL.pink, PAL.yellow], { rot: 0.24, glow: 0.9 });
    }
  });
  c.restore();
}

// ---------------------------------------------------------------------------
function titleLockup(c) {
  var left = 128;
  var base = 1058;
  var size = 248;

  // Scrim. A big radial pool here would swallow the whole left half and turn
  // anything drawn there to mud, so it is built as a vertical gradient that
  // only bites below the title's cap line, faded out horizontally in strips.
  var pk = c.createLinearGradient(0, 700, 0, H);
  pk.addColorStop(0, 'rgba(4,4,11,0)');
  pk.addColorStop(0.45, 'rgba(4,4,11,0.55)');
  pk.addColorStop(1, 'rgba(4,4,11,0.92)');
  c.save();
  var SN = 72, SW = 1460;
  for (var s = 0; s < SN; s++) {
    var t = s / (SN - 1);
    c.globalAlpha = Math.pow(1 - t, 1.35);
    c.fillStyle = pk;
    c.fillRect((SW / SN) * s, 700, SW / SN + 1, H - 700);
  }
  c.restore();

  c.save();
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.font = '900 ' + size + 'px "Lato Black", "Lato", "Noto Sans", sans-serif';
  c.letterSpacing = '15px';
  var word = 'TRIBBLE';
  var wdt = c.measureText(word).width;

  // violet drop-shadow bloom, like the CSS wordmark drop-shadow()
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.filter = 'blur(36px)';
  c.fillStyle = rgba(PRIMARY, 0.62);
  c.fillText(word, left, base);
  c.filter = 'none';
  c.restore();

  // extrusion: a short stack of dark copies down-right gives the caps weight
  for (var e = 14; e >= 1; e--) {
    c.fillStyle = 'rgba(26,10,58,' + (0.30 + 0.05 * (14 - e)).toFixed(3) + ')';
    c.fillText(word, left + e * 0.7, base + e * 0.9);
  }
  c.fillStyle = 'rgba(3,3,8,0.94)';
  c.fillText(word, left + 3, base + 5);

  // dark outline for thumbnail contrast
  c.lineJoin = 'round';
  c.lineWidth = 15;
  c.strokeStyle = 'rgba(6,6,14,0.96)';
  c.strokeText(word, left, base);

  // the game's own wordmark gradient: 115deg, --primary-light -> --accent -> --error
  var a = 115 * Math.PI / 180;
  var gx = Math.sin(a), gy = -Math.cos(a);          // CSS angle -> screen vector
  var half = (Math.abs(wdt * gx) + Math.abs(size * gy)) / 2;
  var mx = left + wdt / 2, my = base - size * 0.34;
  var tg = c.createLinearGradient(mx - gx * half, my - gy * half, mx + gx * half, my + gy * half);
  // A straight cyan -> pink ramp interpolates through a desaturated lavender
  // grey in sRGB, and that grey lands exactly on the middle letters. Routing
  // the back half through the brand violet keeps every cap saturated.
  tg.addColorStop(0, '#cba4ff');
  tg.addColorStop(0.22, '#7ea9ff');
  tg.addColorStop(0.44, '#35cdf3');
  tg.addColorStop(0.63, '#a98cff');
  tg.addColorStop(0.82, '#ff7bab');
  tg.addColorStop(1, '#ff5c8a');
  c.fillStyle = tg;
  c.fillText(word, left, base);

  // bottom shade inside the glyphs — gives the caps a rounded face
  var bs = c.createLinearGradient(0, base - size * 0.34, 0, base + 4);
  bs.addColorStop(0, 'rgba(26,10,60,0)');
  bs.addColorStop(1, 'rgba(22,5,54,0.32)');
  c.fillStyle = bs;
  c.fillText(word, left, base);

  // top-edge sheen on the caps
  var sg = c.createLinearGradient(0, base - size * 0.74, 0, base - size * 0.48);
  sg.addColorStop(0, 'rgba(255,255,255,0.52)');
  sg.addColorStop(0.6, 'rgba(255,255,255,0.07)');
  sg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = sg;
  c.fillText(word, left, base);

  // rule + tagline
  c.letterSpacing = '0px';
  var rg = c.createLinearGradient(left, 0, left + 460, 0);
  rg.addColorStop(0, rgba(VIOLET, 0.95));
  rg.addColorStop(0.5, rgba(PAL.cyan, 0.8));
  rg.addColorStop(1, rgba(PAL.pink, 0));
  c.fillStyle = rg;
  c.fillRect(left + 6, base + 50, 460, 6);

  c.font = '700 53px "Lato", "Noto Sans", sans-serif';
  c.letterSpacing = '10px';
  c.fillStyle = 'rgba(247,246,254,0.98)';
  c.shadowColor = 'rgba(0,0,0,0.92)';
  c.shadowBlur = 20;
  c.fillText('TETRIS MEETS BUBBLE SHOOTER', left + 6, base + 136);
  c.shadowBlur = 0;
  c.letterSpacing = '0px';
  c.restore();
}

function vignette(c) {
  var v = c.createRadialGradient(W * 0.58, H * 0.42, H * 0.30, W * 0.58, H * 0.5, H * 1.06);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(0.60, 'rgba(0,0,0,0.32)');
  v.addColorStop(1, 'rgba(0,0,0,0.86)');
  c.fillStyle = v;
  c.fillRect(0, 0, W, H);

  var fl = c.createLinearGradient(0, H - 320, 0, H);
  fl.addColorStop(0, 'rgba(4,4,10,0)');
  fl.addColorStop(1, 'rgba(4,4,10,0.58)');
  c.fillStyle = fl;
  c.fillRect(0, H - 320, W, 320);
}

function grain(c) {
  // fine grain (offscreen tile: putImageData ignores compositing)
  var g = mulberry(7);
  var N = 400;
  var nc = document.createElement('canvas');
  nc.width = N; nc.height = N;
  var ncx = nc.getContext('2d');
  var img = ncx.createImageData(N, N);
  var d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    var n = 110 + ((g() * 90) | 0);
    d[i] = d[i + 1] = d[i + 2] = n;
    d[i + 3] = 255;
  }
  ncx.putImageData(img, 0, 0);
  c.save();
  c.globalAlpha = 0.085;
  c.globalCompositeOperation = 'overlay';
  for (var gy = 0; gy < H; gy += N) for (var gx = 0; gx < W; gx += N) c.drawImage(nc, gx, gy);
  c.restore();
}

/** Bright-pass blur, screened back on — the bloom that glues the light together. */
function bloomPass(cv, c, amount) {
  var t = document.createElement('canvas');
  t.width = W; t.height = H;
  var tc = t.getContext('2d');
  tc.filter = 'blur(30px) brightness(1.05) contrast(3.0) saturate(1.35)';
  tc.drawImage(cv, 0, 0);
  c.save();
  c.globalCompositeOperation = 'screen';
  c.globalAlpha = amount;
  c.drawImage(t, 0, 0);
  c.restore();
}

/** Final colour grade: a little more punch, applied to the whole frame. */
function punch(cv, c) {
  var t = document.createElement('canvas');
  t.width = W; t.height = H;
  t.getContext('2d').drawImage(cv, 0, 0);
  c.clearRect(0, 0, W, H);
  c.save();
  c.filter = 'saturate(1.18) contrast(1.09)';
  c.drawImage(t, 0, 0);
  c.restore();
}

function render() {
  var cv = document.getElementById('big');
  var c = cv.getContext('2d');
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';

  // layer 1 — ground and atmosphere
  background(c);

  // layer 2 — silhouetted midground
  bubbleWall(c);
  farBubble(c);
  strays(c, 'back');

  // layer 3 — the hero and its motion
  wake(c);
  bowWave(c);
  drawOrb(c, HX, HY, HR, {
    tint: VIOLET, rimColor: PAL.pink, bloom: 2.45, emit: 0.55, contents: heroPiece
  });

  // layer 4 — near field
  strays(c, 'front');
  foreground(c);

  bloomPass(cv, c, 0.20);
  punch(cv, c);

  vignette(c);
  titleLockup(c);
  grain(c);

  // in-page downscale, used when ImageMagick is not on the machine
  var sm = document.getElementById('small');
  var sc = sm.getContext('2d');
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = 'high';
  var step = document.createElement('canvas');
  step.width = W / 2 | 0; step.height = H / 2 | 0;
  var stc = step.getContext('2d');
  stc.imageSmoothingEnabled = true;
  stc.imageSmoothingQuality = 'high';
  stc.drawImage(cv, 0, 0, step.width, step.height);
  sc.drawImage(step, 0, 0, ${OUT_W}, ${OUT_H});

  window.__coverReady = true;
}
render();
</script>`

// ---------------------------------------------------------------------------

async function have(p) {
  try { await access(p); return true } catch { return false }
}

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'tribble-cover-'))
  await writeFile(path.join(work, 'index.html'), PAGE, 'utf8')

  const server = createServer(async (req, res) => {
    try {
      const body = await readFile(path.join(work, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'],
  })
  const page = await browser.newPage({
    viewport: { width: BIG_W, height: BIG_H + OUT_H },
    deviceScaleFactor: 1,
  })
  page.on('pageerror', (e) => console.error('page error:', e.message))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForFunction('window.__coverReady === true', null, { timeout: 30000 })

  const bigPath = path.join(work, 'big.png')
  const smallPath = path.join(work, 'small.png')
  await page.locator('#big').screenshot({ path: bigPath })
  await page.locator('#small').screenshot({ path: smallPath })

  await browser.close()
  server.close()

  const useMagick = await have(MAGICK)
  if (!useMagick) console.warn(`${MAGICK} not found — using the in-page canvas downscale`)

  const targets = [
    path.join(ROOT, 'docs', 'social-card.png'),
    path.join(ROOT, 'public', 'social-card.png'),
  ]
  for (const t of targets) {
    await mkdir(path.dirname(t), { recursive: true })
    if (useMagick) {
      await execFileAsync(MAGICK, [
        bigPath, '-colorspace', 'RGB',
        '-filter', 'Lanczos', '-resize', `${OUT_W}x${OUT_H}!`,
        '-colorspace', 'sRGB', '-strip', '-define', 'png:compression-level=9', t,
      ])
    } else {
      await writeFile(t, await readFile(smallPath))
    }
    console.log('wrote', t)
  }

  if (debugDir) {
    await mkdir(debugDir, { recursive: true })
    await writeFile(path.join(debugDir, 'cover-2400.png'), await readFile(bigPath))
    console.log('wrote', path.join(debugDir, 'cover-2400.png'))
  }

  await rm(work, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
