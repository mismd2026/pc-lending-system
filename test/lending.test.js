'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./gas-harness');

const ADMIN = 'admin@example.co.jp';
const STAFF = 'desk@example.co.jp';
const ALICE = 'alice@example.co.jp';
const BOB = 'bob@example.co.jp';

let gas;

const d = (y, m, day, h = 10) => new Date(y, m - 1, day, h, 0);

beforeEach(() => {
  gas = loadGas({ now: d(2026, 11, 2) }); // Monday
  gas.seed('USERS', [
    { email: ADMIN, name: '管理者', department: '情シス', role: 'admin', maxLoans: 3 },
    { email: STAFF, name: '窓口', department: '情シス', role: 'staff', maxLoans: 3 },
    { email: ALICE, name: '山田', department: '営業', role: 'user', maxLoans: 1 },
    { email: BOB, name: '佐藤', department: '総務', role: 'user', maxLoans: 2 },
  ]);
  gas.seed('DEVICES', [
    { assetTag: 'PC-0001', model: 'ThinkPad X1', category: 'ノートPC', status: '貸出可', location: '本社3F' },
    { assetTag: 'PC-0002', model: 'ThinkPad X1', category: 'ノートPC', status: '貸出可', location: '本社3F' },
    { assetTag: 'PC-0003', model: 'MacBook Air', category: 'ノートPC', status: '修理中', location: '本社3F' },
    { assetTag: 'PC-0099', model: '旧機種', category: 'ノートPC', status: '廃棄', location: '倉庫' },
  ]);
  gas.seed('HOLIDAYS', [{ date: d(2026, 11, 3, 0), name: '文化の日' }]);
  gas.seed('SETTINGS', [{ key: 'adminEmail', value: ADMIN, description: '' }]);
});

/* ------------------------------------------------------------ checkout */

test('checkout: due date skips weekends and holidays, updates ledger and audit log', () => {
  const r = gas.svc().checkout(ALICE, { assetTag: 'pc-0001', purpose: '出張' });
  // 10 business days from Mon 11/2, skipping 11/3 (holiday) and two weekends
  assert.equal(r.dueDate, '2026-11-17');
  assert.equal(r.assetTag, 'PC-0001');

  const device = gas.sheet('DEVICES').rows.find((row) => row[0] === 'PC-0001');
  assert.equal(device[4], '貸出中');
  const audit = gas.sheet('AUDIT').rows.slice(1);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0][1], audit[0][2], audit[0][3]], [ALICE, 'CHECKOUT', 'PC-0001']);
});

test('checkout: users cannot borrow on behalf of others, staff can', () => {
  assert.throws(
    () => gas.svc().checkout(ALICE, { assetTag: 'PC-0001', borrowerEmail: BOB, purpose: 'x' }),
    /権限がありません/,
  );
  const r = gas.svc().checkout(STAFF, { assetTag: 'PC-0001', borrowerEmail: BOB, purpose: '研修' });
  const loan = gas.svc().db.loans.find((l) => l.loanId === r.loanId);
  assert.equal(loan.borrowerEmail, BOB);
  assert.equal(loan.handledBy, STAFF);
});

