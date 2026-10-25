/**
 * «Мамой клянусь — финансы»: API для приложения.
 *
 * Файл добавляется в проект «Saby выгрузка» рядом с остальными.
 * Читает и пишет файл месяца (свойства MF_CURRENT_ID / MF_PREV_ID),
 * формулы таблиц не трогает: пишет только в те же ячейки, что заполняются руками.
 *
 * Свойства скрипта, которые использует этот файл:
 *   APP_CLIENT_ID  — OAuth Client ID для входа через Google (задаётся в appSetup)
 *   APP_SECRET     — секрет для подписи сессий (создаётся сам)
 *   APP_USERS      — список пользователей и ролей (JSON, правится из приложения)
 *   APP_RECEIPTS_FOLDER_ID — папка для фото чеков, только если в проекте нет receipts_bot.gs
 *
 * Из receipts_bot.gs берёт rcRecognize_ (распознавание чека) и rcFolder_ (папка «Чеки и накладные»).
 */

// Заполнить перед первым запуском appSetup()
const APP_SETUP = {
  ownerEmail: '',   // Google-почта владельца
  ownerName: 'Артём',
  clientId: '388186217588-uhg6jcnvq91ldj7tv47m484d9m3o98nq.apps.googleusercontent.com'      // OAuth Client ID вида 1234-abc.apps.googleusercontent.com
};

const APP = {
  VERSION: 3, // растёт при каждом обновлении этого файла; приложение по нему понимает, что код в Apps Script свежий
  SESSION_DAYS: 60,
  // Сотрудник может отмечать свою смену за сегодня и столько дней назад
  EMPLOYEE_SHIFT_DAYS_BACK: 1,
  AUTHOR_TAG: 'внёс: ',
  RECEIPTS_FOLDER_NAME: 'МК — чеки из приложения'
};

const APP_ROLES = {
  owner: 'Владелец',
  manager: 'Управляющий',
  employee: 'Сотрудник'
};

// edit — менять, view — смотреть, own — только своё, none — нет доступа
const APP_PERMS = {
  owner:    { summary: 'view', profit: true,  revenue: 'edit', expenses: 'edit', fixed: 'edit', shifts: 'edit', payroll: 'edit', money: 'edit', settings: 'edit' },
  manager:  { summary: 'view', profit: false, revenue: 'view', expenses: 'edit', fixed: 'edit', shifts: 'edit', payroll: 'edit', money: 'view', settings: 'none' },
  employee: { summary: 'none', profit: false, revenue: 'none', expenses: 'own',  fixed: 'none', shifts: 'own',  payroll: 'own',  money: 'none', settings: 'none' }
};

const APP_CORRECTIONS = {
  withdraw:  { name: 'Снятие наличных со счёта', cash: 1, acc: -1 },
  deposit:   { name: 'Внесение наличных на счёт', cash: -1, acc: 1 },
  ownerCash: { name: 'Изъятие собственником из кассы', cash: -1, acc: 0 },
  ownerAcc:  { name: 'Изъятие собственником со счёта', cash: 0, acc: -1 },
  reconcile: { name: 'Сверка остатка' }
};

/* ───────────── Точки входа ───────────── */

function appDoGet_(e) {
  return appJson_({ ok: true, app: 'mk-finance', version: 1 });
}

function appDoPost_(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return appJson_({ ok: false, error: { code: 'bad_request', message: 'Не удалось прочитать запрос' } });
  }
  try {
    return appJson_({ ok: true, data: appHandle_(req) });
  } catch (err) {
    if (err && err.appCode) return appJson_({ ok: false, error: { code: err.appCode, message: err.message } });
    console.error(err && err.stack || err);
    return appJson_({ ok: false, error: { code: 'internal', message: 'Ошибка на сервере: ' + (err && err.message || err) } });
  }
}

function appJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function appError_(code, message) {
  const err = new Error(message);
  err.appCode = code;
  return err;
}

const APP_ACTIONS = {
  // чтение
  me:        (u) => appPublicUser_(u),
  load:      (u, p) => appLoad_(u, p),
  summary:   (u, p) => appSummary_(u, appMonth_(p.month)),
  revenue:   (u, p) => appRevenue_(u, appMonth_(p.month)),
  expenses:  (u, p) => appExpenses_(u, appMonth_(p.month)),
  fixed:     (u, p) => appFixed_(u, appMonth_(p.month)),
  payroll:   (u, p) => appPayroll_(u, appMonth_(p.month)),
  cashflow:  (u, p) => appCashflow_(u, appMonth_(p.month)),
  // запись
  setCooper:     (u, p) => appWrite_(() => appSetCooper_(u, appMonth_(p.month), p)),
  recognizeReceipt: (u, p) => appRecognizeReceipt_(u, appMonth_(p.month), p),
  addExpense:    (u, p) => appWrite_(() => appAddExpense_(u, appMonth_(p.month), p)),
  deleteExpense: (u, p) => appWrite_(() => appDeleteExpense_(u, appMonth_(p.month), p)),
  payFixed:      (u, p) => appWrite_(() => appPayFixed_(u, appMonth_(p.month), p)),
  addFixedItem:  (u, p) => appWrite_(() => appAddFixedItem_(u, appMonth_(p.month), p)),
  setShift:      (u, p) => appWrite_(() => appSetShift_(u, appMonth_(p.month), p)),
  addPayout:     (u, p) => appWrite_(() => appAddPayout_(u, appMonth_(p.month), p)),
  addCorrection: (u, p) => appWrite_(() => appAddCorrection_(u, appMonth_(p.month), p)),
  // пользователи
  users:      (u) => appUsersList_(u),
  saveUser:   (u, p) => appWrite_(() => appSaveUser_(u, p)),
  removeUser: (u, p) => appWrite_(() => appRemoveUser_(u, p))
};

