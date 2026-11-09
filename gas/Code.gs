/**
 * Винил бара — серверная часть (Google Apps Script).
 * Вставляется в таблицу с винилом: «Расширения → Apps Script».
 * Отдаёт приложению список пластинок из листа «Полная коллекция»
 * и проверяет, кто из открывших приложение — сотрудник (лист «Сотрудники»).
 */

// ===================== НАСТРОЙКИ =====================
// Токен бота из @BotFather (/mybots → бот → API Token). Нужен, чтобы проверить,
// что приложение открыто из Telegram и кем именно.
var BOT_TOKEN = 'ВСТАВЬ_ТОКЕН_БОТА';
// Название листа с пластинками
var CATALOG_SHEET = 'Полная коллекция';
// Лист со списком сотрудников (создаётся сам при запуске checkSetup)
var STAFF_SHEET = 'Сотрудники';
// =====================================================

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var user = verifyInitData_(body.initData);
    if (!user) return json_({ ok: false, error: 'not telegram' });
    if (body.action === 'me') return json_({ ok: true, isStaff: isStaff_(user) });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

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

// ---------- Сотрудники ----------

function staffSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(STAFF_SHEET);
  if (!sh) {
    sh = ss.insertSheet(STAFF_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['Имя', 'Telegram (@username или ID)', 'Заметка']]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidths(1, 3, 220);
  }
  return sh;
}

/** Список сотрудников: @username (без регистра) и числовые ID. Кешируется на минуту. */
function staffList_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('staff');
  if (hit) return JSON.parse(hit);
  var sh = staffSheet_();
  var last = sh.getLastRow();
  var list = last < 2 ? [] : sh.getRange(2, 2, last - 1, 1).getDisplayValues()
    .map(function (r) { return String(r[0]).trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').toLowerCase(); })
    .filter(Boolean);
  cache.put('staff', JSON.stringify(list), 60);
  return list;
}

function isStaff_(user) {
  var list = staffList_();
  return list.indexOf(String(user.id)) !== -1 ||
    (user.username ? list.indexOf(String(user.username).toLowerCase()) !== -1 : false);
}

/** Проверка подписи Telegram: данные действительно пришли из Telegram и не подделаны. */
function verifyInitData_(initData) {
  if (!initData || BOT_TOKEN.indexOf('ВСТАВЬ') === 0) return null;
  var params = {};
  String(initData).split('&').forEach(function (pair) {
    var i = pair.indexOf('=');
    if (i > 0) params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  });
  var hash = params.hash;
  if (!hash) return null;
  delete params.hash;
  var check = Object.keys(params).sort().map(function (k) { return k + '=' + params[k]; }).join('\n');
  var secret = Utilities.computeHmacSha256Signature(Utilities.newBlob(BOT_TOKEN).getBytes(), Utilities.newBlob('WebAppData').getBytes());
  var sig = Utilities.computeHmacSha256Signature(Utilities.newBlob(check).getBytes(), secret);
  var hex = sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  if (hex !== hash) return null;
  if (Date.now() / 1000 - Number(params.auth_date || 0) > 7 * 86400) return null;
  return JSON.parse(params.user || 'null');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Запусти вручную из редактора (кнопка ▶), чтобы проверить, что таблица читается. */
function checkSetup() {
  var list = getCatalog_(true);
  Logger.log('Пластинок в каталоге: ' + list.length);
  if (list.length) Logger.log('Первая: ' + list[0].artist + ' — ' + list[0].album + ' (' + list[0].shelf + ')');
  staffSheet_();
  CacheService.getScriptCache().remove('staff');
  Logger.log('Сотрудников в листе «' + STAFF_SHEET + '»: ' + staffList_().length);
  if (BOT_TOKEN.indexOf('ВСТАВЬ') === 0) {
    Logger.log('⚠️ Не вписан BOT_TOKEN — раздел для барменов не откроется');
  } else {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getMe', { muteHttpExceptions: true });
    var me = JSON.parse(res.getContentText());
    Logger.log(me.ok ? 'Бот на связи: @' + me.result.username : '⚠️ Токен не подходит: ' + me.description);
  }
}
