/**
 * Web app entry point and the API called from the browser via google.script.run.
 *
 * Every write goes through withLock_(): two staff members scanning the same PC
 * at the same moment must not both succeed. Errors are returned as values, not
 * thrown, so the UI can show business-rule messages ("上限に達しています")
 * instead of a generic script error.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('PC貸出管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function openDb_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    devices: new SheetTable(SHEETS.DEVICES, ss),
    loans: new SheetTable(SHEETS.LOANS, ss),
    users: new SheetTable(SHEETS.USERS, ss),
    holidays: new SheetTable(SHEETS.HOLIDAYS, ss),
    settings: new SheetTable(SHEETS.SETTINGS, ss),
    audit: new SheetTable(SHEETS.AUDIT, ss),
  };
}

function service_() {
  return new LendingService(openDb_());
}

function currentEmail_() {
  // Requires the web app to be deployed with access limited to the Workspace domain.
  var email = Session.getActiveUser().getEmail();
  if (!email) throw new LendingError('ログインユーザーを取得できません（組織内からアクセスしてください）');
  return email;
}

function respond_(fn) {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof LendingError) return { ok: false, error: e.message };
    console.error(e && e.stack ? e.stack : e);
    return { ok: false, error: 'システムエラーが発生しました。時間をおいて再度お試しください。' };
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new LendingError('混み合っています。数秒後に再度お試しください');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------- browser API */

function apiBootstrap() {
  return respond_(function () {
    var svc = service_();
    var me = svc.requireUser_(currentEmail_());
    return {
      me: { email: me.email, name: me.name, role: me.role },
      devices: svc.listDevices(),
      myLoans: svc.loansOf(me.email),
      settings: { loanBusinessDays: svc.settings().loanBusinessDays },
    };
  });
}

function apiCheckout(req) {
  return respond_(function () {
    return withLock_(function () { return service_().checkout(currentEmail_(), req); });
  });
}

function apiReturn(req) {
  return respond_(function () {
    return withLock_(function () { return service_().receiveReturn(currentEmail_(), req); });
  });
}

function apiExtend(req) {
  return respond_(function () {
    return withLock_(function () { return service_().extend(currentEmail_(), req); });
  });
}
