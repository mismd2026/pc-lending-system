/**
 * Time-driven jobs: daily reminder / overdue mail and a weekly summary for the admin.
 * Install once with installTriggers() (also available from the spreadsheet menu).
 */

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['dailyCheck', 'weeklyReport'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyCheck').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('weeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
}

function dailyCheck() {
  var svc = service_();
  var n = withLock_(function () { return svc.collectNotifications(); });
  var s = svc.settings();
  var link = s.appUrl ? '\n\n貸出状況の確認: ' + s.appUrl : '';

  n.reminders.forEach(function (x) {
    sendMail_(x.borrowerEmail, '【PC貸出】返却期限が近づいています（' + x.assetTag + '）',
      x.borrowerName + ' さん\n\n貸出中の ' + x.assetTag + ' の返却期限は ' + x.dueDate +
      ' です。\n延長が必要な場合はWebアプリから申請してください。' + link);
  });
  n.overdue.forEach(function (x) {
    sendMail_(x.borrowerEmail, '【PC貸出】返却期限を過ぎています（' + x.assetTag + '）',
      x.borrowerName + ' さん\n\n' + x.assetTag + ' の返却期限（' + x.dueDate + '）を ' + x.daysLate +
      ' 日過ぎています。速やかに情報システム窓口へ返却してください。' + link);
  });
  if (n.escalations.length && s.adminEmail) {
    var lines = n.escalations.map(function (x) {
      return '- ' + x.assetTag + ' / ' + x.borrowerName + ' <' + x.borrowerEmail + '> / 期限 ' +
        x.dueDate + '（' + x.daysLate + '日超過）';
    });
    sendMail_(s.adminEmail, '【PC貸出】延滞エスカレーション ' + n.escalations.length + '件',
      '延滞が ' + s.escalateAfterDays + ' 日を超えた貸出があります。\n\n' + lines.join('\n') + link);
  }
  console.log(JSON.stringify({
    job: 'dailyCheck', reminders: n.reminders.length, overdue: n.overdue.length,
    escalations: n.escalations.length,
  }));
}

function weeklyReport() {
  var svc = service_();
  var s = svc.settings();
  if (!s.adminEmail) return;
  var devices = svc.listDevices();
  var count = function (st) { return devices.filter(function (d) { return d.status === st; }).length; };
  var overdue = devices.filter(function (d) { return d.overdue; });
  var body = [
    '■ 機器の状況',
    '  貸出可: ' + count(DEVICE_STATUS.AVAILABLE) + ' 台',
    '  貸出中: ' + count(DEVICE_STATUS.LENT) + ' 台（うち延滞 ' + overdue.length + ' 台）',
    '  修理中: ' + count(DEVICE_STATUS.REPAIR) + ' 台',
    '',
    '■ 延滞一覧',
  ].concat(overdue.length ? overdue.map(function (d) {
    return '  ' + d.assetTag + ' / ' + d.borrowerName + ' / 期限 ' + d.dueDate;
  }) : ['  なし']);
  sendMail_(s.adminEmail, '【PC貸出】週次レポート', body.join('\n'));
}

function sendMail_(to, subject, body) {
  if (MailApp.getRemainingDailyQuota() < 1) {
    console.warn('mail quota exhausted; skipped: ' + subject);
    return;
  }
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: 'PC貸出管理' });
}
