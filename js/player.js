// 再生エンジン：チャンク単位の合成・先読み・キャッシュ再生・Web Speechフォールバック
import * as db from './db.js';
import { synthesize, RateLimitError } from './tts.js';

const CHUNK_CHARS = { ja: 320, en: 700 }; // 1リクエスト ≒ 音声30〜60秒分（リクエスト数節約）
const CHUNK_VER = 'v1';

// 文 → 実際に読み上げるテキスト（設定により省略・置換）。null なら読み飛ばす
export function spokenText(s, settings) {
  if (s.ref && settings.skipReferences) return null;
  if (s.code) {
    if (settings.skipCode) return 'コードは省略します。';
    return s.t;
  }
  let t = s.t;
  const urlRe = /https?:\/\/[^\s)」』]+/g;
  if (settings.urlMode === 'skip') t = t.replace(urlRe, '');
  else if (settings.urlMode === 'announce') t = t.replace(urlRe, 'リンクは省略します');
  t = t.trim();
  return t || null;
}

export function cacheCfg(settings) {
  return [settings.model, settings.voice, `c${settings.skipCode ? 1 : 0}`,
          `u${settings.urlMode}`, `r${settings.skipReferences ? 1 : 0}`, CHUNK_VER].join('|');
}

// 読み上げ対象の文を、文字数上限までまとめたチャンク列を作る
export function buildChunks(doc, settings) {
  const maxChars = CHUNK_CHARS[doc.language] || CHUNK_CHARS.ja;
  const chunks = [];
  let cur = null;
  doc.sentences.forEach((s, idx) => {
    const spoken = spokenText(s, settings);
    if (spoken == null) return;
    // 見出しの手前では、チャンクが6割以上埋まっていれば区切る（極小チャンクによるリクエスト浪費を防ぐ）
    if (!cur || cur.chars + spoken.length > maxChars || (s.h && cur.chars > maxChars * 0.6)) {
      cur = { index: chunks.length, items: [], chars: 0 };
      chunks.push(cur);
    }
    cur.items.push({ idx, spoken });
    cur.chars += spoken.length;
  });
  for (const c of chunks) c.text = c.items.map(i => i.spoken).join(' ');
  return chunks;
}

export class Player {
  constructor(doc, settings, callbacks) {
    this.doc = doc;
    this.settings = settings;
    this.cb = callbacks; // { onSentence(idx), onPlayState(bool), onStatus(msg), onError(msg) }
    this.chunks = buildChunks(doc, settings);
    this.cfg = cacheCfg(settings);
    this.mode = (settings.engine === 'webspeech' || !settings.apiKey) ? 'webspeech' : 'gemini';
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.playing = false;
    this.chunkIdx = -1;
    this.itemPos = 0;         // チャンク内の文位置
    this._synthLock = Promise.resolve();
    this._objectUrl = null;
    this._destroyed = false;
    this._playToken = 0;
    this.audio.addEventListener('timeupdate', () => this._onTimeUpdate());
    this.audio.addEventListener('ended', () => this._onChunkEnded());
    this._setupMediaSession();
  }

  get currentSentence() {
    const c = this.chunks[this.chunkIdx];
    return c ? c.items[Math.min(this.itemPos, c.items.length - 1)].idx : 0;
  }

  findChunk(sentenceIdx) {
    for (const c of this.chunks) {
      const p = c.items.findIndex(i => i.idx >= sentenceIdx);
      if (p >= 0) return { chunk: c.index, pos: p };
    }
    return this.chunks.length ? { chunk: 0, pos: 0 } : null;
  }

  // ---- 再生制御 ----

  async playFromSentence(sentenceIdx) {
    const loc = this.findChunk(sentenceIdx);
    if (!loc) { this.cb.onError('読み上げ対象の文がありません'); return; }
    await this._playChunk(loc.chunk, loc.pos);
  }

