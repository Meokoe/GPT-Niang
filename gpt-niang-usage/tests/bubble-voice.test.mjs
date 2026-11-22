import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {synth, toWav, VOICES} from '../runtime/bibibobo/bibibobo.js';
import {cacheKleeSpeech, getKleeSpeech, requestKleeSpeech} from '../runtime/klee-voice.mjs';

const cli = fileURLToPath(new URL('../runtime/bubble-voice.mjs', import.meta.url));
function generate(text, ...options) {
  const result = spawnSync(process.execPath, [cli, ...options], {input: text, timeout: 5000});
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test('UTF-8 bubble text retains bibibobo question, exclamation and ellipsis melodies', () => {
  const plain = generate('真的吗');
  const question = generate('真的吗？');
  const exclamation = generate('真的吗！');
  const ellipsis = generate('真的吗……');
  assert.equal(plain.toString('ascii', 0, 4), 'RIFF');
  assert.equal(plain.toString('ascii', 8, 12), 'WAVE');
  assert.equal(plain.readUInt32LE(24), 44100);
  for (const [mark, audio] of [['？', question], ['！', exclamation], ['……', ellipsis]]) {
    assert.notDeepEqual(audio, plain);
    assert.deepEqual(audio, Buffer.from(toWav(synth('真的吗' + mark))));
  }
  assert.notDeepEqual(question, exclamation);
  assert.notDeepEqual(exclamation, ellipsis);
  assert.deepEqual(generate('真的吗?'), question);
  assert.deepEqual(generate('真的吗!'), exclamation);
  for (const mark of ['…', '...', '....']) assert.deepEqual(generate('真的吗' + mark), ellipsis);
  assert.deepEqual(
    generate('真的吗？太好了！等一下....'),
    Buffer.from(toWav(synth('真的吗？太好了！等一下…'))),
  );
  assert.equal(generate('！？....').length, 0);
});

test('voice and speed select upstream tone and timing without changing the sample rate', () => {
  const text = '你听见了吗？来试试新的声音！';
  const slow = generate(text, '--voice', 'lumo', '--speed', '50');
  const normal = generate(text, '--voice', 'lumo');
  const fast = generate(text, '--voice', 'lumo', '--speed', '200');
  assert.deepEqual(normal, Buffer.from(toWav(synth(text, {voice: 'lumo'}))));
  assert.deepEqual(fast, Buffer.from(toWav(synth(text, {voice: 'lumo', step: VOICES.lumo.step / 2, gap: 0.11}))));
  assert.ok(slow.length > normal.length && normal.length > fast.length);
  assert.equal(fast.readUInt32LE(24), 44100);
});

test('one visual cue is emitted at each synthesized syllable, with sentence pauses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-niang-speech-motion-'));
  try {
    const text = '你好？ OK42，走吧！';
    for (const [voice, speed, expected] of [
      ['fish', '200', [20, 85, 260, 435, 500]],
      ['lumo', '50', [20, 340, 1100, 1860, 2180]],
    ]) {
      const path = join(dir, voice + '.json');
      const options = ['--voice', voice, '--speed', speed];
      assert.deepEqual(generate(text, ...options, '--timings', path), generate(text, ...options));
      const timings = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(timings.length, expected.length);
      timings.forEach((time, index) => assert.ok(Math.abs(time - expected[index]) < 0.024));
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Klee sends the original bubble and speed to the local service and follows the returned WAV clock', async () => {
  const pcm = new Float32Array(32000);
  pcm.fill(0.25, 3200, 4800);
  pcm.fill(0.3, 12800, 14400);
  const wave = Buffer.from(toWav(pcm, 32000));
  const line = 'こんにちは……准备好了？';
  const result = await requestKleeSpeech(line, 1.6, true, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:9880/tts');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.text, line);
    assert.equal(body.speed_factor, 1.6);
    assert.equal(body.ref_audio_path, 'data/klee/audio/klee_005.wav');
    assert.equal(body.media_type, 'wav');
    return new Response(wave);
  });
  assert.deepEqual(result.wave, wave);
  assert.deepEqual(result.timings, [100, 400]);
  await assert.rejects(requestKleeSpeech(line, 1, true, async () => new Response('not a wave')));
});

test('an unavailable Klee service never produces bibibobo audio', () => {
  const mock = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => new Response(null, {status: 503});',
  );
  const result = spawnSync(process.execPath, ['--import', mock, cli, '--voice', 'klee'], {
    input: '准备好了吗？',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr.toString(), /KLEE_UNAVAILABLE/);
  assert.equal(result.stdout.length, 0);
});

test('prepared Klee bubbles play offline at their rendered speed and keep punctuation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-niang-klee-cache-'));
  const previous = process.env.KLEE_BUBBLE_CACHE_DIR;
  process.env.KLEE_BUBBLE_CACHE_DIR = dir;
  const offline = () => { throw new Error('Offline for this test'); };
  try {
    const line = '准备好了吗？';
    const pcm = new Float32Array(32000);
    pcm.fill(0.25, 3200, 4800);
    const wave = Buffer.from(toWav(pcm, 32000));
    assert.equal(await cacheKleeSpeech(line, 1.25, async () => new Response(wave)), true);
    assert.equal(await cacheKleeSpeech(line, 1.25, offline), false);
    assert.deepEqual(await getKleeSpeech(line, 1.25, true, offline), {wave, timings: [100]});
    assert.deepEqual(generate(line, '--voice', 'klee', '--speed', '125'), wave);
    await assert.rejects(getKleeSpeech(line, 1, false, offline), /Offline/);
    await assert.rejects(getKleeSpeech('准备好了吗！', 1.25, false, offline), /Offline/);
  } finally {
    if (previous === undefined) delete process.env.KLEE_BUBBLE_CACHE_DIR;
    else process.env.KLEE_BUBBLE_CACHE_DIR = previous;
    for (const file of readdirSync(dir)) unlinkSync(join(dir, file));
    rmdirSync(dir);
  }
});
