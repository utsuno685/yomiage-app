// UI制御：ライブラリ・再生画面・設定画面
import * as db from './db.js';
import { extractFile, estimateSeconds } from './extract.js';
import { Player, cacheCfg, buildChunks } from './player.js';
import { VOICES, MODELS } from './tts.js';

let settings = null;
let player = null;
let currentDoc = null;
let saveTimer = null;
let userScrolledAt = 0;

const $ = (id) => document.getElementById(id);

// ---------- 初期化 ----------

async function init() {
  await db.openDB();
  settings = await db.loadSettings();
  bindLibrary();
  bindPlayer();
  bindSettings();
  await renderLibrary();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeunload', () => flushState());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushState(); });
}

function showView(name) {
  for (const v of ['library', 'player', 'settings']) {
    $(`view-${v}`).classList.toggle('active', v === name);
  }
}

function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---------- ライブラリ ----------

function bindLibrary() {
  $('btnAddFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', async (e) => {
    await importFiles([...e.target.files]);
    e.target.value = '';
  });
  $('btnSettings').addEventListener('click', () => { renderSettings(); showView('settings'); });
  // PCではドラッグ＆ドロップも受け付ける
  const drop = $('view-library');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    await importFiles([...e.dataTransfer.files]);
  });
}

async function importFiles(files) {
  for (const file of files) {
    const prog = showProgress(`${file.name} を変換中…`);
    try {
      const extracted = await extractFile(file);
      const doc = {
        id: crypto.randomUUID ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, // http(LAN)アクセス時のフォールバック
        ...extracted,
        fileName: file.name,
        addedAt: Date.now(),
      };
      if (!doc.sentences.length) throw new Error('テキストを抽出できませんでした');
      await db.put('documents', doc);
      toast(`「${doc.title}」を追加しました（${doc.sentences.length}文）`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    } finally {
      prog.remove();
    }
  }
  await renderLibrary();
}

function showProgress(msg) {
  const el = document.createElement('div');
  el.className = 'progress-toast';
  el.innerHTML = `<span class="spinner"></span>${escapeHtml(msg)}`;
  document.body.appendChild(el);
  return el;
}

async function renderLibrary() {
  const docs = (await db.getAll('documents')).sort((a, b) => b.addedAt - a.addedAt);
  const states = new Map((await db.getAll('state')).map(s => [s.docId, s]));
  const list = $('docList');
  if (!docs.length) {
    list.innerHTML = `<div class="empty">まだ文書がありません。<br>「＋ 文書を追加」から PDF / Word / Markdown / テキスト を取り込めます。</div>`;
    return;
  }
  list.innerHTML = '';
  for (const doc of docs) {
    const st = states.get(doc.id);
    const pct = st ? Math.min(100, Math.round((st.idx + 1) / doc.sentences.length * 100)) : 0;
    const mins = Math.round(estimateSeconds(doc) / 60);
    const item = document.createElement('div');
    item.className = 'doc-item';
    item.innerHTML = `
      <div class="doc-main">
        <div class="doc-title">${escapeHtml(doc.title)}</div>
        <div class="doc-meta">
          <span class="badge">${doc.format}</span>
          <span>約${mins}分</span>
          <span>${new Date(doc.addedAt).toLocaleDateString('ja-JP')}</span>
          ${st ? `<span>最終再生 ${relativeTime(st.at)}</span>` : ''}
        </div>
        <div class="doc-progress"><div class="doc-progress-bar" style="width:${pct}%"></div></div>
        <div class="doc-pct">${pct > 0 ? `${pct}% 再生済み` : '未再生'}</div>
      </div>
      <button class="doc-del" title="削除" aria-label="削除">🗑</button>`;
    item.querySelector('.doc-main').addEventListener('click', () => openDoc(doc.id));
    item.querySelector('.doc-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`「${doc.title}」を削除しますか？（音声キャッシュも削除されます）`)) return;
      await db.deleteDocument(doc.id);
      await renderLibrary();
      toast('削除しました');
    });
    list.appendChild(item);
  }
}

function relativeTime(ts) {
  const d = Math.floor((Date.now() - ts) / 60000);
  if (d < 60) return `${Math.max(d, 1)}分前`;
  if (d < 1440) return `${Math.floor(d / 60)}時間前`;
  return `${Math.floor(d / 1440)}日前`;
}