function appHandle_(req) {
  if (req.action === 'login') return appLogin_(req);
  const user = appUserFromSession_(req.session);
  const fn = APP_ACTIONS[req.action];
  if (!fn) throw appError_('bad_request', 'Неизвестное действие: ' + req.action);
  return fn(user, req);
}

function appWrite_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('busy', 'Таблица занята, попробуйте ещё раз');
  try {
    const res = fn();
    SpreadsheetApp.flush();
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── Настройка (запускается один раз из редактора) ───────────── */

function appSetup() {
  const props = PropertiesService.getScriptProperties();
  if (!APP_SETUP.ownerEmail || !APP_SETUP.clientId) {
    throw new Error('Заполните APP_SETUP.ownerEmail и APP_SETUP.clientId вверху файла app_api.gs');
  }
  props.setProperty('APP_CLIENT_ID', APP_SETUP.clientId.trim());
  if (!props.getProperty('APP_SECRET')) props.setProperty('APP_SECRET', Utilities.getUuid() + Utilities.getUuid());
  const users = appGetUsers_();
  const email = APP_SETUP.ownerEmail.trim().toLowerCase();
  const existing = users.find((x) => x.email === email);
  if (existing) existing.role = 'owner';
  else users.push({ email, name: APP_SETUP.ownerName || email, role: 'owner', employee: '' });
  appPutUsers_(users);
  console.log('Готово. Владелец: ' + email + '. Пользователей: ' + users.length);
}

/** Выйти из приложения на всех устройствах: старые сессии перестанут работать. */
function appResetSessions() {
  PropertiesService.getScriptProperties().setProperty('APP_SECRET', Utilities.getUuid() + Utilities.getUuid());
}

/* ───────────── Вход и роли ───────────── */

function appLogin_(req) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('APP_CLIENT_ID');
  if (!clientId) throw appError_('setup', 'API не настроен: запустите appSetup()');
  if (!req.idToken) throw appError_('bad_request', 'Нет токена Google');
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.idToken),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw appError_('auth', 'Google не подтвердил вход, попробуйте ещё раз');
  const info = JSON.parse(resp.getContentText());
  const okIss = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
  if (info.aud !== clientId || !okIss || String(info.email_verified) !== 'true' || Number(info.exp) * 1000 < Date.now()) {
    throw appError_('auth', 'Вход не прошёл проверку');
  }
  const email = String(info.email).toLowerCase();
  const users = appGetUsers_();
  const user = users.find((x) => x.email === email);
  if (!user) throw appError_('forbidden', 'Почта ' + email + ' не добавлена в приложение. Попросите владельца добавить её.');
  if ((!user.name || user.name === user.email) && (info.given_name || info.name)) {
    user.name = info.given_name || info.name;
    appPutUsers_(users);
  }
  return { session: appMakeSession_(email), user: appPublicUser_(user) };
}

function appMakeSession_(email) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({
    e: email, x: Date.now() + APP.SESSION_DAYS * 86400000
  }));
  return payload + '.' + appSign_(payload);
}

function appSign_(payload) {
  const secret = PropertiesService.getScriptProperties().getProperty('APP_SECRET');
  if (!secret) throw appError_('setup', 'API не настроен: запустите appSetup()');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret));
}

function appUserFromSession_(token) {
  if (!token || String(token).indexOf('.') < 0) throw appError_('auth', 'Нужно войти');
  const parts = String(token).split('.');
  if (appSign_(parts[0]) !== parts[1]) throw appError_('auth', 'Сессия недействительна, войдите заново');
  const data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  if (data.x < Date.now()) throw appError_('auth', 'Сессия истекла, войдите заново');
  const user = appGetUsers_().find((x) => x.email === data.e);
  if (!user) throw appError_('auth', 'Доступ закрыт владельцем');
  return user;
}

function appGetUsers_() {
  const raw = PropertiesService.getScriptProperties().getProperty('APP_USERS');
  return raw ? JSON.parse(raw) : [];
}

function appPutUsers_(users) {
  PropertiesService.getScriptProperties().setProperty('APP_USERS', JSON.stringify(users));
}

function appPublicUser_(u) {
  return {
    email: u.email, name: u.name, role: u.role, roleName: APP_ROLES[u.role],
    employee: u.employee || '', perms: APP_PERMS[u.role]
  };
}

function appCan_(user, area, level) {
  const have = APP_PERMS[user.role] && APP_PERMS[user.role][area];
  if (level === 'view') return have === 'view' || have === 'edit';
  if (level === 'own') return have === 'own' || have === 'view' || have === 'edit';
  return have === level;
}

function appRequire_(user, area, level) {
  if (!appCan_(user, area, level)) throw appError_('forbidden', 'Недостаточно прав');
}

/* ───────────── Файл месяца ───────────── */

function appMonth_(which) {
  const key = which === 'prev' ? 'MF_PREV_ID' : 'MF_CURRENT_ID';
  const id = PropertiesService.getScriptProperties().getProperty(key);
  if (!id) throw appError_('setup', which === 'prev' ? 'Файл прошлого месяца не задан' : 'Файл текущего месяца не задан (MF_CURRENT_ID)');
  const ss = SpreadsheetApp.openById(id);
  const tz = ss.getSpreadsheetTimeZone();
  const settings = ss.getSheetByName('Настройки').getRange(1, 1, 80, 4).getValues();
  const monthCell = appFindRow_(settings, 0, 'Месяц отчёта');
  const start = monthCell && monthCell[1] instanceof Date ? monthCell[1] : null;
  return {
    which: which === 'prev' ? 'prev' : 'current',
    ss, tz, settings,
    title: ss.getName(),
    monthKey: start ? Utilities.formatDate(start, tz, 'yyyy-MM') : '',
    sheet: (name) => {
      const sh = ss.getSheetByName(name);
      if (!sh) throw appError_('setup', 'В файле месяца нет листа «' + name + '»');
      return sh;
    }
  };
}

