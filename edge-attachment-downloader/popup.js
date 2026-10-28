'use strict';

// ポップアップ画面：ページ内と通信の記録からファイルを集めて一覧にし、選んだものを保存する

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

const SOURCE_LABEL = { link: 'ページ内', net: '通信', blob: 'ページで生成' };
const ERROR_LABEL = {
  SERVER_UNAUTHORIZED: 'ログインが必要（サーバーが拒否）',
  SERVER_FORBIDDEN: '権限がない（サーバーが拒否）',
  SERVER_BAD_CONTENT: 'ファイルが見つからない',
  SERVER_FAILED: 'サーバーエラー',
  NETWORK_FAILED: '通信エラー',
  NETWORK_TIMEOUT: '時間切れ',
  NETWORK_DISCONNECTED: '通信が切れた',
  FILE_ACCESS_DENIED: '保存先に書き込めない',
  FILE_NO_SPACE: '空き容量が足りない',
  FILE_NAME_TOO_LONG: 'ファイル名が長すぎる',
  FILE_BLOCKED: 'ブラウザの設定で止められた',
  FILE_VIRUS_INFECTED: 'ウイルス対策で止められた',
  USER_CANCELED: 'キャンセルされた',
};

const state = {
  tab: null,
  items: [],
  selected: new Set(),
  cats: new Set(),
  query: '',
};

init().catch((e) => showNotice(`エラー: ${e.message}`));

async function init() {
  const s = await chrome.storage.local.get({ useFolder: false, folder: '{host}_{date}', cats: null });
  $('#useFolder').checked = s.useFolder;
  $('#folder').value = s.folder;
  $('#folder').disabled = !s.useFolder;
  state.cats = new Set(s.cats || ADL.CATEGORIES.map((c) => c.key));

  $('#q').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); render(); });
  $('#all').addEventListener('change', (e) => {
    for (const it of visibleItems()) {
      if (!isBlocked(it)) e.target.checked ? state.selected.add(it.url) : state.selected.delete(it.url);
    }
    render();
  });
  $('#rescan').addEventListener('click', () => scan());
  $('#clear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearCaptured', tabId: state.tab.id });
    scan();
  });
  $('#useFolder').addEventListener('change', (e) => {
    $('#folder').disabled = !e.target.checked;
    chrome.storage.local.set({ useFolder: e.target.checked });
  });
  $('#folder').addEventListener('change', (e) => chrome.storage.local.set({ folder: e.target.value }));
  $('#download').addEventListener('click', startDownload);

  state.tab = await getTargetTab();
  if (!state.tab) {
    showNotice('対象のタブが見つかりません。');
    return;
  }
  $('#page').textContent = state.tab.title || state.tab.url || '';
  $('#page').title = state.tab.url || '';
  await scan();
}

async function getTargetTab() {
  const id = Number(params.get('tabId')); // 動作確認用：?tabId= で対象タブを指定できる
  if (id) return chrome.tabs.get(id).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ---------- 収集 ----------

async function scan() {
  const tabId = state.tab.id;
  $('#rescan').disabled = true;
  showNotice('');
  const found = [];
  let pageError = '';
  let late = false;

  try {
    // 拡張機能を入れる前から開いていたタブにも、調査用の処理を入れる（入っていれば何もしない）
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['common.js', 'content.js'] });
  } catch { /* 入れられないフレームがあっても続ける */ }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis.__adlScan ? globalThis.__adlScan() : null),
    });
    for (const r of results) {
      if (!r || !r.result || !Array.isArray(r.result.items)) continue;
      if (r.frameId === 0 && r.result.late) late = true;
      for (const it of r.result.items) found.push({ ...it, frameId: r.frameId });
    }
  } catch (e) {
    pageError = e.message || String(e);
  }

  const net = await chrome.runtime.sendMessage({ type: 'getCaptured', tabId }).catch(() => []);
  if (Array.isArray(net)) found.push(...net);

  const prev = new Map(state.items.map((it) => [it.url, state.selected.has(it.url)]));
  state.items = sortItems(mergeBlobSources(mergeItems(found)));
  state.selected = new Set(
    state.items
      .filter((it) => !isBlocked(it) && (prev.has(it.url) ? prev.get(it.url) : !it.guess))
      .map((it) => it.url),
  );

  if (pageError) {
    showNotice('このページの中は調べられません（ブラウザの設定画面・拡張機能ストアなど）。通信の記録だけを表示しています。');
  } else if (late) {
    showNotice('このタブは拡張機能を入れる前から開いていたため、ページ内のリンクしか拾えていません。ページを再読み込みしてから開き直すと、通信やページ内で作られたファイルも拾えます。');
  }
  $('#rescan').disabled = false;
  render();
}

