/* Looks at Scout Log photos with Claude and saves what is in them on the entry (species, buck or doe, rack, sign, what it means).
   Runs as a background sweep so Telegram and web uploads are both covered. Videos are read from three frames pulled with ffmpeg. */
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const Scout = require('./scout.js');
const Gemini = require('./gemini.js');
const hasAI = () => !!process.env.ANTHROPIC_API_KEY || Gemini.enabled();
const UP_DIR = path.join(__dirname, 'data', 'uploads');
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
let pausedUntil = 0, busy = false, ffBin = null;

/* ffmpeg on PATH, or wherever winget put it (a running server keeps the PATH it started with). */
function ffmpeg() {
  if (ffBin) return ffBin;
  if (process.env.FFMPEG) return (ffBin = process.env.FFMPEG);
  try {
    const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    for (const d of fs.readdirSync(root).filter((x) => /^Gyan\.FFmpeg/.test(x))) {
      const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === 'ffmpeg.exe') return p; } };
      const hit = walk(path.join(root, d)); if (hit) return (ffBin = hit);
    }
  } catch (e) { /* not installed that way */ }
  return (ffBin = 'ffmpeg');
}
const run = (args) => new Promise((res, rej) => execFile(ffmpeg(), args, { timeout: 60000, maxBuffer: 4e6 }, (err, so, se) => (err ? rej(Object.assign(err, { stderr: se })) : res(se))));
/* Three frames at 15%, 50% and 85% of the clip, as small JPEGs. */
async function frames(file) {
  const out = path.join(os.tmpdir(), 'scoutframes'); fs.mkdirSync(out, { recursive: true });
  let dur = 0; try { await run(['-hide_banner', '-i', file]); } catch (e) { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(e.stderr || '')); if (m) dur = +m[1] * 3600 + +m[2] * 60 + +m[3]; } // ffmpeg prints the length on stderr, then errors for lack of an output
  const base = path.basename(file, path.extname(file)), got = [];
  for (const [i, f] of [0.15, 0.5, 0.85].entries()) {
    const fp = path.join(out, `${base}_${i}.jpg`);
    try { await run(['-y', '-hide_banner', '-ss', String(Math.max(0, dur * f).toFixed(2)), '-i', file, '-frames:v', '1', '-vf', 'scale=1024:-2', '-q:v', '4', fp]); got.push(fs.readFileSync(fp)); } catch (e) { /* skip a bad frame */ }
    fs.unlink(fp, () => {});
  }
  return got;
}

const PROMPT = `You are helping a bow hunter read a photo from the field (trail camera, scouting walk, or a map/GPS screenshot). Reply with ONLY compact JSON:
{"kind":"deer|other_animal|sign|terrain|map|person|other","species":"","count":0,"sex":"buck|doe|unknown|n/a","rack":"short description or ''","sign":["rub","scrape","track","bed","trail","droppings"],"summary":"one plain sentence of what is in the photo","hunting_value":"one plain sentence on what this tells a bow hunter, or 'nothing useful'","confidence":"low|medium|high"}
Be honest: if you cannot tell, say so and use low confidence. Do not invent antler points you cannot count.`;

async function analyze(e) {
  const fp = path.join(UP_DIR, path.basename(e.file || '')), ext = path.extname(fp).toLowerCase();
  let imgs;
  if (e.kind === 'video') {
    imgs = (await frames(fp)).map((b) => ({ mime: 'image/jpeg', buf: b }));
    if (!imgs.length) return { skip: true };
  } else {
    if (!MIME[ext]) return { skip: true };
    const buf = fs.readFileSync(fp);
    if (buf.length > 4.5e6) return { skip: true };
    imgs = [{ mime: MIME[ext], buf }];
  }
  let text;
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 500, messages: [{ role: 'user', content: [...imgs.map((x) => ({ type: 'image', source: { type: 'base64', media_type: x.mime, data: x.buf.toString('base64') } })), { type: 'text', text: PROMPT }] }] }),
    });
    const j = await r.json();
    if (!r.ok) { const err = new Error((j.error && j.error.message) || 'API ' + r.status); err.status = r.status; throw err; }
    text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else text = await Gemini.vision(PROMPT, imgs);
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('No JSON in reply');
  return { vision: { ...JSON.parse(m[0]), ts: Date.now() } };
}

async function sweep() {
  if (busy || !hasAI() || Date.now() < pausedUntil) return;
  busy = true;
  try {
    for (const e of Scout.list().filter((x) => (x.kind === 'photo' || x.kind === 'video') && x.file && !x.vision && !x.visionSkip).slice(0, 5)) {
      try {
        const r = await analyze(e);
        Scout.setVision(e.id, r.skip ? { visionSkip: true } : { vision: r.vision });
      } catch (err) {
        console.warn('[vision]', err.message);
        if (err.status === 400 || err.status === 401 || err.status === 429 || err.status >= 500) { pausedUntil = Date.now() + 10 * 60000; break; } // billing / auth / rate limit: back off
        Scout.setVision(e.id, { visionSkip: true });
      }
    }
  } finally { busy = false; }
}
const start = () => { if (hasAI()) { setInterval(sweep, 20000); setTimeout(sweep, 3000); } };
module.exports = { start, sweep };
