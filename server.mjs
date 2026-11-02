import http from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const storage = process.env.CONVERSIONS_DIR || join(root, '.conversions');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const jobs = new Map();
const active = new Set();
export const MAX_BYTES = 20 * 1024 ** 3;
const terminal = job => ['complete', 'error', 'cancelled'].includes(job.status);

export function validateFilename(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f/\\]/.test(value) || !/\.mkv$/i.test(value)) throw new Error('Choose an MKV file.');
  return value;
}

export function conversionPlan(info, mode, hardware = process.platform === 'darwin' && process.env.FFMPEG_HWACCEL !== '0') {
  if (!['auto', 'compatible'].includes(mode)) throw new Error('Choose a supported conversion mode.');
  if (!info.format?.format_name?.split(',').includes('matroska')) throw new Error('This file is not a valid MKV video.');
  const video = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  if (!video) throw new Error('This MKV file has no video track.');
  const audio = info.streams.filter(stream => stream.codec_type === 'audio');
  const copyVideo = mode === 'auto' && video.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(video.pix_fmt);
  const args = ['-map', `0:${video.index}`];
  audio.forEach(stream => args.push('-map', `0:${stream.index}`));
  const encoder = copyVideo ? 'copy' : hardware ? 'h264_videotoolbox' : 'libx264';
  args.push('-c:v', encoder);
  if (!copyVideo) {
    if (hardware) {
      // Scale the bitrate with source resolution and frame rate. VideoToolbox
      // does not use x264's CRF scale; require real hardware, then retry in software.
      const [numerator, denominator] = String(video.avg_frame_rate || '').split('/').map(Number);
      const fps = numerator / denominator || 30;
      const bitrate = Math.round(Math.max(1e6, Math.min(80e6, (video.width || 1920) * (video.height || 1080) * fps * .12)));
      args.push('-allow_sw', '0', '-b:v', String(bitrate));
    } else args.push('-preset', 'fast', '-crf', '20');
    args.push('-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
  }
  audio.forEach((stream, index) => {
    const copyAudio = mode === 'auto' && stream.codec_name === 'aac';
    args.push(`-c:a:${index}`, copyAudio ? 'copy' : 'aac');
    if (!copyAudio) args.push(`-b:a:${index}`, '192k');
  });
  args.push('-sn', '-dn', '-map_chapters', '0', '-movflags', '+faststart');
  return { args, encoder, copyVideo, duration: Number(info.format.duration) || 0, audioTracks: audio.length };
}

export async function encodeVideo(job, info, execute = run) {
  let plan = conversionPlan(info, job.mode);
  job.duration = plan.duration;
  job.audioTracks = plan.audioTracks;
  const encode = async () => {
    if (job.status === 'cancelled') throw new Error('Conversion cancelled.');
    job.encoder = plan.encoder;
    job.method = plan.copyVideo ? 'Copying video without quality loss' : plan.encoder === 'h264_videotoolbox' ? 'Encoding with Apple video hardware' : job.hardwareFallback ? 'Encoding with CPU · hardware unavailable' : 'Encoding with CPU';
    job.status = 'converting';
    await execute(job, ffmpeg, ['-hide_banner', '-nostdin', '-y', '-i', job.input, ...plan.args, '-progress', 'pipe:1', '-nostats', job.file], line => {
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (match && plan.duration) job.progress = Math.min(99, Number(match[1]) / 1e6 / plan.duration * 100);
    });
  };
  try { await encode(); }
  catch (error) {
    if (job.status === 'cancelled' || plan.encoder !== 'h264_videotoolbox') throw error;
    job.hardwareFallback = true;
    job.progress = 0;
    plan = conversionPlan(info, job.mode, false);
    await encode();
  }
}

function run(job, executable, args, onLine) {
  return new Promise((resolveRun, reject) => {
    if (job.status === 'cancelled') return reject(new Error('Conversion cancelled.'));
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.child = child; active.add(child);
    let output = '', errors = '', pending = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 12 * 60 * 60 * 1000);
    child.stdout.on('data', data => {
      if (!onLine) { output += data; if (output.length > 8e6) child.kill('SIGKILL'); }
      else { pending += data.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop(); lines.forEach(onLine); }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => {
      reject(new Error(error.code === 'ENOENT' ? 'FFmpeg and FFprobe are required. Install them with brew install ffmpeg, then reopen the app.' : error.message));
    });
    child.on('close', code => {
      clearTimeout(timer); active.delete(child); delete job.child;
      if (job.status === 'cancelled') reject(new Error('Conversion cancelled.'));
      else if (code === 0) resolveRun(output);
      else {
        console.error(`${executable} failed: ${errors}`);
        reject(new Error('Could not convert this file. It may be damaged or use an unsupported codec. Check that there is enough free disk space.'));
      }
    });
  });
}

async function convert(job) {
  try {
    job.status = 'analyzing';
    const info = JSON.parse(await run(job, ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', job.input]));
    if (job.status === 'cancelled') return;
    await encodeVideo(job, info);
    if (job.status === 'cancelled') return;
    job.size = (await stat(job.file)).size;
    job.status = 'complete'; job.progress = 100;
  } catch (error) {
    if (job.status !== 'cancelled') { job.status = 'error'; job.error = error.message; }
  } finally {
    job.finished = Date.now();
    await rm(job.input, { force: true });
    if (job.status !== 'complete') await rm(job.directory, { recursive: true, force: true });
  }
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function publicJob(job) {
  const { child, input, file, directory, ...data } = job;
  return data;
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return json(res, 403, { error: 'Local requests only.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Request origin is not allowed.' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'POST' && url.pathname === '/api/convert') {
      const name = validateFilename(url.searchParams.get('name'));
      const mode = url.searchParams.get('mode') || 'auto';
      if (!['auto', 'compatible'].includes(mode)) return json(res, 400, { error: 'Choose a supported conversion mode.' });
      const length = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BYTES) return json(res, 413, { error: 'Choose a nonempty MKV file up to 20 GB.' });
      if ([...jobs.values()].filter(job => !terminal(job)).length >= 2) return json(res, 429, { error: 'Two conversions are already running. Try again shortly.' });
      const id = randomUUID(), directory = join(storage, id);
      const job = { id, name, mode, directory, input: join(directory, 'source.mkv'), file: join(directory, 'output.mp4'), status: 'uploading', progress: 0, created: Date.now() };
      jobs.set(id, job);
      try {
        await mkdir(directory, { recursive: true });
        let received = 0;
        await pipeline(req, new Transform({ transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(received > MAX_BYTES ? new Error('File exceeds the 20 GB limit.') : null, chunk);
        } }), createWriteStream(job.input, { flags: 'wx' }));
        if (received !== length) throw new Error('The file transfer was interrupted. Please try again.');
        job.status = 'queued';
        json(res, 202, { id });
        void convert(job);
      } catch (error) {
        job.status = 'error'; job.error = error.message; job.finished = Date.now();
        await rm(directory, { recursive: true, force: true });
        if (!res.destroyed) json(res, 400, { error: error.message });
      }
      return;
    }
    const match = /^\/api\/jobs\/([a-f0-9-]+)(\/download)?$/.exec(url.pathname);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: 'This conversion has expired. Choose your file again.' });
      if (req.method === 'DELETE' && !match[2]) {
        if (!terminal(job)) { job.status = 'cancelled'; job.child?.kill('SIGKILL'); }
        return json(res, 200, publicJob(job));
      }
      if (req.method === 'GET') {
        if (!match[2]) return json(res, 200, publicJob(job));
        if (job.status !== 'complete') return json(res, 409, { error: 'Your file is not ready yet.' });
        const name = job.name.replace(/\.mkv$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 140) + '.mp4';
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': job.size, 'Content-Disposition': `attachment; filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16))}` });
        const stream = createReadStream(job.file); stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
    const file = files[url.pathname];
    if (!file) return json(res, 404, { error: 'Not found.' });
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
    const stream = createReadStream(join(root, 'public', file[0])); stream.on('error', () => res.destroy()); stream.pipe(res);
  } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.destroy(); }
});
// Large local uploads and downloads must not inherit HTTP's five-minute limit.
server.requestTimeout = 0;
const cleanup = setInterval(async () => {
  for (const [id, job] of jobs) if (job.finished && Date.now() - job.finished > 3600000) {
    jobs.delete(id);
    await rm(job.directory, { recursive: true, force: true }).catch(() => {});
  }
}, 60000);
cleanup.unref();
export function stopConversions() {
  clearInterval(cleanup);
  for (const child of active) child.kill('SIGKILL');
}
export async function prepareStorage() {
  // The index is per process; discard leftovers from the previous session.
  await rm(storage, { recursive: true, force: true });
  await mkdir(storage, { recursive: true });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareStorage();
  server.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => console.log(`MKV converter ready at http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopConversions(); server.close(); process.exit(0); });
}
