/**
 * Business rules for lending, returning and overdue handling.
 *
 * Pure logic: no SpreadsheetApp / MailApp calls here. Storage is injected as
 * `db` (SheetTable instances in production, the same class over a fake
 * spreadsheet in tests) and time as `clock`, so every rule is unit-tested in
 * Node without deploying.
 */
function LendingService(db, clock, idGen) {
  this.db = db;
  this.now = clock || function () { return new Date(); };
  this.newId = idGen || function () { return Utilities.getUuid(); };
}

/* ------------------------------------------------------------------ helpers */

function LendingError(message) {
  this.name = 'LendingError';
  this.message = message;
  this.stack = new Error(message).stack;
}
LendingError.prototype = Object.create(Error.prototype);

function dateKey_(d) {
  if (!(d instanceof Date)) d = new Date(d);
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
}

function startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Whole calendar days from a to b (b later => positive). DST-safe via local midnights. */
function daysBetween_(a, b) {
  return Math.round((startOfDay_(b) - startOfDay_(a)) / 86400000);
}

/** Add n business days, skipping weekends and registered holidays. */
function addBusinessDays_(start, n, holidaySet) {
  var d = startOfDay_(start);
  var added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    var dow = d.getDay();
    if (dow === 0 || dow === 6 || holidaySet[dateKey_(d)]) continue;
    added++;
  }
  return d;
}

/* ------------------------------------------------------------------ reads */

LendingService.prototype.settings = function () {
  var map = {};
  this.db.settings.all().forEach(function (r) {
    var v = r.value;
    map[r.key] = v !== '' && !isNaN(Number(v)) ? Number(v) : v;
  });
  DEFAULT_SETTINGS.forEach(function (d) {
    if (map[d[0]] === undefined || map[d[0]] === '') map[d[0]] = d[1];
  });
  return map;
};

LendingService.prototype.holidaySet = function () {
  var set = {};
  this.db.holidays.all().forEach(function (h) { set[dateKey_(h.date)] = h.name || true; });
  return set;
};

LendingService.prototype.user = function (email) {
  var e = String(email || '').toLowerCase();
  return this.db.users.find(function (u) { return String(u.email).toLowerCase() === e; });
};

LendingService.prototype.requireUser_ = function (email) {
  var u = this.user(email);
  if (!u) throw new LendingError('利用者として登録されていません: ' + email);
  return u;
};

LendingService.prototype.requireRole_ = function (actor, roles) {
  if (roles.indexOf(actor.role) < 0) throw new LendingError('この操作の権限がありません');
};

LendingService.prototype.activeLoans = function () {
  return this.db.loans.filter(function (l) { return l.returnedAt === '' || l.returnedAt === null; });
};

LendingService.prototype.isOverdue = function (loan) {
  return daysBetween_(new Date(loan.dueDate), this.now()) > 0;
};

LendingService.prototype.listDevices = function () {
  var active = {};
  this.activeLoans().forEach(function (l) { active[l.assetTag] = l; });
  var self = this;
  return this.db.devices.filter(function (d) { return d.status !== DEVICE_STATUS.RETIRED; })
    .map(function (d) {
      var loan = active[d.assetTag];
      return {
        assetTag: d.assetTag, model: d.model, category: d.category,
        status: d.status, location: d.location,
        borrowerName: loan ? loan.borrowerName : '',
        dueDate: loan ? dateKey_(loan.dueDate) : '',
        overdue: loan ? self.isOverdue(loan) : false,
      };
    });
};

LendingService.prototype.loansOf = function (email) {
  var e = String(email).toLowerCase();
  var self = this;
  return this.activeLoans()
    .filter(function (l) { return String(l.borrowerEmail).toLowerCase() === e; })
    .map(function (l) {
      return {
        loanId: l.loanId, assetTag: l.assetTag, purpose: l.purpose,
        lentAt: dateKey_(l.lentAt), dueDate: dateKey_(l.dueDate), overdue: self.isOverdue(l),
      };
    });
};

