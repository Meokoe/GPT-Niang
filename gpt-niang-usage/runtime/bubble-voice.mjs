import {writeFileSync} from 'node:fs';
import {synth, toWav} from './bibibobo/bibibobo.js';

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

const wave = toWav(synth(text));
if (process.argv[2]) writeFileSync(process.argv[2], wave, {flag: 'wx'});
else process.stdout.write(wave);
