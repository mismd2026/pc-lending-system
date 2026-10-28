/**
 * Sheet layout and defaults.
 *
 * The spreadsheet IS the database. Column order is defined here once, so the
 * sheets can be re-created by setup() and every read/write goes through the
 * same schema.
 */
var SHEETS = {
  DEVICES: {
    name: '機器台帳',
    columns: ['assetTag', 'model', 'serial', 'category', 'status', 'location', 'notes', 'updatedAt'],
  },
  LOANS: {
    name: '貸出記録',
    columns: [
      'loanId', 'assetTag', 'borrowerEmail', 'borrowerName', 'purpose',
      'lentAt', 'dueDate', 'returnedAt', 'returnCondition', 'handledBy', 'remindedAt', 'escalatedAt',
    ],
  },
  USERS: {
    name: '利用者',
    columns: ['email', 'name', 'department', 'role', 'maxLoans'],
  },
  HOLIDAYS: {
    name: '休日',
    columns: ['date', 'name'],
  },
  SETTINGS: {
    name: '設定',
    columns: ['key', 'value', 'description'],
  },
  AUDIT: {
    name: '監査ログ',
    columns: ['timestamp', 'actor', 'action', 'target', 'detail'],
  },
};

var DEVICE_STATUS = {
  AVAILABLE: '貸出可',
  LENT: '貸出中',
  REPAIR: '修理中',
  RETIRED: '廃棄',
};

var ROLES = {
  ADMIN: 'admin', // manages devices, users and settings
  STAFF: 'staff', // IT desk: lends/receives on behalf of others
  USER: 'user', // borrows for themselves only
};

/** Defaults written to the 設定 sheet by setup(); edit the sheet, not the code. */
var DEFAULT_SETTINGS = [
  ['loanBusinessDays', 10, '標準の貸出期間（営業日）'],
  ['maxLoanBusinessDays', 20, '延長を含めた最長貸出期間（営業日）'],
  ['remindDaysBefore', 1, '返却期限の何日前にリマインドするか'],
  ['escalateAfterDays', 3, '延滞何日で管理者へエスカレーションするか'],
  ['adminEmail', '', '延滞エスカレーション・週次レポートの送信先'],
  ['appUrl', '', 'WebアプリのURL（通知メールに記載）'],
];