// 同じ URL がページ内・通信の両方で見つかったら 1 件にまとめる
function mergeItems(list) {
  const map = new Map();
  for (const it of list) {
    const cur = map.get(it.url);
    if (!cur) {
      map.set(it.url, { ...it, sources: [it.source] });
      continue;
    }
    if (!cur.sources.includes(it.source)) cur.sources.push(it.source);
    if ((it.nameRank || 0) > (cur.nameRank || 0)) { cur.name = it.name; cur.nameRank = it.nameRank; }
    if (!cur.ext && it.ext) { cur.ext = it.ext; cur.category = it.category; }
    cur.guess = cur.guess && it.guess;
    cur.size = cur.size || it.size;
    cur.contentType = cur.contentType || it.contentType;
    cur.label = cur.label || it.label;
    if (cur.frameId === undefined && it.frameId !== undefined) cur.frameId = it.frameId;
    // ページ内のリンクとして見つかったものは、通常の GET で取り直せる
    if (it.source === 'link' || cur.source === 'link') cur.method = 'GET';
  }
  return [...map.values()];
}

// fetch などで受け取ってページ内に保持されたファイル（Blob）と、その通信の記録を 1 件にまとめる
function mergeBlobSources(items) {
  const byUrl = new Map(items.map((it) => [it.url, it]));
  const drop = new Set();
  for (const b of items) {
    if (b.source !== 'blob' || !b.src || drop.has(b)) continue;
    const other = byUrl.get(b.src);
    if (!other || other === b || drop.has(other)) continue;
    if (other.sources.includes('link') && !isBlocked(other)) {
      // ページ内にリンクがあるものは、リンクから取り直す
      if (!other.sources.includes('blob')) other.sources.push('blob');
      drop.add(b);
    } else {
      // 通信だけで見つかったもの（POST を含む）は、ページが受け取った中身をそのまま保存する
      for (const s of other.sources) if (!b.sources.includes(s)) b.sources.push(s);
      if ((other.nameRank || 0) > (b.nameRank || 0)) {
        b.name = other.name;
        b.nameRank = other.nameRank;
      }
      if (other.ext && !ADL.extOf(b.name)) { b.ext = other.ext; b.category = other.category; }
      drop.add(other);
    }
  }
  return items.filter((it) => !drop.has(it));
}

function sortItems(items) {
  const rank = (it) => (isBlocked(it) ? 2 : it.guess ? 1 : 0);
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i)
    .map((x) => x.it);
}

function isBlocked(it) {
  return !!it.method && it.method.toUpperCase() !== 'GET';
}

// ---------- 表示 ----------

function visibleItems() {
  return state.items.filter((it) => {
    if (!state.cats.has(it.category)) return false;
    if (!state.query) return true;
    return `${it.name} ${it.url} ${it.label || ''}`.toLowerCase().includes(state.query);
  });
}