function appMonthInfo_(m) {
  const today = Utilities.formatDate(new Date(), m.tz, 'yyyy-MM-dd');
  let dataDate = '';
  const a2 = String(m.sheet('Дашборд').getRange('A2').getDisplayValue());
  const found = a2.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (found) dataDate = found[3] + '-' + found[2] + '-' + found[1];
  return { which: m.which, title: m.title, month: m.monthKey, today, dataDate };
}

function appDicts_(m) {
  const s = m.settings;
  const list = (title, stop) => {
    const out = [];
    const start = s.findIndex((r) => String(r[0]).indexOf(title) === 0);
    if (start < 0) return out;
    for (let i = start + 1; i < s.length; i++) {
      const v = String(s[i][0]).trim();
      if (stop.some((t) => v.indexOf(t) === 0)) break;
      if (v) out.push(v);
    }
    return out;
  };
  return {
    categories: list('Категории расходов', ['Способы оплаты']),
    payments: list('Способы оплаты', ['Сотрудники']),
    employees: list('Сотрудники', ['Ставки']),
    fixedGroups: ['Налоги', 'Аренда и коммуналка', 'Услуги', 'Прочее'],
    corrections: Object.keys(APP_CORRECTIONS).map((id) => ({ id, name: APP_CORRECTIONS[id].name }))
  };
}

/* ───────────── Общие помощники ───────────── */

function appNum_(v) {
  if (typeof v === 'number') return v;
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function appIso_(d, tz) {
  return d instanceof Date ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : '';
}

function appFindRow_(grid, col, prefix) {
  return grid.find((r) => String(r[col]).trim().indexOf(prefix) === 0) || null;
}

function appHeaderIndex_(header) {
  const idx = {};
  header.forEach((h, i) => { const k = String(h).trim(); if (k && !(k in idx)) idx[k] = i; });
  return idx;
}

/** Строки дней месяца (A = дата) с номерами строк листа. */
function appDayRows_(sh, tz, firstRow) {
  const last = Math.max(sh.getLastRow(), firstRow);
  const values = sh.getRange(firstRow, 1, last - firstRow + 1, sh.getLastColumn()).getValues();
  const out = [];
  values.forEach((r, i) => { if (r[0] instanceof Date) out.push({ row: firstRow + i, iso: appIso_(r[0], tz), v: r }); });
  return out;
}

function appCheckDate_(m, iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) throw appError_('bad_request', 'Неверная дата');
  if (m.monthKey && iso.slice(0, 7) !== m.monthKey) {
    throw appError_('bad_request', 'Дата не из этого месяца: файл «' + m.title + '»');
  }
}

function appCheckSum_(v) {
  const n = appNum_(v);
  if (!(n > 0)) throw appError_('bad_request', 'Сумма должна быть больше нуля');
  return Math.round(n * 100) / 100;
}

/** Дата как серийный номер дня (как в боте чеков): не зависит от часовых поясов. */
function appSetDate_(range, iso) {
  const serial = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569;
  range.setValue(serial).setNumberFormat('dd.mm.yyyy');
}

function appText_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, max || 300);
}

/** Последняя заполненная строка в колонках [col, col+width) начиная с firstRow; firstRow-1 если пусто. */
function appLastFilled_(sh, firstRow, col, width) {
  const last = sh.getLastRow();
  if (last < firstRow) return firstRow - 1;
  const vals = sh.getRange(firstRow, col, last - firstRow + 1, width).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i].some((x) => x !== '' && x !== null)) return firstRow + i;
  }
  return firstRow - 1;
}

function appEnsureRow_(sh, row) {
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows() + 20);
}

function appAuthorTag_(user) {
  return APP.AUTHOR_TAG + (user.employee || user.name);
}

/* ───────────── Сборка всего сразу ───────────── */

function appLoad_(user, p) {
  const m = appMonth_(p.month);
  const out = {
    apiVersion: APP.VERSION,
    user: appPublicUser_(user),
    month: appMonthInfo_(m),
    hasPrev: !!PropertiesService.getScriptProperties().getProperty('MF_PREV_ID'),
    dicts: appDicts_(m)
  };
  if (appCan_(user, 'summary', 'view')) out.summary = appSummary_(user, m);
  if (appCan_(user, 'revenue', 'view')) out.revenue = appRevenue_(user, m);
  if (appCan_(user, 'expenses', 'own')) out.expenses = appExpenses_(user, m);
  if (appCan_(user, 'fixed', 'view')) out.fixed = appFixed_(user, m);
  if (appCan_(user, 'payroll', 'own')) out.payroll = appPayroll_(user, m);
  if (appCan_(user, 'money', 'view')) out.cashflow = appCashflow_(user, m);
  if (appCan_(user, 'settings', 'edit')) out.users = appUsersList_(user);
  return out;
}

/* ───────────── Сводка (лист «Дашборд») ───────────── */