// ---------- 再生画面 ----------

function bindPlayer() {
  $('btnBack').addEventListener('click', async () => {
    flushState();
    player?.destroy();
    player = null;
    currentDoc = null;
    await renderLibrary();
    showView('library');
  });
  $('btnPlay').addEventListener('click', () => player?.toggle());
  $('btnPrevSent').addEventListener('click', () => player?.prevSentence());
  $('btnNextSent').addEventListener('click', () => player?.nextSentence());
  $('speedSelect').addEventListener('change', async (e) => {
    const v = parseFloat(e.target.value);
    player?.setSpeed(v);
    settings.speed = v;
    await db.saveSetting('speed', v);
  });
  $('btnToc').addEventListener('click', () => $('tocDrawer').classList.toggle('open'));
  $('tocClose').addEventListener('click', () => $('tocDrawer').classList.remove('open'));
  $('btnRename').addEventListener('click', async () => {
    if (!currentDoc) return;
    const name = prompt('タイトルを変更', currentDoc.title);
    if (name && name.trim()) {
      currentDoc.title = name.trim();
      await db.put('documents', currentDoc);
      $('playerTitle').textContent = currentDoc.title;
    }
  });
  $('textContainer').addEventListener('scroll', () => { userScrolledAt = Date.now(); }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (!player || !$('view-player').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
    if (e.code === 'ArrowRight') player.nextSentence();
    if (e.code === 'ArrowLeft') player.prevSentence();
  });
}

async function openDoc(docId) {
  const doc = await db.get('documents', docId);
  if (!doc) return;
  currentDoc = doc;
  settings = await db.loadSettings();
  $('playerTitle').textContent = doc.title;
  $('speedSelect').value = String(settings.speed);
  renderText(doc);
  renderToc(doc);
  updateEngineBadge();

  player = new Player(doc, settings, {
    onSentence: (idx) => { highlight(idx); scheduleStateSave(idx); },
    onPlayState: (playing) => {
      $('btnPlay').textContent = playing ? '⏸' : '▶';
      $('btnPlay').setAttribute('aria-label', playing ? '一時停止' : '再生');
    },
    onStatus: (msg) => { $('statusBar').textContent = msg; },
    onError: (msg) => { toast(msg, true); updateEngineBadge(); },
  });

  const st = await db.get('state', docId);
  const startIdx = st ? Math.max(0, st.idx - 2) : 0; // 少し手前から再開
  highlight(startIdx, true);
  showView('player');
  $('statusBar').textContent = st ? `前回の続き（${Math.round((st.idx + 1) / doc.sentences.length * 100)}%）から再生できます` : '▶ で再生を開始します';
  // 最初の再生は保存位置から
  const origToggle = player.toggle.bind(player);
  let first = true;
  player.toggle = async () => {
    if (first && !player.playing && player.chunkIdx < 0) { first = false; await player.playFromSentence(startIdx); }
    else await origToggle();
  };
}

function updateEngineBadge() {
  const mode = player?.mode || ((settings.engine === 'webspeech' || !settings.apiKey) ? 'webspeech' : 'gemini');
  $('engineBadge').textContent = mode === 'gemini' ? 'Gemini' : '内蔵音声';
  $('engineBadge').className = `engine-badge ${mode}`;
}

function renderText(doc) {
  const container = $('textContainer');
  container.innerHTML = '';
  const frag = document.createDocumentFragment();
  doc.sentences.forEach((s, idx) => {
    let el;
    if (s.h) {
      el = document.createElement(`h${Math.min(s.h + 1, 6)}`);
      el.className = 'sent heading';
    } else if (s.code) {
      el = document.createElement('pre');
      el.className = 'sent code';
    } else {
      el = document.createElement('span');
      el.className = 'sent' + (s.ref ? ' ref' : '');
    }
    el.dataset.idx = idx;
    el.textContent = s.t;
    el.addEventListener('click', () => player?.playFromSentence(idx));
    frag.appendChild(el);
    if (!s.h && !s.code) frag.appendChild(document.createTextNode(' '));
  });
  container.appendChild(frag);
}

