/*
 * local/backup.js — Ayarlar paneline "Yedekleme" satırı ekler.
 *
 * Dışa aktarma tüm store'u tek bir JSON dosyasına indirir; içe aktarma aynı
 * dosyayı geri yükler. Biçim iCloud aynasıyla (~/.hexpane-sync) aynı:
 *
 *   { app, format, exportedAt, screens, storage: { "ihp:local:v1": {...} } }
 *
 * Yani aynadan alınan dosya buradan da yüklenebilir, bunun ürettiği dosya da
 * aynanınkiyle değiştirilebilir.
 *
 * Uygulama React ile render ediliyor ve panel her açılışta yeniden kuruluyor,
 * o yüzden satır bir MutationObserver ile ısrarla yerine konuyor. Sınıf adları
 * uygulamanın kendi satırlarından alındı ki görünüm birebir otursun; bunlar
 * emotion hash'leri, yani bundle yeniden derlenirse güncellenmeleri gerekir.
 */
(function () {
  'use strict';

  var HOST = '.css-m6q98p';          // ayarlar satırlarının kapsayıcısı
  var ROW = 'css-1y3f6ad';           // "Dil" satırıyla aynı yerleşim
  var LABEL = 'css-1syf81g';
  var BTN = 'chakra-button css-1upvgh3';
  var MARK = 'ihp-backup-row';

  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function flash(btn, text) {
    var old = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 2000);
  }

  function exportBackup(btn) {
    var db = window.__ihpLocal && window.__ihpLocal.dump();
    if (!db) { flash(btn, 'Hata'); return; }

    var payload = {
      app: 'hexpane-extension',
      format: 1,
      exportedAt: new Date().toISOString(),
      screens: db.apps.length,
      shortcuts: db.apps.reduce(function (n, row) { return n + row.length; }, 0),
      storage: { 'ihp:local:v1': db }
    };

    var url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'hexpane-yedek-' + stamp() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function importBackup(btn) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var payload;
        try { payload = JSON.parse(reader.result); }
        catch (e) { flash(btn, 'Geçersiz dosya'); input.remove(); return; }
        // restore() hem {storage:{...}} sarmalını hem düz store'u kabul eder ve
        // yazma bittikten sonra sayfayı yeniler.
        window.__ihpLocal.restore(payload).catch(function () {
          flash(btn, 'Geçersiz yedek');
        });
        input.remove();
      };
      reader.onerror = function () { flash(btn, 'Okunamadı'); input.remove(); };
      reader.readAsText(file);
    };
    document.body.appendChild(input);
    input.click();
  }

  function button(text, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = BTN;
    b.textContent = text;
    b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  function buildRow() {
    var row = document.createElement('div');
    row.className = ROW + ' ' + MARK;

    var label = document.createElement('div');
    label.className = LABEL;
    label.textContent = 'Yedekleme';

    var actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.appendChild(button('Dışa aktar', exportBackup));
    actions.appendChild(button('İçe aktar', importBackup));

    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  function ensure() {
    var host = document.querySelector(HOST);
    if (!host || host.querySelector('.' + MARK)) return;
    host.appendChild(buildRow());
  }

  new MutationObserver(ensure).observe(document.documentElement, { childList: true, subtree: true });
  ensure();
})();