function appSummary_(user, m) {
  appRequire_(user, 'summary', 'view');
  const g = m.sheet('Дашборд').getRange(1, 1, 45, 8).getValues();
  const kpiRow = (name) => {
    const r = appFindRow_(g, 0, name);
    return r ? { total: appNum_(r[1]), avg: appNum_(r[2]), median: appNum_(r[3]), min: appNum_(r[4]), max: appNum_(r[5]), forecast: appNum_(r[6]) } : null;
  };
  const daysRow = appFindRow_(g, 0, 'Дней с выручкой');
  const out = {
    kpi: {
      gross: kpiRow('Выручка GROSS'),
      netto: kpiRow('NETTO (после'),
      cash: kpiRow('Касса (Saby)'),
      checks: kpiRow('Чеков в кассе'),
      avgCheck: kpiRow('Средний чек кассы'),
      daysWithRevenue: daysRow ? appNum_(daysRow[1]) : 0,
      daysInMonth: daysRow ? appNum_(daysRow[3]) : 0
    },
    channels: [],
    other: {}
  };

  // Структура выручки: колонки E–G после заголовка «Канал»
  const chStart = g.findIndex((r) => String(r[4]).trim() === 'Канал');
  if (chStart >= 0) {
    for (let i = chStart + 1; i < g.length; i++) {
      const name = String(g[i][4]).trim();
      if (!name) break;
      if (name === 'Итого') continue;
      out.channels.push({ name, sum: appNum_(g[i][5]), share: appNum_(g[i][6]) });
    }
  }
  const valE = (label) => { const r = appFindRow_(g, 4, label); return r ? appNum_(r[6]) : 0; };
  out.other = {
    payrollDue: valE('Зарплата к выплате'),
    foodcost: valE('Фудкост'),
    aggDeductions: valE('Комиссии и вычеты'),
    aggShare: valE('доля от выручки')
  };
  out.moneyEnd = { cash: valE('Наличные в кассе'), account: valE('Расчётный счёт'), total: valE('Всего') };

  // Отчёт о прибыли — только владельцу
  if (APP_PERMS[user.role].profit) {
    const plStart = g.findIndex((r) => String(r[0]).trim() === 'Статья');
    out.pl = [];
    const totals = ['Выручка GROSS', 'NETTO', 'Валовая прибыль', 'Операционная прибыль', 'Чистая прибыль'];
    for (let i = plStart + 1; plStart >= 0 && i < g.length; i++) {
      const raw = String(g[i][0]);
      const name = raw.trim();
      if (!name) continue;
      out.pl.push({
        name, sum: appNum_(g[i][1]), pct: appNum_(g[i][2]),
        kind: totals.indexOf(name) >= 0 ? 'total' : (raw.indexOf('   ') === 0 ? 'sub' : 'line')
      });
    }
  }
  return out;
}

/* ───────────── Выручка ───────────── */

function appRevenue_(user, m) {
  appRequire_(user, 'revenue', 'view');
  const sh = m.sheet('Выручка');
  const header = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
  const h = appHeaderIndex_(header);
  const col = (r, name) => (name in h ? r[h[name]] : '');
  const days = appDayRows_(sh, m.tz, 3).map((d) => ({
    date: d.iso,
    wd: String(col(d.v, 'День')),
    cashNal: appNum_(col(d.v, 'Наличные')),
    cashCard: appNum_(col(d.v, 'БН')),
    cashSbp: appNum_(col(d.v, 'СБП')),
    cash: appNum_(col(d.v, 'Касса итого')),
    checks: appNum_(col(d.v, 'Чеков')),
    avgCheck: appNum_(col(d.v, 'Средний чек')),
    yaDelivery: appNum_(col(d.v, 'Яндекс доставка')),
    yaPickup: appNum_(col(d.v, 'Яндекс самовывоз')),
    cooper: col(d.v, 'Купер') === '' ? null : appNum_(col(d.v, 'Купер')),
    agg: appNum_(col(d.v, 'Агрегаторы итого')),
    yaOrders: appNum_(col(d.v, 'Яндекс заказов')),
    gross: appNum_(col(d.v, 'GROSS'))
  }));
  const sum = (k) => days.reduce((a, d) => a + (d[k] || 0), 0);
  return {
    days,
    totals: {
      cashNal: sum('cashNal'), cashCard: sum('cashCard'), cashSbp: sum('cashSbp'), cash: sum('cash'),
      checks: sum('checks'), yaDelivery: sum('yaDelivery'), yaPickup: sum('yaPickup'),
      cooper: sum('cooper'), agg: sum('agg'), yaOrders: sum('yaOrders'), gross: sum('gross')
    },
    canEditCooper: appCan_(user, 'revenue', 'edit')
  };
}

function appSetCooper_(user, m, p) {
  appRequire_(user, 'revenue', 'edit');
  appCheckDate_(m, p.date);
  const sh = m.sheet('Выручка');
  const h = appHeaderIndex_(sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0]);
  if (!('Купер' in h)) throw appError_('setup', 'На листе «Выручка» нет колонки «Купер»');
  const day = appDayRows_(sh, m.tz, 3).find((d) => d.iso === p.date);
  if (!day) throw appError_('bad_request', 'Нет строки за ' + p.date);
  const cell = sh.getRange(day.row, h['Купер'] + 1);
  const v = p.sum === '' || p.sum === null || p.sum === undefined ? '' : appNum_(p.sum);
  if (v !== '' && v < 0) throw appError_('bad_request', 'Сумма не может быть отрицательной');
  cell.setValue(v === 0 ? '' : v);
  return { date: p.date, cooper: v || null };
}

/* ───────────── Расходы ───────────── */

