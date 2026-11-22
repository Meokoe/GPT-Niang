import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';

const endpoint = 'http://127.0.0.1:9880/tts';
const maxVoiceBytes = 12 * 1024 * 1024;

function cachePath(text, rate) {
  const root = process.env.KLEE_BUBBLE_CACHE_DIR || join(
    process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'KleeTTS', 'klee-v2-ref005-cache-v1',
  );
  const key = createHash('sha256').update(JSON.stringify([text, rate])).digest('hex');
  return join(root, key + '.wav');
}

function readPCM(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF'
      || wav.toString('ascii', 8, 12) !== 'WAVE'
      || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error('Invalid TTS WAV');
  let rate, data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const type = wav.toString('ascii', offset, offset + 4);
    const bytes = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + bytes > wav.length) throw new Error('Truncated TTS WAV');
    if (type === 'fmt ') {
      if (bytes < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
          || wav.readUInt16LE(start + 14) !== 16) throw new Error('Expected mono PCM16');
      rate = wav.readUInt32LE(start + 4);
    } else if (type === 'data') data = wav.subarray(start, start + bytes);
    offset = start + bytes + (bytes & 1);
  }
  if (!rate || rate < 8000 || rate > 96000 || !data?.length || data.length % 2) throw new Error('Missing PCM samples');
  return {rate, data};
}

function speechOnsets({rate, data}) {
  // GPT-SoVITS gives us WAV, so mark rises in speech energy and skip silence.
  const hop = Math.round(rate / 100);
  const energy = [];
  let peak = 0;
  for (let offset = 0; offset + hop * 2 <= data.length; offset += hop * 2) {
    let sum = 0;
    for (let i = offset; i < offset + hop * 2; i += 2) sum += Math.abs(data.readInt16LE(i));
    energy.push(sum / hop);
    peak = Math.max(peak, sum / hop);
  }
  const gate = Math.max(125, peak * 0.07);
  const starts = [];
  let last = -10;
  for (let i = 0; i < energy.length; i++) {
    const previous = energy[i - 1] ?? 0;
    if (i - last >= 9 && energy[i] >= gate && (previous < gate || energy[i] > previous * 1.55)) {
      starts.push(i * hop * 1000 / rate);
      last = i;
    }
  }
  return starts;
}

export async function requestKleeSpeech(text, rate, withTimings, request = fetch, timeoutMs = 15000) {
  const response = await request(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      text, text_lang: 'auto',
      ref_audio_path: 'data/klee/audio/klee_005.wav',
      prompt_text: '今天也吃到了好吃的东西，可莉好开心！谢谢你！',
      prompt_lang: 'zh',
      speed_factor: rate,
      media_type: 'wav',
      streaming_mode: false,
    }),
  });
  if (!response.ok || !response.body) throw new Error('Klee TTS unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxVoiceBytes) throw new Error('Klee TTS response too large');
    chunks.push(chunk);
  }
  const wave = Buffer.concat(chunks, size);
  const pcm = readPCM(wave);
  return {wave, timings: withTimings ? speechOnsets(pcm) : []};
}

function hasSpeech({data, rate: sampleRate}, text, rate) {
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  let remaining = Math.ceil(sampleRate * Math.max(0.045, han * 0.028 / rate));
  for (let i = 0; i < data.length; i += 2) {
    if (Math.abs(data.readInt16LE(i)) >= 128 && --remaining === 0) return true;
  }
  return false;
}

async function readCachedWave(path, text, rate) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxVoiceBytes) return null;
    const wave = await readFile(path);
    const pcm = readPCM(wave);
    return hasSpeech(pcm, text, rate) ? {wave, pcm} : null;
  } catch {
    return null;
  }
}

export async function getKleeSpeech(text, rate, withTimings, request = fetch) {
  const cached = await readCachedWave(cachePath(text, rate), text, rate);
  if (cached) {
    return {wave: cached.wave, timings: withTimings ? speechOnsets(cached.pcm) : []};
  }
  return requestKleeSpeech(text, rate, withTimings, request);
}

export async function cacheKleeSpeech(text, rate, request = fetch) {
  const path = cachePath(text, rate);
  if (await readCachedWave(path, text, rate)) return false;
  const {wave} = await requestKleeSpeech(text, rate, false, request, 90000);
  if (!hasSpeech(readPCM(wave), text, rate)) throw new Error('Klee TTS returned incomplete speech');
  await mkdir(dirname(path), {recursive: true});
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, wave, {flag: 'wx'});
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return true;
}