  async toggle() {
    if (this.playing) this.pause();
    else if (this.chunkIdx >= 0) await this.resume();
    else await this.playFromSentence(0);
  }

  pause() {
    this.playing = false;
    if (this.mode === 'webspeech') speechSynthesis.cancel();
    else this.audio.pause();
    this.cb.onPlayState(false);
  }

  async resume() {
    if (this.mode === 'webspeech') { await this._playChunk(this.chunkIdx, this.itemPos); return; }
    this.playing = true;
    try { await this.audio.play(); this.cb.onPlayState(true); }
    catch { this.playing = false; }
  }

  async nextSentence() {
    const c = this.chunks[this.chunkIdx];
    if (!c) return;
    if (this.itemPos + 1 < c.items.length) await this._seekWithin(this.itemPos + 1);
    else if (this.chunkIdx + 1 < this.chunks.length) await this._playChunk(this.chunkIdx + 1, 0);
  }

  async prevSentence() {
    if (this.itemPos > 0) await this._seekWithin(this.itemPos - 1);
    else if (this.chunkIdx > 0) {
      const prev = this.chunks[this.chunkIdx - 1];
      await this._playChunk(this.chunkIdx - 1, prev.items.length - 1);
    }
  }

  setSpeed(v) {
    this.settings.speed = v;
    this.audio.playbackRate = v;
  }

  destroy() {
    this._destroyed = true;
    this._playToken++;
    this.pause();
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this.audio.src = '';
  }

  // ---- 内部：Gemini モード ----

  async _playChunk(chunkIdx, pos) {
    if (this.mode === 'webspeech') return this._wsPlay(chunkIdx, pos);
    const token = ++this._playToken;
    this.chunkIdx = chunkIdx;
    this.itemPos = pos;
    this.cb.onSentence(this.currentSentence);
    this.cb.onStatus('音声を準備中…');
    let entry;
    try {
      entry = await this._ensureAudio(chunkIdx);
    } catch (e) {
      this.cb.onStatus('');
      if (this.settings.fallbackEnabled && (e instanceof RateLimitError || /ネットワーク/.test(e.message))) {
        this.cb.onError(`${e.message} — ブラウザ内蔵音声に切り替えます`);
        this.mode = 'webspeech';
        return this._wsPlay(chunkIdx, pos);
      }
      this.cb.onError(e.message);
      this.playing = false;
      this.cb.onPlayState(false);
      return;
    }
    if (token !== this._playToken || this._destroyed) return;
    this.cb.onStatus('');
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = URL.createObjectURL(entry.blob);
    this.audio.src = this._objectUrl;
    this.audio.playbackRate = this.settings.speed;
    const c = this.chunks[chunkIdx];
    this._chunkSecs = entry.secs;
    this._boundaries = this._charBoundaries(c);
    if (pos > 0) this.audio.currentTime = this._boundaries[pos] * entry.secs;
    this.playing = true;
    try { await this.audio.play(); this.cb.onPlayState(true); }
    catch (e) { this.playing = false; this.cb.onPlayState(false); this.cb.onError('再生を開始できません（画面をタップしてから再生してください）'); return; }
    this._prefetch(chunkIdx + 1);
  }

  _charBoundaries(chunk) {
    // チャンク内の各文の開始位置（文字割合 0..1）。ハイライト・シークの近似に使う
    const total = Math.max(chunk.chars, 1);
    const b = [];
    let acc = 0;
    for (const it of chunk.items) { b.push(acc / total); acc += it.spoken.length; }
    return b;
  }

  async _seekWithin(pos) {
    this.itemPos = pos;
    if (this.mode === 'webspeech') return this._wsPlay(this.chunkIdx, pos);
    if (this._boundaries && this._chunkSecs) {
      this.audio.currentTime = this._boundaries[pos] * this._chunkSecs;
      this.cb.onSentence(this.currentSentence);
      if (!this.playing) await this.resume();
    }
  }