/* ------------------------------------------------------------------ commands */

/**
 * @param {string} actorEmail  who is operating the app
 * @param {{assetTag:string, borrowerEmail?:string, purpose:string, businessDays?:number}} req
 */
LendingService.prototype.checkout = function (actorEmail, req) {
  var actor = this.requireUser_(actorEmail);
  var borrowerEmail = req.borrowerEmail || actor.email;
  if (String(borrowerEmail).toLowerCase() !== String(actor.email).toLowerCase()) {
    this.requireRole_(actor, [ROLES.STAFF, ROLES.ADMIN]); // lending on someone's behalf
  }
  var borrower = this.requireUser_(borrowerEmail);
  if (!req.purpose || !String(req.purpose).trim()) throw new LendingError('利用目的を入力してください');

  var tag = String(req.assetTag || '').trim().toUpperCase();
  var device = this.db.devices.find(function (d) { return String(d.assetTag).toUpperCase() === tag; });
  if (!device) throw new LendingError('資産番号が見つかりません: ' + tag);
  if (device.status !== DEVICE_STATUS.AVAILABLE) {
    throw new LendingError(tag + ' は現在「' + device.status + '」のため貸出できません');
  }
  var active = this.activeLoans();
  if (active.some(function (l) { return l.assetTag === device.assetTag; })) {
    // Ledger and loan log disagree: refuse and let an admin reconcile.
    throw new LendingError(tag + ' に未返却の貸出記録があります。管理者に確認してください');
  }

  var mine = active.filter(function (l) {
    return String(l.borrowerEmail).toLowerCase() === String(borrower.email).toLowerCase();
  });
  var self = this;
  if (mine.some(function (l) { return self.isOverdue(l); })) {
    throw new LendingError('延滞中の貸出があるため、新たに借りることはできません');
  }
  var max = Number(borrower.maxLoans) || 1;
  if (mine.length >= max) throw new LendingError('同時に借りられる上限（' + max + '台）に達しています');

  var s = this.settings();
  var days = Number(req.businessDays) || s.loanBusinessDays;
  if (days < 1 || days > s.maxLoanBusinessDays) {
    throw new LendingError('貸出期間は1〜' + s.maxLoanBusinessDays + '営業日で指定してください');
  }

  var now = this.now();
  var loan = {
    loanId: this.newId(),
    assetTag: device.assetTag,
    borrowerEmail: borrower.email,
    borrowerName: borrower.name,
    purpose: String(req.purpose).trim(),
    lentAt: now,
    dueDate: addBusinessDays_(now, days, this.holidaySet()),
    returnedAt: '', returnCondition: '', handledBy: actor.email, remindedAt: '', escalatedAt: '',
  };
  this.db.loans.append(loan);
  device.status = DEVICE_STATUS.LENT;
  device.updatedAt = now;
  this.db.devices.save(device);
  this.audit_(actor.email, 'CHECKOUT', device.assetTag, {
    loanId: loan.loanId, borrower: borrower.email, due: dateKey_(loan.dueDate),
  });
  return { loanId: loan.loanId, assetTag: device.assetTag, dueDate: dateKey_(loan.dueDate) };
};

/** Returns are received by the IT desk so the device condition is actually checked. */
LendingService.prototype.receiveReturn = function (actorEmail, req) {
  var actor = this.requireUser_(actorEmail);
  this.requireRole_(actor, [ROLES.STAFF, ROLES.ADMIN]);
  var tag = String(req.assetTag || '').trim().toUpperCase();
  var loan = this.activeLoans().filter(function (l) { return String(l.assetTag).toUpperCase() === tag; })[0];
  if (!loan) throw new LendingError(tag + ' の貸出中記録がありません');
  var needsRepair = req.condition === '要修理';
  var now = this.now();
  loan.returnedAt = now;
  loan.returnCondition = needsRepair ? '要修理' : '良好';
  this.db.loans.save(loan);

  var device = this.db.devices.find(function (d) { return d.assetTag === loan.assetTag; });
  device.status = needsRepair ? DEVICE_STATUS.REPAIR : DEVICE_STATUS.AVAILABLE;
  device.updatedAt = now;
  if (req.note) device.notes = String(device.notes ? device.notes + ' / ' : '') + req.note;
  this.db.devices.save(device);

  var lateDays = Math.max(0, daysBetween_(new Date(loan.dueDate), now));
  this.audit_(actor.email, 'RETURN', loan.assetTag, {
    loanId: loan.loanId, condition: loan.returnCondition, lateDays: lateDays,
  });
  return { assetTag: loan.assetTag, lateDays: lateDays, deviceStatus: device.status };
};

