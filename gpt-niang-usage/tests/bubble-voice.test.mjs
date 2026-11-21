import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {synth, toWav} from '../runtime/bibibobo/bibibobo.js';

const cli = fileURLToPath(new URL('../runtime/bubble-voice.mjs', import.meta.url));
function generate(text) {
  const result = spawnSync(process.execPath, [cli], {input: text, timeout: 5000});
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
