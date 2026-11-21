import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {synth, toWav, VOICES} from '../runtime/bibibobo/bibibobo.js';

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
