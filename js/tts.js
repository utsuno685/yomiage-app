// Gemini TTS クライアント：テキスト → WAV Blob
// 無料枠前提のため 429/503 は指数バックオフで再試行する

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const VOICES = [
  { id: 'Kore', label: 'Kore（落ち着いた女性）' },
  { id: 'Aoede', label: 'Aoede（明るい女性）' },
  { id: 'Leda', label: 'Leda（若い女性）' },
  { id: 'Puck', label: 'Puck（軽快な男性)' },
  { id: 'Charon', label: 'Charon（低めの男性）' },
  { id: 'Enceladus', label: 'Enceladus（穏やかな男性）' },
];

export const MODELS = [
  'gemini-2.5-flash-tts',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-flash-lite-preview-tts',
  'gemini-2.5-pro-tts',
];

export class RateLimitError extends Error {}

// text → { blob (audio/wav), secs }
export async function synthesize(text, { apiKey, model, voice }) {
  if (!apiKey) throw new Error('APIキーが設定されていません');
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };

  const delays = [2000, 5000, 12000, 25000];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error('ネットワークエラー：Gemini APIに接続できません');
    }
    if (res.status === 429 || res.status === 503) {
      lastErr = new RateLimitError(`レート制限中（HTTP ${res.status}）`);
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      throw lastErr;
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error?.message || `Gemini APIエラー（HTTP ${res.status}）`);
    }
    const json = await res.json();
    const part = json?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part) throw new Error('音声データが返されませんでした（モデル名がTTS対応か確認してください）');
    const rate = parseInt(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] || '24000', 10);
    const pcm = base64ToBytes(part.inlineData.data);
    const secs = pcm.length / 2 / rate;
    return { blob: pcmToWav(pcm, rate), secs };
  }
  throw lastErr;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 16bit mono PCM に WAV ヘッダーを付ける
export function pcmToWav(pcmBytes, sampleRate) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + pcmBytes.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);            // PCM
  v.setUint16(22, 1, true);            // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, pcmBytes.length, true);
  return new Blob([header, pcmBytes], { type: 'audio/wav' });
}
