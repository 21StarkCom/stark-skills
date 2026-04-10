#!/usr/bin/env python3
"""Generate persona showcase HTML pages from roster.md.

Reads the roster markdown, assigns categories based on source/slug patterns,
and generates three standalone HTML pages: constellation map, periodic table,
and card deck.

Usage:
    python3 scripts/generate_persona_pages.py [--output-dir DIR] [--upload]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from string import Template

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from stark_persona import PersonaRecord, load_roster, ROSTER_PATH

# ---------------------------------------------------------------------------
# Category assignment
# ---------------------------------------------------------------------------

CATEGORIES = [
    {"id": "tarantino",  "label": "Tarantino",        "color": "#dc2626", "glow": "rgba(220,38,38,0.12)"},
    {"id": "drama",      "label": "Drama",             "color": "#f472b6", "glow": "rgba(244,114,182,0.12)"},
    {"id": "comedy",     "label": "Comedy",            "color": "#fbbf24", "glow": "rgba(251,191,36,0.12)"},
    {"id": "sci-fi",     "label": "Sci-Fi / Fantasy",  "color": "#60a5fa", "glow": "rgba(96,165,250,0.12)"},
    {"id": "action",     "label": "Action",            "color": "#ef4444", "glow": "rgba(239,68,68,0.12)"},
    {"id": "icons",      "label": "Icons",             "color": "#22c55e", "glow": "rgba(34,197,94,0.12)"},
    {"id": "wildcards",  "label": "Wildcards",         "color": "#a855f7", "glow": "rgba(168,85,247,0.12)"},
    {"id": "standup-us", "label": "Standup US",        "color": "#fb923c", "glow": "rgba(251,146,60,0.12)"},
    {"id": "standup-uk", "label": "Standup UK",        "color": "#38bdf8", "glow": "rgba(56,189,248,0.12)"},
    {"id": "standup-il", "label": "Standup IL",        "color": "#a78bfa", "glow": "rgba(167,139,250,0.12)"},
    {"id": "israeli",    "label": "Israeli",           "color": "#c084fc", "glow": "rgba(192,132,252,0.12)"},
    {"id": "detective",  "label": "Detective",         "color": "#2dd4bf", "glow": "rgba(45,212,191,0.12)"},
    {"id": "games",      "label": "Games",             "color": "#4ade80", "glow": "rgba(74,222,128,0.12)"},
    {"id": "animated",   "label": "Animated",          "color": "#f97316", "glow": "rgba(249,115,22,0.12)"},
]

_SLUG_TO_CAT = {
    "jules-winnfield": "tarantino", "hans-landa": "tarantino", "the-bride": "tarantino",
    "mr-pink": "tarantino", "django": "tarantino", "mia-wallace": "tarantino",
    "mr-wolf": "tarantino", "bill": "tarantino",
    "walter-white": "drama", "tyrion-lannister": "drama", "saul-goodman": "drama",
    "daenerys-targaryen": "drama",
    "the-dude": "comedy", "ron-swanson": "comedy", "captain-holt": "comedy",
    "fleabag": "comedy", "dwight-schrute": "comedy", "wednesday-addams": "comedy",
    "adam-sandler": "comedy", "george-costanza": "comedy", "cosmo-kramer": "comedy",
    "chandler-bing": "comedy", "dr-perry-cox": "comedy", "jack-donaghy": "comedy",
    "gob-bluth": "comedy", "ferris-bueller": "comedy", "les-grossman": "comedy",
    "lucille-bluth": "comedy", "frank-reynolds": "comedy", "charlie-kelly": "comedy",
    "dennis-reynolds": "comedy", "tobias-funke": "comedy",
    "jean-ralphio-saperstein": "comedy", "jenna-maroney": "comedy",
    "tracy-jordan": "comedy", "al-bundy": "comedy", "kenny-powers": "comedy",
    "leon-black": "comedy", "ari-gold": "comedy", "rafi": "comedy",
    "susie-greene": "comedy", "selina-meyer": "comedy", "jeff-winger": "comedy",
    "april-ludgate": "comedy", "red-forman": "comedy", "sue-sylvester": "comedy",
    "dorothy-zbornak": "comedy", "barney-stinson": "comedy",
    "gandalf": "sci-fi", "morpheus": "sci-fi", "princess-leia": "sci-fi",
    "deadpool": "action", "inigo-montoya": "action", "john-rambo": "action",
    "jackie-chan": "action", "bruce-willis": "action", "axel-foley": "action",
    "danny-ocean": "action",
    "arnold-schwarzenegger": "action", "eddie-murphy": "action",
    "sherlock-holmes": "detective", "the-joker": "detective",
    "neal-caffrey": "detective",
    "glados": "games", "sterling-archer": "animated", "bender-rodriguez": "animated",
    "roger-smith": "animated", "daria-morgendorffer": "animated",
    "eric-cartman": "animated", "shoshana": "animated",
    "guri-alfi": "israeli", "lior-raz": "israeli",
    "mike-ehrmantraut": "drama", "gus-fring": "drama", "gregory-house": "drama",
    "roger-sterling": "drama", "dexter-morgan": "drama", "patrick-bateman": "drama",
    "lorne-malvo": "drama", "anton-chigurh": "drama",
}

_SOURCE_PATTERNS = {
    "American stand-up": "standup-us", "American comedian": "standup-us",
    "British stand-up": "standup-uk", "British comedian": "standup-uk",
    "Israeli stand-up": "standup-il", "Israeli comedian": "standup-il",
}


def assign_category(p: PersonaRecord) -> str:
    if p.category and any(cat["id"] == p.category for cat in CATEGORIES):
        return p.category
    if p.slug in _SLUG_TO_CAT:
        return _SLUG_TO_CAT[p.slug]
    for pattern, cat in _SOURCE_PATTERNS.items():
        if pattern.lower() in p.source.lower():
            return cat
    return "drama"


def get_cat(cat_id: str) -> dict:
    return next((c for c in CATEGORIES if c["id"] == cat_id), CATEGORIES[0])


def roster_to_data(roster: list[PersonaRecord]) -> list[dict]:
    result = []
    for p in roster:
        cat_id = assign_category(p)
        cat = get_cat(cat_id)
        result.append({
            "name": p.name, "slug": p.slug, "source": p.source, "type": p.type,
            "traits": p.traits, "catchphrase": p.catchphrase or "",
            "style": p.speaking_style,
            "domain": p.domain or "",
            "archetype": p.archetype or "",
            "signature_quotes": p.signature_quotes,
            "voice_profile": p.voice_profile,
            "cat_id": cat_id, "cat_label": cat["label"],
            "cat_color": cat["color"], "cat_glow": cat["glow"],
        })
    return result


def make_symbol(name: str) -> str:
    parts = name.split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0]).capitalize()
    return name[:2].capitalize()


# ---------------------------------------------------------------------------
# Build JS data blob (shared across all pages)
# ---------------------------------------------------------------------------

def build_constellations_json(data: list[dict]) -> str:
    """Build grouped constellation data as JSON."""
    groups = {}
    for d in data:
        groups.setdefault(d["cat_id"], []).append(d)

    constellations = []
    for cat in CATEGORIES:
        if cat["id"] not in groups:
            continue
        stars = []
        for d in groups[cat["id"]]:
            stars.append({
                "name": d["name"], "source": d["source"], "type": d["type"],
                "traits": d["traits"], "catchphrase": d["catchphrase"],
                "style": d["style"], "quotes": d["signature_quotes"],
            })
        constellations.append({
            "name": cat["label"], "color": cat["color"], "stars": stars,
        })
    return json.dumps(constellations)


def build_personas_json(data: list[dict]) -> str:
    """Build flat persona array as JSON."""
    out = []
    for i, d in enumerate(data):
        out.append({
            "num": i + 1, "sym": make_symbol(d["name"]),
            "name": d["name"], "source": d["source"], "type": d["type"],
            "cat": d["cat_id"], "catLabel": d["cat_label"],
            "color": d["cat_color"], "glow": d["cat_glow"],
            "traits": d["traits"], "catch": d["catchphrase"],
            "style": d["style"], "quotes": d["signature_quotes"],
        })
    return json.dumps(out)


def build_cats_json(data: list[dict]) -> str:
    """Build category list as JSON (only used categories, in order)."""
    seen = set()
    out = []
    for d in data:
        if d["cat_id"] not in seen:
            seen.add(d["cat_id"])
            cat = get_cat(d["cat_id"])
            out.append({"id": cat["id"], "label": cat["label"], "color": cat["color"]})
    return json.dumps(out)


# ---------------------------------------------------------------------------
# HTML templates — JS uses normal braces, Python uses $variable substitution
# ---------------------------------------------------------------------------

CONSTELLATION_HTML = Template(r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Persona Constellation Map</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#08080d;font-family:'Inter',sans-serif;color:#e2e8f0}
canvas{display:block;cursor:grab}
canvas:active{cursor:grabbing}
#title{position:fixed;top:28px;left:32px;z-index:10;pointer-events:none}
#title h1{font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:500;letter-spacing:0.08em;color:#e2e8f0;text-shadow:0 0 20px rgba(96,165,250,0.3)}
#title .subtitle{font-size:12px;font-weight:300;color:#64748b;letter-spacing:0.15em;margin-top:4px;text-transform:uppercase}
#hint{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;font-size:12px;color:#475569;letter-spacing:0.06em;pointer-events:none;font-family:'JetBrains Mono',monospace}
#tooltip{position:fixed;z-index:100;pointer-events:none;background:rgba(15,15,25,0.95);border:1px solid rgba(100,116,139,0.25);border-radius:12px;padding:16px 20px;max-width:340px;backdrop-filter:blur(16px);box-shadow:0 20px 60px rgba(0,0,0,0.6);display:none}
#tooltip.pinned{pointer-events:auto}
#tooltip .tt-name{font-size:16px;font-weight:600;margin-bottom:2px}
#tooltip .tt-source{font-size:12px;color:#94a3b8;margin-bottom:8px}
#tooltip .tt-badge{display:inline-block;font-size:10px;font-weight:500;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px}
#tooltip .tt-badge.character{background:rgba(96,165,250,0.15);color:#60a5fa}
#tooltip .tt-badge.person{background:rgba(251,191,36,0.15);color:#fbbf24}
#tooltip .tt-catchphrase{font-family:'JetBrains Mono',monospace;font-size:12px;color:#94a3b8;font-style:italic;margin-bottom:10px;line-height:1.5;border-left:2px solid;padding-left:10px}
#tooltip .tt-style{font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:10px}
#tooltip .tt-qlabel{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;margin:10px 0 6px}
#tooltip .tt-quotes{display:grid;gap:6px;margin-bottom:10px;max-height:180px;overflow:auto;padding-right:4px}
#tooltip .tt-quote{font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.45;color:#dbeafe;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:8px;padding:7px 9px}
#tooltip .tt-traits{display:flex;flex-wrap:wrap;gap:4px}
#tooltip .tt-trait{font-size:10px;padding:2px 7px;border-radius:6px;background:rgba(100,116,139,0.15);color:#94a3b8}
</style>
</head>
<body>
<div id="title"><h1>persona</h1><div class="subtitle">$count voices &middot; constellation map</div></div>
<div id="hint">scroll to zoom &middot; drag to pan &middot; hover a star to explore</div>
<div id="tooltip"></div>
<canvas id="sky"></canvas>
<script>
const DATA = $constellations_json;
function e(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const canvas = document.getElementById('sky');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
let scale = 1, panX = 0, panY = 0;
let dragging = false, dragX, dragY, psx, psy;
let pinned = null, t = 0;

// Background stars
const bgStars = [];
for (let i = 0; i < 250; i++) bgStars.push({
  x: Math.random(), y: Math.random(),
  r: Math.random() * 1.3 + 0.3,
  speed: Math.random() * 0.003 + 0.001,
  phase: Math.random() * Math.PI * 2
});

// Position constellations
function layout() {
  const W = innerWidth, H = innerHeight;
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) * 0.3;
  const n = DATA.length;

  DATA.forEach((c, ci) => {
    const angle = -Math.PI / 2 + ci * (2 * Math.PI / n);
    const dist = radius + c.stars.length * 6;
    c.cx = cx + Math.cos(angle) * dist;
    c.cy = cy + Math.sin(angle) * dist;

    const sn = c.stars.length;
    c.stars.forEach((s, si) => {
      const sa = angle + (si - (sn - 1) / 2) * 0.14;
      const sd = 45 + si * 16;
      s.x = c.cx + Math.cos(sa) * sd;
      s.y = c.cy + Math.sin(sa) * sd;
      s.r = 4.5;
      if (!s.phase) s.phase = Math.random() * Math.PI * 2;
    });
  });
}
layout();

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layout();
}
resize();
window.addEventListener('resize', resize);

function draw() {
  t += 0.016;
  const W = innerWidth, H = innerHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(scale, scale);

  // Background twinkle
  bgStars.forEach(s => {
    const a = 0.25 + 0.25 * Math.sin(t * s.speed * 60 + s.phase);
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(148,163,184,' + a + ')';
    ctx.fill();
  });

  // Constellations
  DATA.forEach(c => {
    // Lines
    if (c.stars.length > 1) {
      ctx.beginPath();
      ctx.moveTo(c.stars[0].x, c.stars[0].y);
      for (let i = 1; i < c.stars.length; i++) ctx.lineTo(c.stars[i].x, c.stars[i].y);
      ctx.strokeStyle = c.color;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Label
    ctx.font = '500 10px "JetBrains Mono"';
    ctx.fillStyle = c.color;
    ctx.globalAlpha = 0.5;
    ctx.textAlign = 'center';
    ctx.fillText(c.name.toUpperCase(), c.cx, c.cy - 55);
    ctx.globalAlpha = 1;

    // Stars
    c.stars.forEach(s => {
      const glow = 4 + 2 * Math.sin(t * 2 + s.phase);
      const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r + glow);
      grad.addColorStop(0, 'rgba(255,255,255,0.9)');
      grad.addColorStop(0.3, c.color);
      grad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r + glow, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    });
  });
  ctx.restore();
  requestAnimationFrame(draw);
}
draw();

// Interaction
function toWorld(sx, sy) { return [(sx - panX) / scale, (sy - panY) / scale]; }
function findStar(mx, my) {
  const [wx, wy] = toWorld(mx, my);
  for (const c of DATA)
    for (const s of c.stars)
      if (Math.hypot(wx - s.x, wy - s.y) < 14) return { star: s, cat: c };
  return null;
}

function showTooltip(star, cat, x, y) {
  const traits = star.traits.map(t => '<span class="tt-trait">' + e(t) + '</span>').join('');
  const quotes = (star.quotes || [])
    .map(q => '<div class="tt-quote">"' + e(q) + '"</div>').join('');
  tooltip.innerHTML =
    '<div class="tt-name" style="color:' + cat.color + '">' + e(star.name) + '</div>' +
    '<div class="tt-source">' + e(star.source) + '</div>' +
    '<span class="tt-badge ' + star.type + '">' + e(star.type) + '</span>' +
    (star.catchphrase ? '<div class="tt-catchphrase" style="border-color:' + cat.color + '">"' + e(star.catchphrase) + '"</div>' : '') +
    '<div class="tt-style">' + e(star.style) + '</div>' +
    (quotes ? '<div class="tt-qlabel">Quote wall</div><div class="tt-quotes">' + quotes + '</div>' : '') +
    '<div class="tt-traits">' + traits + '</div>';
  tooltip.style.display = 'block';
  tooltip.style.left = Math.min(x + 15, innerWidth - 360) + 'px';
  tooltip.style.top = Math.min(y + 15, innerHeight - 300) + 'px';
}

canvas.addEventListener('mousemove', e => {
  if (dragging) { panX = psx + e.clientX - dragX; panY = psy + e.clientY - dragY; return; }
  if (pinned) return;
  const hit = findStar(e.clientX, e.clientY);
  if (hit) { showTooltip(hit.star, hit.cat, e.clientX, e.clientY); canvas.style.cursor = 'pointer'; }
  else { tooltip.style.display = 'none'; canvas.style.cursor = 'grab'; }
});
canvas.addEventListener('mousedown', e => {
  const hit = findStar(e.clientX, e.clientY);
  if (hit) { pinned = pinned === hit.star ? null : hit.star; tooltip.classList.toggle('pinned', !!pinned); if (pinned) showTooltip(hit.star, hit.cat, e.clientX, e.clientY); else tooltip.style.display = 'none'; return; }
  pinned = null; tooltip.classList.remove('pinned'); tooltip.style.display = 'none';
  dragging = true; dragX = e.clientX; dragY = e.clientY; psx = panX; psy = panY;
});
canvas.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const f = e.deltaY > 0 ? 0.92 : 1.08;
  const ns = Math.min(4, Math.max(0.15, scale * f));
  panX = e.clientX - (e.clientX - panX) * (ns / scale);
  panY = e.clientY - (e.clientY - panY) * (ns / scale);
  scale = ns;
}, { passive: false });
</script>
</body>
</html>''')


PERIODIC_HTML = Template(r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Persona Periodic Table</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#08080d;color:#e2e8f0;min-height:100vh;padding:2rem}
.header{text-align:center;margin-bottom:2rem}
.header h1{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#7c6ff7,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .sub{font-size:0.85rem;color:#64748b;margin-top:0.3rem}
.legend{display:flex;flex-wrap:wrap;justify-content:center;gap:0.8rem;margin-bottom:2rem}
.legend-item{display:flex;align-items:center;gap:0.3rem;font-size:0.7rem;color:#94a3b8}
.legend-dot{width:8px;height:8px;border-radius:50%}
.grid{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:1200px;margin:0 auto}
.cell{width:110px;height:120px;border:1.5px solid;border-radius:8px;padding:8px;cursor:pointer;transition:all 0.2s;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cell:hover{transform:scale(1.08);z-index:10}
.cell .num{position:absolute;top:5px;left:7px;font-family:'JetBrains Mono',monospace;font-size:0.55rem;opacity:0.5}
.cell .sym{font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:700}
.cell .cname{font-size:0.6rem;text-align:center;margin-top:2px;opacity:0.7;line-height:1.2;max-height:2.4em;overflow:hidden}
.cell .csource{font-size:0.5rem;opacity:0.4;margin-top:2px;text-align:center}
.cell .ctype{position:absolute;top:5px;right:7px;font-family:'JetBrains Mono',monospace;font-size:0.45rem;text-transform:uppercase;padding:1px 4px;border-radius:3px}
.overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center}
.overlay.active{display:flex}
.detail{background:#13131d;border:1px solid #2a2a3a;border-radius:14px;padding:2rem;max-width:420px;width:90%;position:relative}
.detail .close{position:absolute;top:1rem;right:1rem;background:none;border:none;color:#94a3b8;font-size:1.2rem;cursor:pointer}
.detail .d-sym{font-family:'JetBrains Mono',monospace;font-size:2.5rem;font-weight:700;margin-bottom:0.3rem}
.detail .d-name{font-size:1.2rem;font-weight:700;margin-bottom:0.2rem}
.detail .d-source{font-size:0.8rem;color:#94a3b8;margin-bottom:1rem}
.detail .d-catch{font-family:'JetBrains Mono',monospace;font-size:0.8rem;padding:0.5rem 0.8rem;border-left:3px solid;border-radius:0 6px 6px 0;background:rgba(255,255,255,0.03);margin-bottom:1rem;line-height:1.5}
.detail .d-style{font-size:0.8rem;color:#cbd5e1;line-height:1.6;margin-bottom:1rem}
.detail .d-qlabel{font-family:'JetBrains Mono',monospace;font-size:0.62rem;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;margin:0 0 0.45rem}
.detail .d-quotes{display:grid;gap:0.5rem;margin-bottom:1rem;max-height:190px;overflow:auto;padding-right:0.2rem}
.detail .d-quote{font-family:'JetBrains Mono',monospace;font-size:0.7rem;line-height:1.5;padding:0.55rem 0.7rem;border-radius:10px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.035);color:#dbeafe}
.detail .d-traits{display:flex;flex-wrap:wrap;gap:4px}
.detail .d-trait{font-size:0.65rem;padding:3px 8px;border-radius:100px;background:rgba(255,255,255,0.06);color:#94a3b8}
</style>
</head>
<body>
<div class="header"><h1>persona</h1><div class="sub">periodic table of voices &mdash; $count elements</div></div>
<div class="legend" id="legend"></div>
<div class="grid" id="grid"></div>
<div class="overlay" id="overlay" onclick="if(event.target===this)this.classList.remove('active')"><div class="detail" id="detail"></div></div>
<script>
const CATS = $cats_json;
const P = $personas_json;
function e(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.getElementById('legend').innerHTML = CATS.map(c =>
  '<div class="legend-item"><div class="legend-dot" style="background:'+c.color+'"></div>'+e(c.label)+'</div>'
).join('');

const grid = document.getElementById('grid');
P.forEach(p => {
  const el = document.createElement('div');
  el.className = 'cell';
  el.style.borderColor = p.color;
  el.style.background = p.glow;
  const typeBg = p.type==='character' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.15)';
  const typeCol = p.type==='character' ? '#60a5fa' : '#34d399';
  el.innerHTML = '<span class="num">'+p.num+'</span><span class="ctype" style="background:'+typeBg+';color:'+typeCol+'">'+e(p.type)+'</span><div class="sym" style="color:'+p.color+'">'+e(p.sym)+'</div><div class="cname">'+e(p.name)+'</div><div class="csource">'+e(p.source)+'</div>';
  el.onmouseenter = () => { el.style.boxShadow = '0 0 20px '+p.glow; };
  el.onmouseleave = () => { el.style.boxShadow = 'none'; };
  el.onclick = () => {
    const traits = p.traits.map(t => '<span class="d-trait">'+e(t)+'</span>').join('');
    const quotes = (p.quotes || []).map(q => '<div class="d-quote">"'+e(q)+'"</div>').join('');
    document.getElementById('detail').innerHTML = '<button class="close" onclick="document.getElementById(\'overlay\').classList.remove(\'active\')">&times;</button><div class="d-sym" style="color:'+p.color+'">'+e(p.sym)+'</div><div class="d-name">'+e(p.name)+'</div><div class="d-source">'+e(p.source)+'</div>'+(p.catch?'<div class="d-catch" style="border-color:'+p.color+';color:'+p.color+'">"'+e(p.catch)+'"</div>':'')+'<div class="d-style">'+e(p.style)+'</div>'+(quotes?'<div class="d-qlabel">Quote showcase</div><div class="d-quotes">'+quotes+'</div>':'')+'<div class="d-traits">'+traits+'</div>';
    document.getElementById('overlay').classList.add('active');
  };
  grid.appendChild(el);
});
document.addEventListener('keydown', e => { if (e.key==='Escape') document.getElementById('overlay').classList.remove('active'); });
</script>
</body>
</html>''')


DECK_HTML = Template(r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Persona Card Deck</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',sans-serif;background:#08080d;color:#e2e8f0;min-height:100vh}
.header{text-align:center;padding:2rem 1rem 1rem}
.header h1{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#7c6ff7,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .sub{font-size:0.85rem;color:#64748b;margin-top:0.3rem}
.filters{display:flex;flex-wrap:wrap;justify-content:center;gap:0.4rem;padding:1rem 1rem 1.5rem}
.fbtn{font-family:'Inter',sans-serif;font-size:0.72rem;font-weight:500;padding:0.35rem 0.9rem;border-radius:100px;border:1px solid #2a2a3a;background:#13131d;color:#94a3b8;cursor:pointer;transition:all 0.15s}
.fbtn:hover{border-color:#7c6ff7;color:#e2e8f0}
.fbtn.active{background:#7c6ff7;color:#fff;border-color:#7c6ff7}
.grid{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;padding:0 1.5rem 3rem;max-width:1400px;margin:0 auto}
.cw{perspective:800px;width:190px;height:280px}
.card{width:100%;height:100%;position:relative;transform-style:preserve-3d;transition:transform 0.5s;cursor:pointer}
.card.flipped{transform:rotateY(180deg)}
.cf,.cb{position:absolute;width:100%;height:100%;backface-visibility:hidden;border-radius:12px;border:1px solid #2a2a3a;overflow:hidden}
.cf{background:#13131d;display:flex;flex-direction:column}
.cf .accent{height:4px}
.cf .body{flex:1;padding:1rem 0.8rem 0.8rem;display:flex;flex-direction:column}
.cf .cat{font-family:'JetBrains Mono',monospace;font-size:0.5rem;text-transform:uppercase;letter-spacing:0.08em;opacity:0.5;margin-bottom:auto}
.cf .name{font-size:0.95rem;font-weight:700;margin-bottom:0.2rem}
.cf .src{font-size:0.65rem;color:#94a3b8;margin-bottom:0.6rem}
.cf .tbadge{font-family:'JetBrains Mono',monospace;font-size:0.5rem;text-transform:uppercase;padding:2px 6px;border-radius:4px;display:inline-block;margin-bottom:0.5rem;width:fit-content}
.cf .catch{font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:#94a3b8;font-style:italic;line-height:1.5;margin-top:auto;border-top:1px solid #1e1e2e;padding-top:0.5rem}
.cb{background:#1a1a28;transform:rotateY(180deg);padding:1rem 0.8rem;display:flex;flex-direction:column}
.cb .bt{font-size:0.85rem;font-weight:700;margin-bottom:0.5rem}
.cb .bs{font-size:0.68rem;color:#cbd5e1;line-height:1.6;margin-bottom:0.65rem}
.cb .bqhead{font-family:'JetBrains Mono',monospace;font-size:0.52rem;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;margin-bottom:0.4rem}
.cb .bqwrap{display:grid;gap:0.35rem;margin-bottom:0.7rem;max-height:112px;overflow:auto;padding-right:0.2rem;flex:1}
.cb .bq{font-family:'JetBrains Mono',monospace;font-size:0.58rem;line-height:1.45;padding:0.4rem 0.48rem;border-radius:8px;border:1px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.04);color:#dbeafe}
.cb .btr{display:flex;flex-wrap:wrap;gap:3px}
.cb .btr span{font-size:0.55rem;padding:2px 6px;border-radius:100px;background:rgba(255,255,255,0.06);color:#94a3b8}
.cb .bc{font-family:'JetBrains Mono',monospace;font-size:0.6rem;font-style:italic;margin-top:0.6rem;padding-top:0.5rem;border-top:1px solid #2a2a3a;line-height:1.5}
</style>
</head>
<body>
<div class="header"><h1>persona</h1><div class="sub">the deck &mdash; $count voices</div></div>
<div class="filters" id="filters"></div>
<div class="grid" id="grid"></div>
<script>
const CATS = $cats_json;
const P = $personas_json;
function e(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const filters = document.getElementById('filters');
const ab = document.createElement('button'); ab.className='fbtn active'; ab.textContent='All'; ab.dataset.f='all'; filters.appendChild(ab);
CATS.forEach(c => { const b=document.createElement('button'); b.className='fbtn'; b.textContent=c.label; b.dataset.f=c.id; filters.appendChild(b); });
filters.addEventListener('click', e => {
  if (!e.target.classList.contains('fbtn')) return;
  filters.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  render(e.target.dataset.f);
});

const grid = document.getElementById('grid');
function render(filter) {
  grid.innerHTML = '';
  const list = filter==='all' ? P : P.filter(p => p.cat===filter);
  list.forEach(p => {
    const w = document.createElement('div'); w.className = 'cw';
    const tb = p.type==='character' ? 'rgba(96,165,250,0.15)' : 'rgba(52,211,153,0.15)';
    const tc = p.type==='character' ? '#60a5fa' : '#34d399';
    const traits = p.traits.map(t => '<span>'+e(t)+'</span>').join('');
    const quotes = (p.quotes || []).map(q => '<div class="bq">"'+e(q)+'"</div>').join('');
    w.innerHTML = '<div class="card" onclick="this.classList.toggle(\'flipped\')"><div class="cf"><div class="accent" style="background:'+p.color+'"></div><div class="body"><div class="cat" style="color:'+p.color+'">'+e(p.catLabel)+'</div><div class="name">'+e(p.name)+'</div><div class="src">'+e(p.source)+'</div><div class="tbadge" style="background:'+tb+';color:'+tc+'">'+e(p.type)+'</div>'+(p.catch?'<div class="catch" style="color:'+p.color+'">"'+e(p.catch)+'"</div>':'')+'</div></div><div class="cb"><div class="bt" style="color:'+p.color+'">'+e(p.name)+'</div><div class="bs">'+e(p.style)+'</div>'+(quotes?'<div class="bqhead">Quote showcase</div><div class="bqwrap">'+quotes+'</div>':'')+'<div class="btr">'+traits+'</div>'+(p.catch?'<div class="bc" style="color:'+p.color+'">"'+e(p.catch)+'"</div>':'')+'</div></div>';
    w.addEventListener('mousemove', e => {
      const card = w.querySelector('.card'); if (card.classList.contains('flipped')) return;
      const r = w.getBoundingClientRect();
      const x = (e.clientX-r.left)/r.width-0.5, y = (e.clientY-r.top)/r.height-0.5;
      card.style.transform = 'rotateY('+x*15+'deg) rotateX('+(-y*15)+'deg)';
    });
    w.addEventListener('mouseleave', () => {
      const card = w.querySelector('.card'); if (!card.classList.contains('flipped')) card.style.transform = '';
    });
    grid.appendChild(w);
  });
}
render('all');
</script>
</body>
</html>''')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

GCS_BUCKET = "gs://evinced-ai-dd-case-study"


def main():
    parser = argparse.ArgumentParser(description="Generate persona showcase HTML pages")
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parent.parent / "data" / "persona"))
    parser.add_argument("--upload", action="store_true", help="Upload to GCS after generating")
    parser.add_argument("--roster", default=None, help="Path to roster.md (default: auto-detect)")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    roster = load_roster(args.roster)
    count = len(roster)
    data = roster_to_data(roster)

    constellations_json = build_constellations_json(data)
    personas_json = build_personas_json(data)
    cats_json = build_cats_json(data)

    files = {
        "constellation.html": CONSTELLATION_HTML.substitute(
            count=count, constellations_json=constellations_json,
        ),
        "periodic.html": PERIODIC_HTML.substitute(
            count=count, cats_json=cats_json, personas_json=personas_json,
        ),
        "deck.html": DECK_HTML.substitute(
            count=count, cats_json=cats_json, personas_json=personas_json,
        ),
    }

    for name, content in files.items():
        path = output_dir / name
        path.write_text(content)
        print(f"  wrote {path} ({len(content):,} bytes)")

    if args.upload:
        print("\nUploading to GCS...")
        for name in files:
            src = output_dir / name
            dst = f"{GCS_BUCKET}/stark-persona-{name}"
            subprocess.run(
                ["gcloud", "storage", "cp", str(src), dst, "--cache-control=no-cache"],
                check=True,
            )
            print(f"  uploaded {dst}")

    print(f"\nDone. {count} personas across {len({d['cat_id'] for d in data})} categories.")


if __name__ == "__main__":
    main()