function render() {
  renderCats();
  const list = $('#list');
  list.textContent = '';
  const vis = visibleItems();
  for (const it of vis) list.append(renderRow(it));

  const selectable = vis.filter((it) => !isBlocked(it));
  const picked = selectable.filter((it) => state.selected.has(it.url));
  const all = $('#all');
  all.checked = selectable.length > 0 && picked.length === selectable.length;
  all.indeterminate = picked.length > 0 && picked.length < selectable.length;
  all.disabled = selectable.length === 0;

  $('#count').textContent = state.items.length
    ? `${vis.length} 件表示中・${picked.length} 件選択`
    : '';
  const btn = $('#download');
  btn.disabled = picked.length === 0;
  btn.textContent = picked.length ? `${picked.length} 件をダウンロード` : 'ダウンロード';

  const empty = $('#empty');
  if (!state.items.length) {
    empty.hidden = false;
    empty.textContent = 'ファイルが見つかりませんでした。\n添付ファイルの一覧を画面に表示してから「再スキャン」を押してください。\nクリックしないと出てこないファイルは、一度開くと「通信」として記録されます。';
    empty.style.whiteSpace = 'pre-line';
  } else if (!vis.length) {
    empty.hidden = false;
    empty.textContent = '絞り込みの条件に合うファイルがありません。';
  } else {
    empty.hidden = true;
  }
}