LendingService.prototype.extend = function (actorEmail, req) {
  var actor = this.requireUser_(actorEmail);
  var loan = this.activeLoans().filter(function (l) { return l.loanId === req.loanId; })[0];
  if (!loan) throw new LendingError('貸出記録が見つかりません');
  var own = String(loan.borrowerEmail).toLowerCase() === String(actor.email).toLowerCase();
  if (!own) this.requireRole_(actor, [ROLES.STAFF, ROLES.ADMIN]);
  if (this.isOverdue(loan) && actor.role === ROLES.USER) {
    throw new LendingError('延滞中のため延長できません。情報システム窓口へ連絡してください');
  }
  var s = this.settings();
  var holidays = this.holidaySet();
  var limit = addBusinessDays_(new Date(loan.lentAt), s.maxLoanBusinessDays, holidays);
  var proposed = addBusinessDays_(new Date(loan.dueDate), Number(req.businessDays) || 5, holidays);
  if (proposed > limit) {
    throw new LendingError('最長貸出期間（' + dateKey_(limit) + 'まで）を超えるため延長できません');
  }
  var before = dateKey_(loan.dueDate);
  loan.dueDate = proposed;
  loan.remindedAt = '';
  this.db.loans.save(loan);
  this.audit_(actor.email, 'EXTEND', loan.assetTag, {
    loanId: loan.loanId, from: before, to: dateKey_(proposed),
  });
  return { loanId: loan.loanId, dueDate: dateKey_(proposed) };
};

/**
 * Decide who should be notified today. Marks the loans so that a re-run of the
 * trigger on the same day never sends duplicate mail.
 * @return {{reminders:Array, overdue:Array, escalations:Array}}
 */
LendingService.prototype.collectNotifications = function () {
  var s = this.settings();
  var now = this.now();
  var today = dateKey_(now);
  var out = { reminders: [], overdue: [], escalations: [] };
  var self = this;
  this.activeLoans().forEach(function (loan) {
    var daysLeft = daysBetween_(now, new Date(loan.dueDate));
    var item = {
      loanId: loan.loanId, assetTag: loan.assetTag, borrowerEmail: loan.borrowerEmail,
      borrowerName: loan.borrowerName, dueDate: dateKey_(loan.dueDate), daysLate: -daysLeft,
    };
    var changed = false;
    if (daysLeft >= 0 && daysLeft <= s.remindDaysBefore) {
      if (!loan.remindedAt || dateKey_(loan.remindedAt) !== today) {
        out.reminders.push(item);
        loan.remindedAt = now;
        changed = true;
      }
    } else if (daysLeft < 0) {
      if (!loan.remindedAt || dateKey_(loan.remindedAt) !== today) {
        out.overdue.push(item);
        loan.remindedAt = now;
        changed = true;
      }
      if (-daysLeft >= s.escalateAfterDays && !loan.escalatedAt) {
        out.escalations.push(item);
        loan.escalatedAt = now;
        changed = true;
      }
    }
    if (changed) self.db.loans.save(loan);
  });
  return out;
};

LendingService.prototype.audit_ = function (actor, action, target, detail) {
  this.db.audit.append({
    timestamp: this.now(), actor: actor, action: action, target: target,
    detail: JSON.stringify(detail || {}),
  });
};