function appExpenses_(user, m) {
  appRequire_(user, 'expenses', 'own');
  const sh = m.sheet('Расходы');
  const last = appLastFilled_(sh, 3, 1, 6);
  const rows = last < 3 ? [] : sh.getRange(3, 1, last - 2, 6).getValues();
  const own = APP_PERMS[user.role].expenses === 'own';
  const tag = appAuthorTag_(user);
  const items = [];
  rows.forEach((r, i) => {
    if (r.every((x) => x === '' || x === null)) return;
    const comment = String(r[5]);
    const item = {
      row: 3 + i,
      date: appIso_(r[0], m.tz),
      category: String(r[1]).trim(),
      counterparty: String(r[2]).trim(),
      sum: appNum_(r[3]),
      payment: String(r[4]).trim(),
      comment,
      source: appExpenseSource_(r)
    };
    if (own && comment.indexOf(tag) < 0) return;
    items.push(item);
  });
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.row - a.row));
  const byCat = {}, byPay = {};
  items.forEach((x) => {
    byCat[x.category || 'Без категории'] = (byCat[x.category || 'Без категории'] || 0) + x.sum;
    byPay[x.payment || 'Не указан'] = (byPay[x.payment || 'Не указан'] || 0) + x.sum;
  });
  const total = items.reduce((a, x) => a + x.sum, 0);
  return {
    items,
    total,
    byCategory: Object.keys(byCat).map((k) => ({ name: k, sum: byCat[k] })).sort((a, b) => b.sum - a.sum),
    byPayment: Object.keys(byPay).map((k) => ({ name: k, sum: byPay[k] })).sort((a, b) => b.sum - a.sum),
    canEditAll: APP_PERMS[user.role].expenses === 'edit'
  };
}

function appExpenseSource_(r) {
  const comment = String(r[5]);
  const hasPhoto = /\.(jpe?g|png|heic|pdf)\b|drive\.google\.com/i.test(comment);
  if (hasPhoto && comment.indexOf(APP.AUTHOR_TAG) < 0) return 'bot';
  if (comment.indexOf('авто:') >= 0 || String(r[4]).trim() === 'Вычет агрегатора') return 'auto';
  if (comment.indexOf(APP.AUTHOR_TAG) >= 0) return 'app';
  return 'hand';
}

function appAddExpense_(user, m, p) {
  appRequire_(user, 'expenses', 'own');
  appCheckDate_(m, p.date);
  const dicts = appDicts_(m);
  const category = appText_(p.category, 100);
  const payment = appText_(p.payment, 100);
  if (dicts.categories.indexOf(category) < 0) throw appError_('bad_request', 'Неизвестная категория: ' + category);
  if (dicts.payments.indexOf(payment) < 0) throw appError_('bad_request', 'Неизвестный способ оплаты: ' + payment);
  const sum = appCheckSum_(p.sum);
  const counterparty = appText_(p.counterparty, 120);
  const parts = [];
  if (appText_(p.comment)) parts.push(appText_(p.comment));
  if (p.photo && p.photo.data) parts.push(appSaveReceipt_(m, p.photo, p.date, counterparty, sum));
  parts.push(appAuthorTag_(user));

  const sh = m.sheet('Расходы');
  const row = appLastFilled_(sh, 3, 1, 6) + 1;
  appEnsureRow_(sh, row);
  sh.getRange(row, 2, 1, 5).setValues([[category, counterparty, sum, payment, parts.join(' · ')]]);
  appSetDate_(sh.getRange(row, 1), p.date);
  return { row };
}

