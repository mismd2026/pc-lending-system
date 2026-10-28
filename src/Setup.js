/**
 * One-time setup and the spreadsheet menu.
 * setup() is idempotent: it creates missing sheets and headers and never
 * deletes existing data, so it is safe to run again after a schema change.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PC貸出管理')
    .addItem('初期セットアップ', 'setup')
    .addItem('通知トリガーを設定', 'installTriggers')
    .addItem('延滞チェックを今すぐ実行', 'dailyCheck')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (k) {
    var def = SHEETS[k];
    var sheet = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    var header = sheet.getRange(1, 1, 1, def.columns.length);
    header.setValues([def.columns]).setFontWeight('bold').setBackground('#e8eef7');
    sheet.setFrozenRows(1);
  });

  // Dropdowns stop typos like "貸し出し可" that would silently break status checks.
  var statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(DEVICE_STATUS).map(function (k) { return DEVICE_STATUS[k]; }), true)
    .setAllowInvalid(false).build();
  ss.getSheetByName(SHEETS.DEVICES.name).getRange('E2:E').setDataValidation(statusRule);

  var roleRule = SpreadsheetApp.newDataValidation()
    .requireValueInList([ROLES.ADMIN, ROLES.STAFF, ROLES.USER], true)
    .setAllowInvalid(false).build();
  ss.getSheetByName(SHEETS.USERS.name).getRange('D2:D').setDataValidation(roleRule);

  var settings = new SheetTable(SHEETS.SETTINGS, ss);
  var existing = {};
  settings.all().forEach(function (r) { existing[r.key] = true; });
  DEFAULT_SETTINGS.forEach(function (d) {
    if (!existing[d[0]]) settings.append({ key: d[0], value: d[1], description: d[2] });
  });

  // The audit log is append-only for everyone except the owner.
  var audit = ss.getSheetByName(SHEETS.AUDIT.name);
  var protection = audit.protect().setDescription('監査ログ（編集不可）');
  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}
