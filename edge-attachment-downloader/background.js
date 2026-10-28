// バックグラウンド処理
// - 通信を見張り、ファイルらしい応答（添付指定・PDF・Office・ZIP など）をタブごとに記録する
// - ポップアップの依頼でダウンロードし、保存名と保存フォルダを整える
importScripts('common.js');

const MAX_PER_TAB = 300;
const PENDING_TTL = 2 * 60 * 1000;

// 調べなくてよい種類の通信（画面表示用の画像・CSS・スクリプトなど）
const SKIP_TYPES = new Set([
  'image', 'imageset', 'stylesheet', 'script', 'font', 'media', 'websocket',
  'ping', 'csp_report', 'webtransport', 'webbundle',
]);
// ファイルとみなす Content-Type
const FILE_MIME = /^(application\/(pdf|zip|x-zip-compressed|x-7z-compressed|x-rar-compressed|vnd\.rar|gzip|x-gzip|x-tar|x-lzh-compressed|x-lzh|msword|rtf|csv|vnd\.ms-|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument)|text\/(csv|rtf|tab-separated-values)|message\/rfc822)/i;
const BINARY_MIME = /^(application\/(octet-stream|force-download|x-download|download)|binary\/octet-stream)$/i;
const NOT_FILE_MIME = /^(text\/(html|javascript|css)|application\/(json|javascript|x-javascript|xml|.*\+json|.*\+xml))/i;

// ---------- 通信の記録 ----------

const captured = new Map(); // tabId -> 記録の配列
const saveTimers = new Map();
const storageKey = (tabId) => `cap_${tabId}`;

async function getList(tabId) {
  if (captured.has(tabId)) return captured.get(tabId);
  const got = await chrome.storage.session.get(storageKey(tabId));
  // 読み込み待ちの間に別の処理が作っていれば、そちらを使う
  const list = captured.get(tabId) || got[storageKey(tabId)] || [];
  captured.set(tabId, list);
  return list;
}

function scheduleSave(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(() => {
    saveTimers.delete(tabId);
    const list = captured.get(tabId);
    if (list) chrome.storage.session.set({ [storageKey(tabId)]: list }).catch(() => {});
  }, 300));
}