  _onTimeUpdate() {
    if (this.mode !== 'gemini' || !this._boundaries || !this._chunkSecs) return;
    const ratio = this.audio.currentTime / this._chunkSecs;
    let pos = 0;
    for (let i = 0; i < this._boundaries.length; i++) if (ratio >= this._boundaries[i]) pos = i;
    if (pos !== this.itemPos) { this.itemPos = pos; this.cb.onSentence(this.currentSentence); }
  }

  async _onChunkEnded() {
    if (!this.playing || this._destroyed) return;
    if (this.chunkIdx + 1 < this.chunks.length) await this._playChunk(this.chunkIdx + 1, 0);
    else { this.playing = false; this.cb.onPlayState(false); this.cb.onStatus('最後まで再生しました'); }
  }

  async _ensureAudio(chunkIdx) {
    const cached = await db.getAudio(this.doc.id, chunkIdx, this.cfg);
    if (cached) return cached;
    // 合成は直列化（無料枠のレート制限にやさしく）
    const run = this._synthLock.then(async () => {
      const again = await db.getAudio(this.doc.id, chunkIdx, this.cfg);
      if (again) return again;
      const { blob, secs } = await synthesize(this.chunks[chunkIdx].text, this.settings);
      await db.putAudio(this.doc.id, chunkIdx, this.cfg, blob, secs);
      await db.addUsage(secs);
      return { blob, secs };
    });
    this._synthLock = run.catch(() => {});
    return run;
  }

  _prefetch(fromIdx) {
    // 次の2チャンクだけ先読み（聴く速度より速く消費しない）
    for (let i = fromIdx; i < Math.min(fromIdx + 2, this.chunks.length); i++) {
      this._ensureAudio(i).catch(() => {}); // 失敗は再生時に改めて処理
    }
  }

  // ---- 内部：Web Speech フォールバック ----

  _wsPlay(chunkIdx, pos) {
    speechSynthesis.cancel();
    this.chunkIdx = chunkIdx;
    this.itemPos = pos;
    this.playing = true;
    this.cb.onPlayState(true);
    this.cb.onSentence(this.currentSentence);
    const token = ++this._playToken;
    const speakNext = () => {
      if (token !== this._playToken || !this.playing || this._destroyed) return;
      const c = this.chunks[this.chunkIdx];
      if (!c) { this.playing = false; this.cb.onPlayState(false); return; }
      if (this.itemPos >= c.items.length) {
        if (this.chunkIdx + 1 < this.chunks.length) { this.chunkIdx++; this.itemPos = 0; }
        else { this.playing = false; this.cb.onPlayState(false); this.cb.onStatus('最後まで再生しました'); return; }
      }
      const item = this.chunks[this.chunkIdx].items[this.itemPos];
      this.cb.onSentence(item.idx);
      const u = new SpeechSynthesisUtterance(item.spoken);
      u.lang = this.doc.language === 'ja' ? 'ja-JP' : 'en-US';
      u.rate = this.settings.speed;
      const voice = speechSynthesis.getVoices().find(v => v.lang.startsWith(u.lang.slice(0, 2)));
      if (voice) u.voice = voice;
      u.onend = () => { this.itemPos++; speakNext(); };
      u.onerror = () => { this.itemPos++; speakNext(); };
      speechSynthesis.speak(u);
    };
    speakNext();
  }

  // ---- MediaSession（ロック画面・イヤホン操作） ----

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.doc.title,
      artist: '文書読み上げ',
    });
    const safe = (fn) => () => { fn().catch?.(() => {}); };
    try {
      navigator.mediaSession.setActionHandler('play', () => this.resume());
      navigator.mediaSession.setActionHandler('pause', () => this.pause());
      navigator.mediaSession.setActionHandler('previoustrack', safe(() => this.prevSentence()));
      navigator.mediaSession.setActionHandler('nexttrack', safe(() => this.nextSentence()));
    } catch { /* 一部ブラウザは未対応 */ }
  }
}
