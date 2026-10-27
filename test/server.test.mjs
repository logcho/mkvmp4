import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'mkvmp4-test-'));
process.env.CONVERSIONS_DIR = join(temporary, 'jobs');
const { server, stopConversions, prepareStorage, conversionPlan, validateFilename } = await import('../server.mjs');
let base;
before(async () => {
  await prepareStorage();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  stopConversions(); await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
});
const info = (codec = 'h264', pix = 'yuv420p') => ({ format: { format_name: 'matroska,webm', duration: '1' }, streams: [
  { index: 0, codec_type: 'video', codec_name: codec, pix_fmt: pix },
  { index: 1, codec_type: 'audio', codec_name: 'aac' },
  { index: 2, codec_type: 'audio', codec_name: 'flac' },
  { index: 3, codec_type: 'subtitle', codec_name: 'subrip' }
] });
test('plans preserve compatible video and every audio track, transcoding incompatible audio', () => {
  const plan = conversionPlan(info(), 'auto');
  assert.equal(plan.copyVideo, true); assert.equal(plan.audioTracks, 2);
  assert.ok(plan.args.includes('-c:a:1')); assert.ok(plan.args.includes('aac'));
  assert.equal(conversionPlan(info('hevc'), 'auto').copyVideo, false);
  assert.equal(conversionPlan(info('h264', 'yuv420p10le'), 'auto').copyVideo, false);
  assert.equal(conversionPlan(info(), 'compatible').copyVideo, false);
  assert.throws(() => conversionPlan({ format: { format_name: 'mov,mp4' } }, 'auto'));
  assert.throws(() => conversionPlan(info(), 'invalid'));
});
test('validates file names and rejects foreign origins and hostnames', async () => {
  assert.equal(validateFilename('Movie.MKV'), 'Movie.MKV');
  for (const value of ['movie.mp4', '../movie.mkv', 'a\nb.mkv', '']) assert.throws(() => validateFilename(value));
  const foreign = await fetch(`${base}/api/convert?name=x.mkv`, { method: 'POST', headers: { Origin: 'https://example.com' }, body: 'abc' });
  assert.equal(foreign.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(base, { headers: { Host: 'evil.example:3001' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/abc`)).status, 404);
  assert.equal((await fetch(`${base}/api/convert?name=x.mkv`, { method: 'POST' })).status, 413);
});
async function waitJob(id) {
  for (let i = 0; i < 300; i++) {
    const job = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (['complete', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Conversion did not finish within 30 seconds.');
}
async function uploadFile(file, mode = 'auto', name = 'test.mkv') {
  const response = await fetch(`${base}/api/convert?name=${encodeURIComponent(name)}&mode=${mode}`, { method: 'POST', body: await readFile(file) });
  assert.equal(response.status, 202);
  return (await response.json()).id;
}
for (const [codec, mode] of [['libx264', 'auto'], ['ffv1', 'auto'], ['libx264', 'compatible']]) {
  test(`real MKV conversion: ${codec}, ${mode}`, async () => {
    const file = join(temporary, `${codec}-${mode}.mkv`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', codec, '-c:a', 'flac', file]);
    const id = await uploadFile(file, mode, 'My video 日本語.mkv');
    const job = await waitJob(id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.progress, 100); assert.equal(job.audioTracks, 2);
    assert.equal(job.file, undefined); assert.equal(job.directory, undefined);
    const download = await fetch(`${base}/api/jobs/${id}/download`);
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'video/mp4');
    assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('My video 日本語.mp4')));
    const output = join(temporary, `${id}.mp4`);
    await writeFile(output, Buffer.from(await download.arrayBuffer()));
    const actual = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
    assert.equal(actual.streams[0].codec_name, 'h264');
    assert.equal(actual.streams.filter(stream => stream.codec_name === 'aac').length, 2);
    assert.ok(actual.format.format_name.includes('mp4'));
    if (codec === 'libx264' && mode === 'auto') {
      const hashes = path => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8' });
      assert.equal(hashes(file), hashes(output), 'Video packets must be unchanged in copy mode');
    }
  });
}
test('invalid file contents report an actionable conversion error', async () => {
  const file = join(temporary, 'invalid.mkv'); await writeFile(file, 'not a video');
  const job = await waitJob(await uploadFile(file));
  assert.equal(job.status, 'error'); assert.match(job.error, /damaged|unsupported/);
});
test('cancellation stops an active conversion and prevents downloads', async () => {
  const file = join(temporary, 'cancel.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  const id = await uploadFile(file, 'compatible');
  const response = await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' });
  assert.equal((await response.json()).status, 'cancelled');
  assert.equal((await fetch(`${base}/api/jobs/${id}/download`)).status, 409);
  await new Promise(resolve => setTimeout(resolve, 200));
});
