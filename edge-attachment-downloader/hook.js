// ページ側（MAIN world）で動く小さな見張り役
// JavaScript がその場で作ったファイル（Blob）を覚えておき、拡張機能から頼まれたら渡す。
// ページの動きを邪魔しないよう、元の処理は必ずそのまま呼ぶ。
(() => {
  const FLAG = Symbol.for('__adl_hooked__');
  if (window[FLAG]) return;
  window[FLAG] = true;

  const TAG = '__adl_ext__';
  const MAX_KEEP = 60;
  const MIN_SIZE = 512;
  const MIN_IMAGE_SIZE = 30 * 1024; // 小さい画像はアイコン・サムネイルとみなして無視
  const SKIP_TYPE = /^(text\/(javascript|css|html)|application\/(javascript|x-javascript|ecmascript|wasm|json))/i;

  const store = new Map(); // Blob URL -> Blob
  const origin = new WeakMap(); // Blob -> { cd: Content-Disposition, src: 取得元 URL }
  const post = (data) => {
    try { window.postMessage(Object.assign({ [TAG]: true }, data), '*'); } catch { /* 無視 */ }
  };

  // fetch() で受け取ったファイルの「サーバーが付けた名前」を覚えておく
  const origBlob = Response.prototype.blob;
  Response.prototype.blob = function () {
    const res = this;
    return origBlob.apply(this, arguments).then((b) => {
      try { origin.set(b, { cd: res.headers.get('content-disposition') || '', src: res.url || '' }); } catch { /* 無視 */ }
      return b;
    });
  };

  // XMLHttpRequest（responseType = 'blob'）で受け取った場合も同様
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    try {
      this.addEventListener('readystatechange', function () {
        try {
          if (this.readyState === 4 && this.responseType === 'blob' && this.response instanceof Blob) {
            origin.set(this.response, { cd: this.getResponseHeader('content-disposition') || '', src: this.responseURL || '' });
          }
        } catch { /* 無視 */ }
      });
    } catch { /* 無視 */ }
    return origOpen.apply(this, arguments);
  };

  const origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreate.apply(this, arguments);
    try {
      if (obj instanceof Blob && obj.size >= MIN_SIZE && !SKIP_TYPE.test(obj.type)
        && !(/^image\//i.test(obj.type) && obj.size < MIN_IMAGE_SIZE)) {
        store.set(url, obj);
        if (store.size > MAX_KEEP) store.delete(store.keys().next().value);
        const o = origin.get(obj) || {};
        post({
          kind: 'blob', url, size: obj.size, type: obj.type,
          name: obj instanceof File ? obj.name : '', cd: o.cd || '', src: o.src || '',
        });
      }
    } catch { /* 無視 */ }
    return url;
  };

  // a.download = "名前"; a.click() で保存させる作りのページから、ファイル名を拾う
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      const name = this.getAttribute('download');
      if (name && this.href) post({ kind: 'anchor', url: this.href, name });
    } catch { /* 無視 */ }
    return origClick.apply(this, arguments);
  };

  // 拡張機能（content.js）からの「この Blob をください」に応える
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d[TAG] !== true || d.kind !== 'getBlob') return;
    post({ kind: 'blobData', reqId: d.reqId, blob: store.get(d.url) || null });
  });
})();
