import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {synth, toWav, VOICES} from './bibibobo/bibibobo.js';
import {requestKleeSpeech} from './klee-voice.mjs';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    voice: {type: 'string', default: 'fish'},
    speed: {type: 'string', default: '100'},
    timings: {type: 'string'},
  },
});
const speed = Number(values.speed);
if (values.voice !== 'klee' && !Object.hasOwn(VOICES, values.voice)) throw new Error('Unknown voice');
if (!Number.isInteger(speed) || speed < 50 || speed > 200) throw new Error('Speed must be 50–200 percent');

// Quotes are at most 200 characters. Leave room for the quota bubble's labels.
const limit = 4096;
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > limit) throw new Error('Bubble text exceeds the UTF-8 input limit');
  chunks.push(chunk);
}
const text = Buffer.concat(chunks).toString('utf8').trim();
const spoken = values.voice === 'klee' ? /[\p{L}\p{N}]/u : /[A-Za-z0-9\u4e00-\u9fff]/u;
if (!spoken.test(text)) process.exit(0);
if (text.length > 256) throw new Error('Bubble text exceeds the character limit');

const rate = speed / 100;
const voice = values.voice;
let wave;
let timings = [];
if (voice === 'klee') {
  try {
    ({wave, timings} = await requestKleeSpeech(text, rate, Boolean(values.timings)));
  } catch {
    process.stderr.write('KLEE_UNAVAILABLE\n');
    process.exit(1);
  }
} else {
  wave = toWav(synth(text.replace(/\.{3,}/g, '…'), {
    voice,
    step: VOICES[voice].step / rate,
    gap: 0.22 / rate,
    onSyllable: values.timings ? startMs => timings.push(startMs) : undefined,
  }));
}
if (positionals[0]) writeFileSync(positionals[0], wave, {flag: 'wx'});
else process.stdout.write(wave);
if (values.timings) writeFileSync(values.timings, JSON.stringify(timings), {flag: 'wx'});