function renderToc(doc) {
  const list = $('tocList');
  list.innerHTML = '';
  if (!doc.sections.length) {
    list.innerHTML = '<div class="empty small">見出しがありません</div>';
    return;
  }
  for (const sec of doc.sections) {
    const btn = document.createElement('button');
    btn.className = `toc-item level-${sec.level}`;
    btn.textContent = sec.title;
    btn.addEventListener('click', () => {
      $('tocDrawer').classList.remove('open');
      player?.playFromSentence(sec.idx);
    });
    list.appendChild(btn);
  }
}

let highlighted = null;
function highlight(idx, force = false) {
  if (highlighted) highlighted.classList.remove('current');
  const el = $('textContainer').querySelector(`[data-idx="${idx}"]`);
  if (!el) return;
  el.classList.add('current');
  highlighted = el;
  // 直近5秒以内に手動スクロールしていたら自動スクロールを控える
  if (force || Date.now() - userScrolledAt > 5000) {
    el.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }
}

function scheduleStateSave(idx) {
  if (!currentDoc) return;
  currentDoc._lastIdx = idx;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushState(); }, 3000);
}

function flushState() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (currentDoc && currentDoc._lastIdx != null) {
    db.put('state', { docId: currentDoc.id, idx: currentDoc._lastIdx, at: Date.now() }).catch(() => {});
  }
}

// ---------- 設定 ----------

function bindSettings() {
  $('btnSettingsBack').addEventListener('click', () => { renderLibrary(); showView('library'); });
  const save = async (k, v) => { settings[k] = v; await db.saveSetting(k, v); };
  $('inpApiKey').addEventListener('change', (e) => save('apiKey', e.target.value.trim()));
  $('selModel').addEventListener('change', (e) => save('model', e.target.value));
  $('selVoice').addEventListener('change', (e) => save('voice', e.target.value));
  $('selEngine').addEventListener('change', (e) => save('engine', e.target.value));
  $('selUrlMode').addEventListener('change', (e) => save('urlMode', e.target.value));
  $('chkSkipCode').addEventListener('change', (e) => save('skipCode', e.target.checked));
  $('chkSkipRefs').addEventListener('change', (e) => save('skipReferences', e.target.checked));
  $('chkFallback').addEventListener('change', (e) => save('fallbackEnabled', e.target.checked));
  $('btnClearCache').addEventListener('click', async () => {
    if (!confirm('すべての音声キャッシュを削除しますか？（再度聞くときは再合成されます）')) return;
    const docs = await db.getAll('documents');
    for (const d of docs) await db.deleteDocAudio(d.id);
    await renderSettings();
    toast('音声キャッシュを削除しました');
  });
}

async function renderSettings() {
  settings = await db.loadSettings();
  $('inpApiKey').value = settings.apiKey;
  const selModel = $('selModel');
  selModel.innerHTML = MODELS.map(m => `<option value="${m}">${m}</option>`).join('');
  if (!MODELS.includes(settings.model)) selModel.innerHTML += `<option value="${escapeHtml(settings.model)}">${escapeHtml(settings.model)}</option>`;
  selModel.value = settings.model;
  const selVoice = $('selVoice');
  selVoice.innerHTML = VOICES.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
  selVoice.value = settings.voice;
  $('selEngine').value = settings.engine;
  $('selUrlMode').value = settings.urlMode;
  $('chkSkipCode').checked = settings.skipCode;
  $('chkSkipRefs').checked = settings.skipReferences;
  $('chkFallback').checked = settings.fallbackEnabled;

  const { bytes, secs } = await db.audioStats();
  $('cacheInfo').textContent = `音声キャッシュ: ${formatBytes(bytes)}（約${Math.round(secs / 60)}分ぶん）`;
  const monthSecs = await db.monthUsage();
  $('usageInfo').textContent = `今月の合成時間: 約${Math.round(monthSecs / 60)}分（無料枠で運用中）`;
}

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatBytes(b) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

// ---------- 動作確認用フック（UIからは使わない） ----------
window.__test = {
  async importString(name, text) {
    const file = new File([text], name, { type: 'text/plain' });
    await importFiles([file]);
  },
  buildChunks, cacheCfg,
  getSettings: () => settings,
  db,
};

init().catch(e => { console.error(e); toast(`初期化エラー: ${e.message}`, true); });