async function resetTab(tabId) {
  captured.set(tabId, []);
  clearTimeout(saveTimers.get(tabId));
  await chrome.storage.session.remove(storageKey(tabId));
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => { handleResponse(d).catch(() => {}); },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

async function handleResponse(d) {
  if (d.tabId < 0 || SKIP_TYPES.has(d.type)) return;
  if (d.statusCode < 200 || d.statusCode >= 300) return;

  const h = {};
  for (const x of d.responseHeaders || []) {
    // UTF-8 で表せないヘッダー（Shift_JIS のファイル名など）は binaryValue で届く
    h[x.name.toLowerCase()] = x.value !== undefined
      ? x.value
      : String.fromCharCode(...(x.binaryValue || []));
  }
  const ct = (h['content-type'] || '').split(';')[0].trim().toLowerCase();
  const cd = h['content-disposition'] || '';
  const isAttachment = /^\s*attachment/i.test(cd);
  const cdName = ADL.filenameFromDisposition(cd);
  const size = parseInt(h['content-length'], 10) || 0;

  // 別のページへ移ったら、そのタブの記録をリセット
  if (d.type === 'main_frame' && !isAttachment) await resetTab(d.tabId);

  let url;
  try { url = new URL(d.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  url.hash = '';
  const urlExt = ADL.extOf(ADL.baseName(url.href));

  let guess = false;
  if (isAttachment || ADL.extOf(cdName)) {
    // 添付として返された・ファイル名付き → ファイル
  } else if (FILE_MIME.test(ct)) {
    // PDF・Office・ZIP など → ファイル
  } else if (BINARY_MIME.test(ct)) {
    if (!urlExt) {
      if (size && size < 20 * 1024) return;
      guess = true;
    }
  } else if (urlExt && !NOT_FILE_MIME.test(ct) && !['image', 'media'].includes(ADL.categoryOf(urlExt))) {
    // 拡張子がファイル（.xlsx など）で、HTML や JSON ではない
  } else {
    return;
  }

  const ext = ADL.extOf(cdName) || urlExt || ADL.extFromMime(ct);
  const item = {
    url: url.href,
    source: 'net',
    method: d.method,
    requestType: d.type,
    name: cdName || ADL.baseName(url.href) || url.hostname,
    nameRank: cdName ? 2 : 1,
    ext,
    category: ADL.categoryOf(ext),
    size,
    contentType: ct,
    guess,
    time: Date.now(),
  };

  const list = await getList(d.tabId);
  const i = list.findIndex((x) => x.url === item.url && x.method === item.method);
  if (i >= 0) list.splice(i, 1);
  list.push(item);
  if (list.length > MAX_PER_TAB) list.splice(0, list.length - MAX_PER_TAB);
  scheduleSave(d.tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  captured.delete(tabId);
  chrome.storage.session.remove(storageKey(tabId)).catch(() => {});
});

// ---------- ダウンロード ----------

// これから始まるダウンロードに付ける「保存名・フォルダ」の予約（URL ごと）
const pending = new Map(); // url -> [{ name, folder, time }]

function addPending(url, entry) {
  entry.time = Date.now();
  const q = pending.get(url) || [];
  q.push(entry);
  pending.set(url, q);
}

function takePending(item) {
  const now = Date.now();
  for (const [u, q] of pending) {
    const alive = q.filter((e) => now - e.time < PENDING_TTL);
    if (alive.length) pending.set(u, alive); else pending.delete(u);
  }
  if (item.byExtensionId !== chrome.runtime.id) return null;
  for (const u of [item.url, item.finalUrl]) {
    const q = u && pending.get(u);
    if (!q || !q.length) continue;
    const entry = q.shift();
    if (!q.length) pending.delete(u);
    return entry;
  }
  return null;
}

function removePending(url, entry) {
  const q = pending.get(url);
  if (!q) return;
  const i = q.indexOf(entry);
  if (i >= 0) q.splice(i, 1);
  if (!q.length) pending.delete(url);
}

function buildPath(name, folder) {
  const dir = ADL.sanitizeFolder(folder);
  return dir ? `${dir}/${name}` : name;
}

// 保存名を決める：指定名があればそれ、無ければブラウザが判断した名前。拡張子が無ければ補う
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const entry = takePending(item);
  if (!entry) return; // この拡張機能が関わらないダウンロードには何もしない
  const suggested = String(item.filename || '').split(/[\\/]/).pop();
  let name = ADL.sanitizeName(entry.name || suggested);
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
    const ext = (/\.([a-z0-9]{1,8})$/i.exec(suggested) || [])[1] || ADL.extFromMime(item.mime);
    if (ext) name += `.${ext}`;
  }
  suggest({ filename: buildPath(name, entry.folder), conflictAction: 'uniquify' });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadUrls(items, folder) {
  const results = [];
  for (const it of items) {
    const method = String(it.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      results.push({ url: it.url, ok: false, error: `${method} 送信で返されたファイルのため、取り直せません` });
      continue;
    }
    const entry = { name: it.name || '', folder };
    addPending(it.url, entry);
    try {
      const id = await chrome.downloads.download({ url: it.url, conflictAction: 'uniquify', saveAs: false });
      results.push({ url: it.url, ok: true, id });
    } catch (e) {
      removePending(it.url, entry);
      results.push({ url: it.url, ok: false, error: String((e && e.message) || e) });
    }
    await sleep(150); // サーバーに一度に負荷をかけない
  }
  return results;
}

// ページ内で作られたファイル（Blob URL / data URL）を、名前を指定して保存
// ※ 保存名を決めるリスナーがあると download() の filename 指定は無視されるため、予約方式で渡す
async function downloadNamed(msg) {
  const entry = { name: msg.filename || '', folder: msg.folder || '' };
  addPending(msg.url, entry);
  try {
    const id = await chrome.downloads.download({ url: msg.url, conflictAction: 'uniquify', saveAs: false });
    return { ok: true, id };
  } catch (e) {
    removePending(msg.url, entry);
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    getCaptured: () => getList(msg.tabId),
    clearCaptured: () => resetTab(msg.tabId).then(() => true),
    downloadUrls: () => downloadUrls(msg.items || [], msg.folder || ''),
    downloadNamed: () => downloadNamed(msg),
  };
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(fn)
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