/** Фото чека — в ту же папку, что и у Telegram-бота («Чеки и накладные/ГГГГ-ММ»); в комментарий идёт ссылка. */
function appSaveReceipt_(m, photo, iso, counterparty, sum) {
  let folder = null;
  if (typeof rcFolder_ === 'function') {
    folder = rcFolder_(m.ss, iso.slice(0, 7));
  } else {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('APP_RECEIPTS_FOLDER_ID');
    try { folder = id ? DriveApp.getFolderById(id) : null; } catch (e) { folder = null; }
    if (!folder) {
      folder = DriveApp.createFolder(APP.RECEIPTS_FOLDER_NAME);
      props.setProperty('APP_RECEIPTS_FOLDER_ID', folder.getId());
    }
  }
  const bytes = Utilities.base64Decode(String(photo.data).replace(/^data:[^,]+,/, ''));
  const mime = appSniffMime_(bytes, photo.mime);
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const name = [iso, counterparty || 'чек', Math.round(sum)].join(' ').replace(/[\\/:*?"<>|]/g, '') + '.' + ext;
  if (bytes.length > 8 * 1024 * 1024) throw appError_('bad_request', 'Файл слишком большой');
  return folder.createFile(Utilities.newBlob(bytes, mime, name)).getUrl();
}

/** Тип файла по первым байтам: телефон не всегда правильно называет тип PDF и фото. */
function appSniffMime_(bytes, declared) {
  const b = (i) => (bytes[i] + 256) % 256;
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'application/pdf';
  if (b(0) === 0x89 && b(1) === 0x50) return 'image/png';
  if (b(0) === 0xFF && b(1) === 0xD8) return 'image/jpeg';
  if (b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  return /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(declared) ? declared : 'image/jpeg';
}

/** Распознать фото чека тем же Claude, что и Telegram-бот (rcRecognize_ из receipts_bot.gs). Ничего не записывает. */
function appRecognizeReceipt_(user, m, p) {
  appRequire_(user, 'expenses', 'own');
  if (typeof rcRecognize_ !== 'function') throw appError_('setup', 'Распознавание недоступно: нет receipts_bot.gs в проекте');
  if (!p.photo || !p.photo.data) throw appError_('bad_request', 'Нет фото');
  // Фото чека или PDF накладной — как в боте
  const bytes = Utilities.base64Decode(String(p.photo.data).replace(/^data:[^,]+,/, ''));
  const mime = appSniffMime_(bytes, p.photo.mime);
  if (bytes.length > 7 * 1024 * 1024) throw appError_('bad_request', 'Файл слишком большой, до 7 МБ');
  const cats = appDicts_(m).categories;
  const r = rcRecognize_(Utilities.newBlob(bytes, mime, 'receipt'), mime, '', cats);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || '')) ? r.date : '';
  return {
    date,
    dateInMonth: !!date && (!m.monthKey || date.slice(0, 7) === m.monthKey),
    counterparty: String(r.supplier || '').slice(0, 60),
    sum: Math.round(Number(r.total || 0) * 100) / 100,
    category: cats.indexOf(r.category) >= 0 ? r.category : '',
    comment: String(r.summary || '').slice(0, 80),
    problem: r.readable === false ? (r.problem || 'плохо читается') : ''
  };
}

function appDeleteExpense_(user, m, p) {
  appRequire_(user, 'expenses', 'own');
  const sh = m.sheet('Расходы');
  const row = Number(p.row);
  const last = appLastFilled_(sh, 3, 1, 6);
  if (!(row >= 3 && row <= last)) throw appError_('bad_request', 'Строка не найдена');
  const r = sh.getRange(row, 1, 1, 6).getValues()[0];
  // Защита от сдвига строк: удаляем, только если строка та же, что видел пользователь
  if (appIso_(r[0], m.tz) !== p.date || Math.abs(appNum_(r[3]) - appNum_(p.sum)) > 0.005 || String(r[1]).trim() !== p.category) {
    throw appError_('conflict', 'Таблица изменилась, обновите список и попробуйте снова');
  }
  if (APP_PERMS[user.role].expenses === 'own' && String(r[5]).indexOf(appAuthorTag_(user)) < 0) {
    throw appError_('forbidden', 'Можно удалять только свои расходы');
  }
  // Сдвигаем строки ниже вверх только в колонках A–F: справа на листе сводка, её не трогаем
  if (row < last) sh.getRange(row + 1, 1, last - row, 6).moveTo(sh.getRange(row, 1));
  sh.getRange(last, 1, 1, 6).clearContent();
  return { deleted: row };
}

/* ───────────── Постоянные ───────────── */

function appFixed_(user, m) {
  appRequire_(user, 'fixed', 'view');
  const sh = m.sheet('Постоянные');
  const last = appLastFilled_(sh, 3, 1, 6);
  const rows = last < 3 ? [] : sh.getRange(3, 1, last - 2, 6).getValues();
  const items = [];
  rows.forEach((r, i) => {
    const article = String(r[1]).trim();
    if (!article) return;
    const sum = appNum_(r[3]);
    items.push({
      row: 3 + i, date: appIso_(r[0], m.tz), article, group: String(r[2]).trim() || 'Прочее',
      sum, payment: String(r[4]).trim(), comment: String(r[5]), paid: sum > 0
    });
  });
  const groups = appDicts_(m).fixedGroups.map((name) => {
    const list = items.filter((x) => x.group === name);
    return { name, total: list.reduce((a, x) => a + x.sum, 0), items: list };
  });
  return { groups, total: items.reduce((a, x) => a + x.sum, 0), unpaid: items.filter((x) => !x.paid).map((x) => x.article) };
}

function appPayFixed_(user, m, p) {
  appRequire_(user, 'fixed', 'edit');
  appCheckDate_(m, p.date);
  const sum = appCheckSum_(p.sum);
  const dicts = appDicts_(m);
  const payment = appText_(p.payment, 100);
  if (dicts.payments.indexOf(payment) < 0) throw appError_('bad_request', 'Неизвестный способ оплаты');
  const sh = m.sheet('Постоянные');
  let row = Number(p.row) || 0;
  if (row) {
    const r = sh.getRange(row, 1, 1, 6).getValues()[0];
    // Ещё не оплаченная статья — заполняем её строку; иначе добавляем новую строку
    if (String(r[1]).trim() !== p.article || appNum_(r[3]) > 0) row = 0;
  }
  const group = dicts.fixedGroups.indexOf(p.group) >= 0 ? p.group : 'Прочее';
  if (!row) {
    row = appLastFilled_(sh, 3, 1, 6) + 1;
    appEnsureRow_(sh, row);
    sh.getRange(row, 2, 1, 2).setValues([[appText_(p.article, 120), group]]);
  }
  const comment = [appText_(p.comment), appAuthorTag_(user)].filter(String).join(' · ');
  sh.getRange(row, 4, 1, 3).setValues([[sum, payment, comment]]);
  appSetDate_(sh.getRange(row, 1), p.date);
  return { row };
}

function appAddFixedItem_(user, m, p) {
  appRequire_(user, 'fixed', 'edit');
  const article = appText_(p.article, 120);
  if (!article) throw appError_('bad_request', 'Укажите название статьи');
  const groups = appDicts_(m).fixedGroups;
  const sh = m.sheet('Постоянные');
  const row = appLastFilled_(sh, 3, 1, 6) + 1;
  appEnsureRow_(sh, row);
  sh.getRange(row, 2, 1, 2).setValues([[article, groups.indexOf(p.group) >= 0 ? p.group : 'Прочее']]);
  return { row };
}

/* ───────────── ЗП и смены ───────────── */

function appPayrollLayout_(sh) {
  const lastCol = sh.getLastColumn();
  const top = sh.getRange(1, 1, 2, lastCol).getValues();
  const summaryCol = top[0].findIndex((x) => String(x).trim() === 'Итог по сотрудникам');
  const employees = [];
  for (let c = 3; c < (summaryCol > 0 ? summaryCol : lastCol); c++) {
    const name = String(top[0][c]).trim();
    if (name && String(top[1][c]).trim() === 'Смена') employees.push({ name, shiftCol: c + 1, accruedCol: c + 2 });
  }
  return { employees, summaryCol: summaryCol + 1 };
}

function appPayroll_(user, m) {
  appRequire_(user, 'payroll', 'own');
  const sh = m.sheet('ЗП');
  const lay = appPayrollLayout_(sh);
  const own = APP_PERMS[user.role].payroll === 'own';
  const visible = own ? lay.employees.filter((e) => e.name === user.employee) : lay.employees;

  const days = appDayRows_(sh, m.tz, 3).map((d) => {
    const shifts = {};
    visible.forEach((e) => { shifts[e.name] = { on: d.v[e.shiftCol - 1] === true, accrued: appNum_(d.v[e.accruedCol - 1]) }; });
    return { date: d.iso, wd: String(d.v[1]), netto: own ? null : appNum_(d.v[2]), shifts };
  });

  // Итог по сотрудникам и журнал выплат — справа на листе
  const sc = lay.summaryCol;
  const right = sh.getRange(1, sc, sh.getLastRow(), 5).getValues();
  const summary = [];
  for (let i = 2; i < right.length; i++) {
    const name = String(right[i][0]).trim();
    if (!name || name === 'Итого') break;
    summary.push({ name, debtStart: appNum_(right[i][1]), accrued: appNum_(right[i][2]), paid: appNum_(right[i][3]), due: appNum_(right[i][4]) });
  }
  const payStart = right.findIndex((r) => String(r[0]).trim() === 'Выплаты');
  const payouts = [];
  for (let i = payStart + 2; payStart >= 0 && i < right.length; i++) {
    const r = right[i];
    if (!(r[0] instanceof Date) && !String(r[1]).trim()) continue;
    payouts.push({ row: i + 1, date: appIso_(r[0], m.tz), employee: String(r[1]).trim(), sum: appNum_(r[2]), payment: String(r[3]).trim(), comment: String(r[4]) });
  }
  payouts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.row - a.row));

  const rates = appRates_(m);
  const names = visible.map((e) => e.name);
  return {
    employees: visible.map((e) => {
      const s = summary.find((x) => x.name === e.name) || {};
      const r = rates.filter((x) => x.employee === e.name);
      return {
        name: e.name,
        shifts: days.filter((d) => d.shifts[e.name] && d.shifts[e.name].on).length,
        debtStart: s.debtStart || 0, accrued: s.accrued || 0, paid: s.paid || 0, due: s.due || 0,
        rates: r
      };
    }),
    days,
    payouts: payouts.filter((x) => names.indexOf(x.employee) >= 0),
    totalAccrued: summary.filter((x) => names.indexOf(x.name) >= 0).reduce((a, x) => a + x.accrued, 0),
    totalDue: summary.filter((x) => names.indexOf(x.name) >= 0).reduce((a, x) => a + x.due, 0),
    canEdit: appCan_(user, 'payroll', 'edit'),
    shiftDaysBack: own ? APP.EMPLOYEE_SHIFT_DAYS_BACK : null
  };
}