function renderCats() {
  const box = $('#cats');
  box.textContent = '';
  const counts = {};
  for (const it of state.items) counts[it.category] = (counts[it.category] || 0) + 1;
  for (const c of ADL.CATEGORIES) {
    if (!counts[c.key]) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${state.cats.has(c.key) ? ' on' : ''}`;
    b.textContent = c.label;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = counts[c.key];
    b.append(n);
    b.addEventListener('click', () => {
      state.cats.has(c.key) ? state.cats.delete(c.key) : state.cats.add(c.key);
      chrome.storage.local.set({ cats: [...state.cats] });
      render();
    });
    box.append(b);
  }
}

function renderRow(it) {
  const blocked = isBlocked(it);
  const li = document.createElement('li');
  li.className = `item${it.guess ? ' guess' : ''}${blocked ? ' disabled' : ''}`;
  li.title = it.url.startsWith('data:') ? `${it.url.slice(0, 80)}…` : it.url;

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(it.url);
  cb.disabled = blocked;
  cb.addEventListener('change', () => {
    cb.checked ? state.selected.add(it.url) : state.selected.delete(it.url);
    render();
  });

  const badge = document.createElement('span');
  badge.className = `badge cat-${it.category}`;
  badge.textContent = (it.ext || '?').toUpperCase();

  const main = document.createElement('div');
  main.className = 'main';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name;
  const meta = document.createElement('div');
  meta.className = 'meta';

  for (const s of it.sources || [it.source]) meta.append(tag(SOURCE_LABEL[s] || s));
  if (it.guess) meta.append(tag('推定', true));
  if (blocked) meta.append(tag(`${it.method} のため取得不可`, true));
  const parts = [];
  if (it.label && it.label !== it.name) parts.push(it.label);
  if (it.size) parts.push(ADL.formatSize(it.size));
  parts.push(shortUrl(it.src || it.url));
  meta.append(document.createTextNode(parts.join(' · ')));

  main.append(name, meta);
  label.append(cb, badge, main);
  li.append(label);
  return li;
}

function tag(text, warn) {
  const t = document.createElement('span');
  t.className = `tag${warn ? ' warn' : ''}`;
  t.textContent = text;
  return t;
}

function shortUrl(u) {
  if (u.startsWith('blob:')) return 'ページ内で作られたファイル';
  if (u.startsWith('data:')) return 'ページ内で作られたファイル';
  try {
    const x = new URL(u);
    return ADL.safeDecode(x.host + x.pathname + x.search);
  } catch {
    return u;
  }
}

function showNotice(text) {
  const n = $('#notice');
  n.textContent = text;
  n.hidden = !text;
}

// ---------- ダウンロード ----------

function expandFolder(tpl) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let host = 'page';
  try { host = new URL(state.tab.url).hostname || host; } catch { /* 無視 */ }
  return tpl
    .replace(/\{host\}/g, host)
    .replace(/\{date\}/g, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replace(/\{title\}/g, (state.tab.title || '').slice(0, 40));
}

async function startDownload() {
  const chosen = visibleItems().filter((it) => state.selected.has(it.url) && !isBlocked(it));
  if (!chosen.length) return;
  const folder = $('#useFolder').checked ? expandFolder($('#folder').value.trim()) : '';
  const btn = $('#download');
  btn.disabled = true;
  setStatus(`${chosen.length} 件のダウンロードを始めています…`);

  const results = [];
  const normal = chosen.filter((it) => !it.url.startsWith('blob:'));
  const generated = chosen.filter((it) => it.url.startsWith('blob:'));

  if (normal.length) {
    const r = await chrome.runtime.sendMessage({
      type: 'downloadUrls',
      folder,
      // ページ上の表示名やダウンロード名が分かっているものだけ名前を指定し、それ以外はブラウザに任せる
      items: normal.map((it) => ({ url: it.url, name: it.nameRank >= 3 ? it.name : '', method: 'GET' })),
    });
    if (Array.isArray(r)) r.forEach((x, i) => results.push({ ...x, name: normal[i].name }));
    else results.push(...normal.map((it) => ({ url: it.url, name: it.name, ok: false, error: (r && r.error) || '応答なし' })));
  }

  for (const it of generated) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, frameIds: [it.frameId || 0] },
        func: (u, n, f) => globalThis.__adlDownloadBlob(u, n, f),
        args: [it.url, it.name, folder],
      });
      results.push({ url: it.url, name: it.name, ...((r && r.result) || { ok: false, error: '応答なし' }) });
    } catch (e) {
      results.push({ url: it.url, name: it.name, ok: false, error: e.message });
    }
  }

  btn.disabled = false;
  watchProgress(results);
}

function setStatus(text, failures = []) {
  const s = $('#status');
  s.textContent = '';
  const line = document.createElement('div');
  line.textContent = text;
  s.append(line);
  if (failures.length) {
    const ul = document.createElement('ul');
    for (const f of failures.slice(0, 8)) {
      const li = document.createElement('li');
      li.className = 'err';
      li.textContent = `${f.name}：${f.error}`;
      ul.append(li);
    }
    if (failures.length > 8) {
      const li = document.createElement('li');
      li.textContent = `ほか ${failures.length - 8} 件`;
      ul.append(li);
    }
    s.append(ul);
  }
}

// 開始したダウンロードの進み具合を、ポップアップを開いている間だけ表示する
async function watchProgress(results) {
  const started = Date.now();
  const failedAtStart = results.filter((r) => !r.ok);
  const tracked = results.filter((r) => r.ok && r.id);
  const untracked = results.filter((r) => r.ok && !r.id).length;

  for (;;) {
    let done = 0;
    let running = 0;
    const failed = [...failedAtStart];
    for (const r of tracked) {
      const [d] = await chrome.downloads.search({ id: r.id });
      if (!d) continue;
      if (d.state === 'complete') done++;
      else if (d.state === 'interrupted') failed.push({ name: r.name, error: ERROR_LABEL[d.error] || d.error || '中断' });
      else running++;
    }
    const parts = [`完了 ${done} 件`];
    if (running) parts.push(`進行中 ${running} 件`);
    if (untracked) parts.push(`ブラウザに引き渡し ${untracked} 件`);
    if (failed.length) parts.push(`失敗 ${failed.length} 件`);
    setStatus(parts.join('・'), failed);
    $('#status').firstChild.className = failed.length ? 'err' : running ? '' : 'ok';
    if (!running || Date.now() - started > 120000) break;
    await new Promise((r) => setTimeout(r, 700));
  }
}