test('checkout: rejects unknown, unavailable, unregistered and incomplete requests', () => {
  const svc = gas.svc();
  assert.throws(() => svc.checkout(ALICE, { assetTag: 'PC-9999', purpose: 'x' }), /見つかりません/);
  assert.throws(() => svc.checkout(ALICE, { assetTag: 'PC-0003', purpose: 'x' }), /修理中/);
  assert.throws(() => svc.checkout(ALICE, { assetTag: 'PC-0001', purpose: '  ' }), /利用目的/);
  assert.throws(() => svc.checkout('stranger@example.com', { assetTag: 'PC-0001', purpose: 'x' }), /登録されていません/);
  assert.throws(() => svc.checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x', businessDays: 30 }), /1〜20営業日/);
});

test('checkout: enforces per-user limit and blocks users with overdue loans', () => {
  gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x' });
  assert.throws(() => gas.svc().checkout(ALICE, { assetTag: 'PC-0002', purpose: 'y' }), /上限（1台）/);

  gas.svc().checkout(BOB, { assetTag: 'PC-0002', purpose: 'y', businessDays: 1 });
  gas.setNow(d(2026, 11, 6)); // Bob's loan was due 11/4
  gas.svc().receiveReturn(STAFF, { assetTag: 'PC-0001' }); // free a device
  assert.throws(() => gas.svc().checkout(BOB, { assetTag: 'PC-0001', purpose: 'z' }), /延滞中/);
});

test('checkout: detects ledger / loan-log inconsistency instead of double lending', () => {
  gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x' });
  // someone edits the sheet by hand and sets the device back to available
  gas.sheet('DEVICES').rows.find((row) => row[0] === 'PC-0001')[4] = '貸出可';
  assert.throws(() => gas.svc().checkout(BOB, { assetTag: 'PC-0001', purpose: 'y' }), /未返却の貸出記録/);
});

/* ------------------------------------------------------------ return / extend */

test('return: only staff can receive; damaged devices go to repair; lateness is recorded', () => {
  gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x', businessDays: 2 }); // due 11/5
  gas.setNow(d(2026, 11, 9));
  assert.throws(() => gas.svc().receiveReturn(ALICE, { assetTag: 'PC-0001' }), /権限/);

  const r = gas.svc().receiveReturn(STAFF, { assetTag: 'PC-0001', condition: '要修理', note: '画面割れ' });
  assert.equal(r.lateDays, 4);
  assert.equal(r.deviceStatus, '修理中');
  const device = gas.sheet('DEVICES').rows.find((row) => row[0] === 'PC-0001');
  assert.match(device[6], /画面割れ/);
  assert.equal(gas.svc().activeLoans().length, 0);
  assert.throws(() => gas.svc().receiveReturn(STAFF, { assetTag: 'PC-0001' }), /貸出中記録がありません/);
});

test('extend: allowed within the maximum period, refused beyond it or when overdue', () => {
  const { loanId } = gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x' }); // due 11/17
  assert.equal(gas.svc().extend(ALICE, { loanId, businessDays: 5 }).dueDate, '2026-11-24');
  // max 20 business days from 11/2 => 12/1; another 10 would pass it
  assert.throws(() => gas.svc().extend(ALICE, { loanId, businessDays: 10 }), /最長貸出期間/);
  assert.throws(() => gas.svc().extend(BOB, { loanId }), /権限/);

  gas.setNow(d(2026, 11, 26));
  assert.throws(() => gas.svc().extend(ALICE, { loanId, businessDays: 1 }), /延滞中/);
});

/* ------------------------------------------------------------ notifications */

test('notifications: reminder the day before, overdue notice, single escalation, idempotent per day', () => {
  gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x', businessDays: 2 }); // due Thu 11/5

  gas.setNow(d(2026, 11, 4, 9));
  let n = gas.svc().collectNotifications();
  assert.equal(n.reminders.length, 1);
  assert.equal(gas.svc().collectNotifications().reminders.length, 0, 'second run same day sends nothing');

  gas.setNow(d(2026, 11, 6, 9));
  n = gas.svc().collectNotifications();
  assert.deepEqual([n.overdue.length, n.escalations.length], [1, 0]);

  gas.setNow(d(2026, 11, 8, 9)); // 3 days late -> escalate
  n = gas.svc().collectNotifications();
  assert.deepEqual([n.overdue.length, n.escalations.length], [1, 1]);
  assert.equal(n.escalations[0].daysLate, 3);

  gas.setNow(d(2026, 11, 9, 9));
  n = gas.svc().collectNotifications();
  assert.deepEqual([n.overdue.length, n.escalations.length], [1, 0], 'escalate only once');
});

test('dailyCheck trigger sends borrower and admin mail', () => {
  gas.svc().checkout(ALICE, { assetTag: 'PC-0001', purpose: 'x', businessDays: 1 }); // due 11/4
  gas.setNow(d(2026, 11, 9, 9));
  // dailyCheck builds its own service, so pin the clock through Date for this call
  const RealDate = Date;
  gas.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [d(2026, 11, 9, 9).getTime()])); }
  };
  try {
    gas.dailyCheck();
  } finally {
    gas.Date = RealDate;
  }
  assert.deepEqual(gas.mail.map((m) => m.to).sort(), [ADMIN, ALICE].sort());
  assert.match(gas.mail.find((m) => m.to === ADMIN).subject, /延滞エスカレーション 1件/);
});

/* ------------------------------------------------------------ web API layer */

test('API: business errors come back as messages, lock contention is reported', () => {
  gas.setUser(ALICE);
  let res = gas.apiCheckout({ assetTag: 'PC-0003', purpose: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /修理中/);

  gas.setLockFree(false);
  res = gas.apiCheckout({ assetTag: 'PC-0001', purpose: 'x' });
  assert.match(res.error, /混み合っています/);

  gas.setLockFree(true);
  res = gas.apiCheckout({ assetTag: 'PC-0001', purpose: 'x' });
  assert.equal(res.ok, true);
  const boot = gas.apiBootstrap();
  assert.equal(boot.data.me.role, 'user');
  assert.equal(boot.data.myLoans.length, 1);
  assert.ok(!boot.data.devices.some((x) => x.assetTag === 'PC-0099'), 'retired devices are hidden');
});

test('API: unexpected exceptions are not leaked to the browser', () => {
  gas.setUser(ALICE);
  gas.ss.sheets[gas.SHEETS.LOANS.name] = null; // simulate a deleted sheet
  const res = gas.apiCheckout({ assetTag: 'PC-0001', purpose: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /システムエラー/);
});

/* ------------------------------------------------------------ storage */

test('SheetTable: skips blank rows and saves back to the original row', () => {
  const sheet = gas.sheet('DEVICES');
  sheet.rows.splice(2, 0, ['', '', '', '', '', '', '', '']); // blank line in the middle
  const table = new gas.SheetTable(gas.SHEETS.DEVICES, gas.ss);
  const pc2 = table.find((r) => r.assetTag === 'PC-0002');
  assert.equal(table.all().length, 4);
  pc2.location = '大阪支社';
  table.save(pc2);
  assert.equal(sheet.rows[pc2._row - 1][5], '大阪支社');
  assert.equal(Object.keys(pc2).includes('_row'), false, '_row is not serialized');
});

test('setup is idempotent and does not duplicate settings', () => {
  const before = gas.sheet('SETTINGS').rows.length;
  gas.setup();
  assert.equal(gas.sheet('SETTINGS').rows.length, before);
});
