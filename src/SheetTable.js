/**
 * Minimal row <-> object mapper over a Google Sheet.
 *
 * Reads the whole range in ONE call (getValues) and writes single rows with
 * setValues, because each Spreadsheet service call costs ~50-100 ms and a
 * per-cell loop is the usual cause of slow GAS apps and quota errors.
 */
function SheetTable(def, spreadsheet) {
  this.def = def;
  var ss = spreadsheet || SpreadsheetApp.getActiveSpreadsheet();
  this.sheet = ss.getSheetByName(def.name);
  if (!this.sheet) throw new Error('シートがありません: ' + def.name + '（setup を実行してください）');
}

/** @return {Array<Object>} each object carries a hidden _row (1-based sheet row) */
SheetTable.prototype.all = function () {
  var values = this.sheet.getDataRange().getValues();
  var cols = this.def.columns;
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var obj = {};
    for (var c = 0; c < cols.length; c++) obj[cols[c]] = row[c] === undefined ? '' : row[c];
    Object.defineProperty(obj, '_row', { value: i + 1, enumerable: false });
    out.push(obj);
  }
  return out;
};

SheetTable.prototype.find = function (predicate) {
  var rows = this.all();
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
  return null;
};

SheetTable.prototype.filter = function (predicate) {
  return this.all().filter(predicate);
};

SheetTable.prototype.toRow_ = function (obj) {
  return this.def.columns.map(function (c) {
    return obj[c] === undefined || obj[c] === null ? '' : obj[c];
  });
};

SheetTable.prototype.append = function (obj) {
  this.sheet.appendRow(this.toRow_(obj));
  return obj;
};

/** Overwrite the row an object was read from. */
SheetTable.prototype.save = function (obj) {
  if (!obj._row) throw new Error('save() には all()/find() で取得した行が必要です');
  this.sheet.getRange(obj._row, 1, 1, this.def.columns.length).setValues([this.toRow_(obj)]);
  return obj;
};
