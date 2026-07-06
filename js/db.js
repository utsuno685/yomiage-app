// IndexedDB ラッパー：文書・音声キャッシュ・再生位置・設定・使用実績を端末内に保存する
const DB_NAME = 'yomiage-db';
const DB_VER = 1;
let _db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    if (_db) return resolve(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      db.createObjectStore('documents', { keyPath: 'id' });
      const audio = db.createObjectStore('audio', { keyPath: ['docId', 'chunk', 'cfg'] });
      audio.createIndex('byDoc', 'docId');
      db.createObjectStore('state', { keyPath: 'docId' });
      db.createObjectStore('settings', { keyPath: 'k' });
      db.createObjectStore('usage', { autoIncrement: true });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function put(name, value) { return reqP((await store(name, 'readwrite')).put(value)); }
export async function get(name, key) { return reqP((await store(name)).get(key)); }
export async function getAll(name) { return reqP((await store(name)).getAll()); }
export async function del(name, key) { return reqP((await store(name, 'readwrite')).delete(key)); }

// ---- 設定 ----
const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-2.5-flash-tts',
  voice: 'Kore',
  speed: 1.0,
  skipCode: true,        // コードブロックは「省略」アナウンス
  urlMode: 'skip',       // 'skip'（無音で読み飛ばす）| 'announce'（「リンクは省略」）| 'read'
  skipReferences: true,  // 参考文献リストをスキップ
  fallbackEnabled: true, // 失敗時に Web Speech API へ自動切替
  engine: 'gemini',      // 'gemini' | 'webspeech'
};

export async function loadSettings() {
  const rows = await getAll('settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.k] = r.v;
  return s;
}
export async function saveSetting(k, v) { return put('settings', { k, v }); }

// ---- 音声キャッシュ ----
export async function getAudio(docId, chunk, cfg) { return get('audio', [docId, chunk, cfg]); }
export async function putAudio(docId, chunk, cfg, blob, secs) {
  return put('audio', { docId, chunk, cfg, blob, secs, at: Date.now() });
}
export async function deleteDocAudio(docId) {
  const s = await store('audio', 'readwrite');
  const idx = s.index('byDoc');
  return new Promise((resolve, reject) => {
    const cur = idx.openCursor(IDBKeyRange.only(docId));
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  });
}
export async function audioStats(docId = null) {
  const rows = await getAll('audio');
  let bytes = 0, count = 0, secs = 0;
  for (const r of rows) {
    if (docId && r.docId !== docId) continue;
    bytes += r.blob?.size || 0; count++; secs += r.secs || 0;
  }
  return { bytes, count, secs };
}
export async function cachedChunkSet(docId, cfg) {
  const rows = await getAll('audio');
  return new Set(rows.filter(r => r.docId === docId && r.cfg === cfg).map(r => r.chunk));
}

// ---- 使用実績（今月の合成時間の概算） ----
export async function addUsage(secs) { return put('usage', { at: Date.now(), secs }); }
export async function monthUsage() {
  const rows = await getAll('usage');
  const now = new Date();
  let total = 0;
  for (const r of rows) {
    const d = new Date(r.at);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) total += r.secs || 0;
  }
  return total;
}

// ---- 文書 ----
export async function deleteDocument(docId) {
  await deleteDocAudio(docId);
  await del('state', docId);
  await del('documents', docId);
}
