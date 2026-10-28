'use strict';
/**
 * Runs the Apps Script sources in a Node vm context with in-memory fakes of
 * SpreadsheetApp, MailApp, LockService, Session, Utilities and ScriptApp.
 * The production code is loaded unmodified — the same files `clasp push` uploads.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const LOAD_ORDER = ['Config.js', 'SheetTable.js', 'LendingService.js', 'Code.js', 'Triggers.js', 'Setup.js'];

/** Chainable no-op used for formatting calls (setFontWeight, protect, ...) we don't assert on. */
function chain() {
  const p = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'getEditors' ? () => [] : prop === 'canDomainEdit' ? () => false : p),
    apply: () => p,
  });
  return p;
}

class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((r) => r.slice());
    this.writes = 0;
  }
  getDataRange() {
    return { getValues: () => this.rows.map((r) => r.slice()) };
  }
  appendRow(row) {
    this.rows.push(row.slice());
    this.writes++;
  }
  getRange(row, col, numRows, numCols) {
    if (typeof row === 'string') return chain();
    const sheet = this;
    return {
      setValues(values) {
        for (let i = 0; i < numRows; i++) {
          while (sheet.rows.length < row + i) sheet.rows.push([]);
          const target = sheet.rows[row - 1 + i];
          for (let j = 0; j < numCols; j++) target[col - 1 + j] = values[i][j];
        }
        sheet.writes++;
        return chain();
      },
      getValues: () => sheet.rows.slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
    };
  }
  setFrozenRows() {}
  protect() { return chain(); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); }
}

/**
 * @param {object} opts
 * @param {Date} opts.now        mutable through ctx.setNow()
 * @param {string} opts.user     email returned by Session.getActiveUser()
 */
function loadGas(opts = {}) {
  const ss = new FakeSpreadsheet();
  const mail = [];
  let now = opts.now || new Date(2026, 10, 2, 10, 0); // Mon 2026-11-02 10:00 JST
  let user = opts.user || '';
  let lockFree = true;
  let seq = 0;

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    JSON, Math, Date, Object, String, Number, Array, Error, isNaN, Proxy,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => chain(),
      newDataValidation: () => chain(),
    },
    MailApp: {
      getRemainingDailyQuota: () => 100,
      sendEmail: (m) => mail.push(m),
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => lockFree, releaseLock() {} }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => user }) },
    Utilities: { getUuid: () => 'loan-' + String(++seq).padStart(4, '0') },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => chain(), WeekDay: {} },
    HtmlService: chain(),
  };
  vm.createContext(ctx);
  for (const f of LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }

  // Build the sheets exactly as setup() would.
  ctx.setup();
  return Object.assign(ctx, {
    ss, mail,
    sheet: (key) => ss.getSheetByName(ctx.SHEETS[key].name),
    seed(key, objects) {
      const table = new ctx.SheetTable(ctx.SHEETS[key], ss);
      objects.forEach((o) => table.append(o));
    },
    svc: () => new ctx.LendingService(ctx.openDb_(), () => new Date(now)),
    setNow: (d) => { now = d; },
    setUser: (u) => { user = u; },
    setLockFree: (b) => { lockFree = b; },
  });
}

module.exports = { loadGas, FakeSheet };
