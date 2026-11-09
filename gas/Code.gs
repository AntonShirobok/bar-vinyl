/**
 * Винил бара — серверная часть (Google Apps Script).
 * Вставляется в таблицу с винилом: «Расширения → Apps Script».
 * Отдаёт приложению список пластинок из листа «Полная коллекция».
 */

// Название листа с пластинками
var CATALOG_SHEET = 'Полная коллекция';

function doGet(e) {
  try {
    var fresh = e && e.parameter && e.parameter.fresh === '1';
    return json_({ ok: true, records: getCatalog_(fresh) });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function getCatalog_(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get('catalog');
    if (hit) return JSON.parse(hit);
  }
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(CATALOG_SHEET) || ss.getSheets()[0];
  var rows = sh.getDataRange().getDisplayValues();
  var out = [], shelfNo = 0, started = false;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!started) { if (String(r[1]).trim() === 'Исполнитель') started = true; continue; }
    var num = String(r[0]).trim(), artist = String(r[1]).trim(), album = String(r[2]).trim();
    if (/^\d+\.\s/.test(num) && !artist) { shelfNo++; continue; } // строка-заголовок полки
    if (!artist && !album) continue;
    var year = parseInt(r[3], 10);
    out.push({
      shelfNo: shelfNo, n: num, artist: artist, album: album,
      year: isNaN(year) ? null : year,
      genre: String(r[4]).trim(), bpm: String(r[5]).trim(), shelf: String(r[6]).trim(),
    });
  }
  try { cache.put('catalog', JSON.stringify(out), 300); } catch (e) { /* слишком большой — не кешируем */ }
  return out;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Запусти вручную из редактора (кнопка ▶), чтобы проверить, что таблица читается. */
function checkSetup() {
  var list = getCatalog_(true);
  Logger.log('Пластинок в каталоге: ' + list.length);
  if (list.length) Logger.log('Первая: ' + list[0].artist + ' — ' + list[0].album + ' (' + list[0].shelf + ')');
}
