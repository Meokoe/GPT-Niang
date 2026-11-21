import {writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {synth, toWav, VOICES} from './bibibobo/bibibobo.js';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    voice: {type: 'string', default: 'fish'},
    speed: {type: 'string', default: '100'},
  },
});
const speed = Number(values.speed);
if (!Object.hasOwn(VOICES, values.voice)) throw new Error('Unknown voice');
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
const text = Buffer.concat(chunks).toString('utf8').trim().replace(/\.{3,}/g, '…');
if (!/[A-Za-z0-9\u4e00-\u9fff]/u.test(text)) process.exit(0);
if (text.length > 256) throw new Error('Bubble text exceeds the character limit');

const rate = speed / 100;
const voice = values.voice;
const wave = toWav(synth(text, {voice, step: VOICES[voice].step / rate, gap: 0.22 / rate}));
if (positionals[0]) writeFileSync(positionals[0], wave, {flag: 'wx'});
else process.stdout.write(wave);