function appRates_(m) {
  const s = m.settings;
  const start = s.findIndex((r) => String(r[0]).trim() === 'Сотрудник' && String(r[1]).indexOf('За смену') === 0);
  const out = [];
  for (let i = start + 1; start >= 0 && i < s.length; i++) {
    const name = String(s[i][0]).trim();
    if (!name) break;
    out.push({ employee: name, perShift: appNum_(s[i][1]), pctNetto: appNum_(s[i][2]), from: appIso_(s[i][3], m.tz) });
  }
  return out;
}

function appSetShift_(user, m, p) {
  appRequire_(user, 'shifts', 'own');
  appCheckDate_(m, p.date);
  const sh = m.sheet('ЗП');
  const emp = appPayrollLayout_(sh).employees.find((e) => e.name === p.employee);
  if (!emp) throw appError_('bad_request', 'Нет сотрудника «' + p.employee + '» на листе «ЗП»');
  if (APP_PERMS[user.role].shifts === 'own') {
    if (user.employee !== p.employee) throw appError_('forbidden', 'Можно отмечать только свои смены');
    const today = Utilities.formatDate(new Date(), m.tz, 'yyyy-MM-dd');
    const earliest = Utilities.formatDate(new Date(Date.now() - APP.EMPLOYEE_SHIFT_DAYS_BACK * 86400000), m.tz, 'yyyy-MM-dd');
    if (p.date > today || p.date < earliest) throw appError_('forbidden', 'Смену можно отметить только за сегодня или вчера');
  }
  const day = appDayRows_(sh, m.tz, 3).find((d) => d.iso === p.date);
  if (!day) throw appError_('bad_request', 'Нет строки за ' + p.date);
  sh.getRange(day.row, emp.shiftCol).setValue(!!p.on);
  SpreadsheetApp.flush();
  return { date: p.date, employee: p.employee, on: !!p.on, accrued: appNum_(sh.getRange(day.row, emp.accruedCol).getValue()) };
}

function appAddPayout_(user, m, p) {
  appRequire_(user, 'payroll', 'edit');
  appCheckDate_(m, p.date);
  const sh = m.sheet('ЗП');
  const lay = appPayrollLayout_(sh);
  if (!lay.employees.some((e) => e.name === p.employee)) throw appError_('bad_request', 'Нет такого сотрудника');
  const sum = appCheckSum_(p.sum);
  const sc = lay.summaryCol;
  const colM = sh.getRange(1, sc, sh.getLastRow(), 1).getValues();
  const payStart = colM.findIndex((r) => String(r[0]).trim() === 'Выплаты');
  if (payStart < 0) throw appError_('setup', 'На листе «ЗП» не найден блок «Выплаты»');
  const first = payStart + 3; // строка после заголовка таблицы выплат (номер строки листа)
  const row = appLastFilled_(sh, first, sc, 5) + 1;
  appEnsureRow_(sh, row);
  const comment = [appText_(p.comment), appAuthorTag_(user)].filter(String).join(' · ');
  sh.getRange(row, sc + 1, 1, 4).setValues([[p.employee, sum, appText_(p.payment || 'Наличные', 100), comment]]);
  appSetDate_(sh.getRange(row, sc), p.date);
  return { row };
}

/* ───────────── Деньги (кэшфлоу) ───────────── */

