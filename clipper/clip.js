#!/usr/bin/env node
// Auto-clipper: finds the loudest "hype" moments in a long video/VOD and
// cuts them into short clips, optionally reformatted to vertical 9:16.
//
// Usage: node clipper/clip.js <input> [options]   (run with --help for options)
// Requires ffmpeg + ffprobe on PATH. No npm dependencies.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const HELP = `
Auto-clipper — cut highlight clips out of a long video by audio intensity.

Usage: node clipper/clip.js <input video> [options]

Options:
  -n, --count <n>        Number of clips to make (default 5)
  -l, --length <sec>     Clip length in seconds (default 20)
      --lead <0-1>       Where the peak sits inside the clip; 0.4 = 40% of the
                         clip is build-up before the peak (default 0.4)
      --min-gap <sec>    Minimum spacing between clip peaks (default = length)
      --window <sec>     Context window for "louder than usual" (default 60)
  -v, --vertical <mode>  none | blur | crop   (default blur)
                           blur: full frame centered on a blurred 9:16 background
                           crop: center-crop to 9:16
  -o, --out <dir>        Output directory (default ./clips/<input name>)
      --dry-run          Only print the detected moments, don't render
  -h, --help             Show this help
`;

// ---------- helpers ----------

function run(cmd, args, { capture = false } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let out = '';
    let err = '';
    if (capture) p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) =>
      code === 0 ? res(out) : rej(new Error(`${cmd} exited ${code}\n${err.slice(-2000)}`)),
    );
  });
}

const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${sec}`;
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ---------- analysis ----------

async function probe(input) {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', input],
    { capture: true },
  );
  const j = JSON.parse(out);
  const video = j.streams.find((s) => s.codec_type === 'video');
  const hasAudio = j.streams.some((s) => s.codec_type === 'audio');
  return { duration: parseFloat(j.format.duration), video, hasAudio };
}

// Momentary loudness (EBU R128, 400ms window, sampled every 100ms) bucketed to 1s.
async function loudnessPerSecond(input, duration) {
  const dir = mkdtempSync(join(tmpdir(), 'clipper-'));
  const file = join(dir, 'loud.txt');
  try {
    process.stderr.write('Analyzing audio… ');
    await run('ffmpeg', [
      '-hide_banner', '-nostats', '-i', input, '-vn',
      '-af', `ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=${file.replace(/([:\\'])/g, '\\$1')}`,
      '-f', 'null', '-',
    ]);
    process.stderr.write('done\n');
    const secs = Math.ceil(duration);
    const sum = new Float64Array(secs);
    const cnt = new Uint32Array(secs);
    let t = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const pt = line.match(/pts_time:([\d.]+)/);
      if (pt) { t = parseFloat(pt[1]); continue; }
      const m = line.match(/lavfi\.r128\.M=(-?[\d.]+|-inf)/);
      if (m) {
        const i = Math.min(secs - 1, Math.floor(t));
        const db = m[1] === '-inf' ? -70 : Math.max(-70, parseFloat(m[1]));
        sum[i] += db;
        cnt[i]++;
      }
    }
    return Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : -70));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Score = how much louder this moment is than its surroundings, with a small
// bonus for absolute loudness. Smoothed over 3s so single pops don't win.
function score(loud, window) {
  const n = loud.length;
  const smooth = loud.map((_, i) => {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) { s += loud[k]; c++; }
    return s / c;
  });
  const half = Math.max(5, Math.round(window / 2));
  const globalMed = median(loud);
  return smooth.map((v, i) => {
    const ctx = loud.slice(Math.max(0, i - half), Math.min(n, i + half));
    const local = median(ctx);
    return (v - local) + 0.3 * (v - globalMed);
  });
}

function pickPeaks(scores, count, minGap) {
  const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const [s, i] of order) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.abs(p.t - i) >= minGap)) picked.push({ t: i, score: s });
  }
  return picked;
}

// ---------- render ----------

function vfFor(mode, video) {
  if (mode === 'none' || !video) return null;
  if (mode === 'crop') return 'crop=ih*9/16:ih,scale=1080:1920,setsar=1';
  return [
    'split=2[a][b]',
    '[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:2[bg]',
    '[b]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1',
  ].join(';');
}

async function render(input, clip, outFile, mode, video) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-ss', clip.start.toFixed(2), '-i', input, '-t', clip.length.toFixed(2)];
  const vf = vfFor(mode, video);
  if (vf) args.push(mode === 'blur' ? '-filter_complex' : '-vf', vf);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outFile);
  await run('ffmpeg', args);
}

// ---------- main ----------

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      count: { type: 'string', short: 'n', default: '5' },
      length: { type: 'string', short: 'l', default: '20' },
      lead: { type: 'string', default: '0.4' },
      'min-gap': { type: 'string' },
      window: { type: 'string', default: '60' },
      vertical: { type: 'string', short: 'v', default: 'blur' },
      out: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (o.help || positionals.length !== 1) {
    process.stdout.write(HELP);
    process.exit(o.help ? 0 : 1);
  }
  if (!['none', 'blur', 'crop'].includes(o.vertical)) throw new Error('--vertical must be none, blur or crop');

  const input = resolve(positionals[0]);
  const count = parseInt(o.count, 10);
  const lead = Math.min(1, Math.max(0, parseFloat(o.lead)));
  const { duration, video, hasAudio } = await probe(input);
  if (!hasAudio) throw new Error('Input has no audio track — nothing to detect hype moments from.');
  const length = Math.min(parseFloat(o.length), duration);
  const minGap = o['min-gap'] ? parseFloat(o['min-gap']) : length;

  const loud = await loudnessPerSecond(input, duration);
  const scores = score(loud, parseFloat(o.window));
  const peaks = pickPeaks(scores, count, minGap);

  const clips = peaks
    .map((p) => {
      const start = Math.min(Math.max(0, p.t + 0.5 - lead * length), Math.max(0, duration - length));
      return { peak: p.t, score: +p.score.toFixed(2), start: +start.toFixed(2), length };
    })
    .sort((a, b) => b.score - a.score)
    .map((c, i) => ({ rank: i + 1, ...c }));

  console.log(`\n${basename(input)} — ${fmt(duration)} long, ${clips.length} moments found:\n`);
  for (const c of clips) {
    console.log(`  #${c.rank}  peak ${fmt(c.peak).padStart(8)}  clip ${fmt(c.start)}–${fmt(c.start + c.length)}  score ${c.score}`);
  }
  if (o['dry-run'] || !clips.length) return;

  const name = basename(input, extname(input));
  const outDir = resolve(o.out ?? join('clips', name));
  mkdirSync(outDir, { recursive: true });
  console.log(`\nRendering to ${outDir}`);
  for (const c of clips) {
    c.file = `${name}_clip${String(c.rank).padStart(2, '0')}_${Math.round(c.peak)}s.mp4`;
    process.stdout.write(`  ${c.file} … `);
    await render(input, c, join(outDir, c.file), o.vertical, video);
    console.log('ok');
  }
  writeFileSync(join(outDir, 'clips.json'), JSON.stringify({ source: input, duration, clips }, null, 2));
  console.log(`  clips.json`);
}

main().catch((e) => {
  console.error(`\nError: ${e.message}`);
  process.exit(1);
});