function appCashflow_(user, m) {
  appRequire_(user, 'money', 'view');
  const sh = m.sheet('Кэшфлоу');
  const rows = appDayRows_(sh, m.tz, 3);
  if (!rows.length) return { days: [], now: null, forecast: null, expected: [] };
  const notes = sh.getRange(rows[0].row, 1, rows.length, 13).getNotes();
  const n = appNum_;
  const days = rows.map((d, i) => {
    const v = d.v;
    return {
      date: d.iso, wd: String(v[1]),
      cash: { start: n(v[2]), revenue: n(v[3]), out: n(v[4]), correction: n(v[5]), end: n(v[6]), note: notes[i][5] },
      account: { start: n(v[7]), acquiring: n(v[8]), yandex: n(v[9]), cooper: n(v[10]), out: n(v[11]), correction: n(v[12]), end: n(v[13]), note: notes[i][12] },
      total: n(v[14]), viaCard: n(v[15])
    };
  });
  const info = appMonthInfo_(m);
  const nowDay = days.filter((d) => d.date <= info.today).pop() || days[0];
  const lastDay = days[days.length - 1];
  const expected = [];
  days.filter((d) => d.date > nowDay.date).forEach((d) => {
    if (d.account.yandex > 0) expected.push({ date: d.date, wd: d.wd, source: 'Яндекс Еда', sum: d.account.yandex });
    if (d.account.cooper > 0) expected.push({ date: d.date, wd: d.wd, source: 'Купер', sum: d.account.cooper });
    if (d.account.acquiring > 0) expected.push({ date: d.date, wd: d.wd, source: 'Эквайринг и СБП', sum: d.account.acquiring });
  });
  return {
    days,
    now: { date: nowDay.date, cash: nowDay.cash.end, account: nowDay.account.end, total: nowDay.total },
    forecast: { date: lastDay.date, cash: lastDay.cash.end, account: lastDay.account.end, total: lastDay.total },
    expected,
    canCorrect: appCan_(user, 'money', 'edit')
  };
}

function appAddCorrection_(user, m, p) {
  appRequire_(user, 'money', 'edit');
  appCheckDate_(m, p.date);
  const type = APP_CORRECTIONS[p.type];
  if (!type) throw appError_('bad_request', 'Неизвестный вид корректировки');
  const sh = m.sheet('Кэшфлоу');
  const day = appDayRows_(sh, m.tz, 3).find((d) => d.iso === p.date);
  if (!day) throw appError_('bad_request', 'Нет строки за ' + p.date);
  const v = day.v;
  let dCash = 0, dAcc = 0;
  if (p.type === 'reconcile') {
    // Факт минус учёт на конец выбранного дня
    if (p.cashFact !== '' && p.cashFact !== null && p.cashFact !== undefined) dCash = appNum_(p.cashFact) - appNum_(v[6]);
    if (p.accFact !== '' && p.accFact !== null && p.accFact !== undefined) dAcc = appNum_(p.accFact) - appNum_(v[13]);
  } else {
    const a = appCheckSum_(p.amount);
    dCash = type.cash * a;
    dAcc = type.acc * a;
  }
  dCash = Math.round(dCash * 100) / 100;
  dAcc = Math.round(dAcc * 100) / 100;
  if (!dCash && !dAcc) return { date: p.date, cash: 0, account: 0, unchanged: true };

  const stamp = Utilities.formatDate(new Date(), m.tz, 'dd.MM HH:mm') + ' ' + user.name + ': ' + type.name;
  const comment = appText_(p.comment) ? ' (' + appText_(p.comment) + ')' : '';
  const fmt = (x) => (x > 0 ? '+' : '') + x;
  const apply = (col, delta) => {
    if (!delta) return;
    const cell = sh.getRange(day.row, col);
    cell.setValue(Math.round((appNum_(cell.getValue()) + delta) * 100) / 100);
    const old = cell.getNote();
    cell.setNote((old ? old + '\n' : '') + stamp + ' ' + fmt(delta) + comment);
  };
  apply(6, dCash);   // F: корректировка кассы
  apply(13, dAcc);   // M: корректировка счёта
  return { date: p.date, cash: dCash, account: dAcc };
}

/* ───────────── Пользователи ───────────── */

function appUsersList_(user) {
  appRequire_(user, 'settings', 'edit');
  return appGetUsers_().map(appPublicUser_);
}

function appSaveUser_(user, p) {
  appRequire_(user, 'settings', 'edit');
  const email = appText_(p.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw appError_('bad_request', 'Неверная почта');
  if (!APP_ROLES[p.role]) throw appError_('bad_request', 'Неизвестная роль');
  if (p.role === 'employee' && !appText_(p.employee)) throw appError_('bad_request', 'Для сотрудника выберите имя из листа «ЗП»');
  const users = appGetUsers_();
  const rec = users.find((x) => x.email === (p.originalEmail || email).toLowerCase());
  if (rec && rec.role === 'owner' && p.role !== 'owner' && users.filter((x) => x.role === 'owner').length < 2) {
    throw appError_('bad_request', 'Нельзя убрать последнего владельца');
  }
  const next = { email, name: appText_(p.name, 80) || email, role: p.role, employee: appText_(p.employee, 80) };
  if (rec) Object.assign(rec, next);
  else if (users.some((x) => x.email === email)) throw appError_('bad_request', 'Такая почта уже есть');
  else users.push(next);
  appPutUsers_(users);
  return users.map(appPublicUser_);
}

function appRemoveUser_(user, p) {
  appRequire_(user, 'settings', 'edit');
  const email = String(p.email || '').toLowerCase();
  if (email === user.email) throw appError_('bad_request', 'Нельзя удалить себя');
  const users = appGetUsers_().filter((x) => x.email !== email);
  appPutUsers_(users);
  return users.map(appPublicUser_);
}
