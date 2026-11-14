'use strict';

/* ---------- 基础工具 ---------- */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const todayStr = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const monthStr = () => todayStr().slice(0, 7);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const fmt = n => '¥' + round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt2 = n => round2(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtShort = n => '¥' + round2(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const fmtInt = n => '¥' + Math.round(Number(n) || 0).toLocaleString('zh-CN');
const fmtWage = n => (Number(n) > 0) ? fmtInt(n) : '<span class="muted">未设定</span>';
const wagePaid = w => (w.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
function wageStatus(w) {
  const total = Number(w.amount) || 0;
  const paid = wagePaid(w);
  if (total <= 0) return paid > 0 ? 'partial' : 'pending';
  if (paid <= 0) return 'pending';
  if (paid >= total) return 'paid';
  return 'partial';
}
const absCount = w => (w.absenceDates && w.absenceDates.length) || (w.absence || 0);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysBetween = (from, to) => Math.floor((new Date(to) - new Date(from)) / 86400000);
const stBadge = k => k === 'settled' ? 'ok' : k === 'partial' ? 'info' : 'warn';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.classList.add('show');
  clearTimeout(t._tm);
  t._tm = setTimeout(() => { t.classList.remove('show'); t.classList.add('hidden'); }, 2200);
}

/* ---------- 数据层（IndexedDB） ---------- */
// 全局错误兜底：任何静默失败都以提示浮出，便于定位
window.addEventListener('error', e => { try { toast('出错了：' + (e.message || '未知错误')); } catch (_) {} });
window.addEventListener('unhandledrejection', e => { try { const r = e.reason; toast('操作失败：' + ((r && r.message) || r || '未知错误')); } catch (_) {} });
const STORES = ['customers', 'incomes', 'expenses', 'bills', 'payments', 'invoices', 'employees', 'wages', 'meta'];
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('company-ledger', 7);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
      // 已删除功能的存储清理
      if (db.objectStoreNames.contains('assets')) db.deleteObjectStore('assets');
      if (db.objectStoreNames.contains('purchases')) db.deleteObjectStore('purchases');
      if (db.objectStoreNames.contains('reimbursements')) db.deleteObjectStore('reimbursements');
    };
    req.onsuccess = e => {
      _db = e.target.result;
      _db.onversionchange = () => { _db.close(); };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      alert('本软件在另一个标签页/窗口中还开着旧版本，数据库无法升级。\n\n请把其他打开本软件的页面全部关闭，本页会自动恢复正常（无需手动刷新）。');
    };
  });
}
const dbGetAll = store => new Promise((resolve, reject) => {
  const r = _db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => resolve(r.result || []);
  r.onerror = () => reject(r.error);
});
const dbPut = (store, val) => new Promise((resolve, reject) => {
  const tx = _db.transaction(store, 'readwrite');
  tx.objectStore(store).put(val);
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const dbDel = (store, key) => new Promise((resolve, reject) => {
  const tx = _db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});
const dbClear = store => new Promise((resolve, reject) => {
  const tx = _db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  tx.oncomplete = resolve;
  tx.onerror = () => reject(tx.error);
});

const DEFAULTS = {
  overdueDays: 30,
  seeded: false,
  catGroups: {
    '仓库': ['办公用品', '工具材料', '油费'],
    '车队': ['上车费', '高速费', '油费', '打印费'],
    '员工': ['员工工资', '报销']
  }
};
const LEGACY_CATS = { '工资': ['员工', '员工工资'], '办公用品': ['仓库', '办公用品'], '仓库工具': ['仓库', '工具材料'], '车队报销': ['车队', '其他'] };
const ROLE_ORDER = ['叉车工', '装卸工', '司机', '调度', '操作', '换单'];
let S = { customers: [], incomes: [], expenses: [], bills: [], payments: [], invoices: [], employees: [], wages: [], settings: Object.assign({}, DEFAULTS) };

async function loadState() {
  const [customers, incomes, expenses, bills, payments, invoices, employees, wages, meta] = await Promise.all(STORES.map(dbGetAll));
  S.customers = customers.sort((a, b) => a.createdAt - b.createdAt);
  S.incomes = incomes; S.expenses = expenses; S.bills = bills; S.payments = payments; S.invoices = invoices;
  S.employees = employees.sort((a, b) => a.createdAt - b.createdAt); S.wages = wages;
  // 迁移：旧工资单若有 paidDate 但无 payments → 用已生成的支出记录反推一条 payment
  let needSave = false;
  for (const w of S.wages) {
    if (w.paidDate && (!w.payments || w.payments.length === 0)) {
      const ex = S.expenses.find(x => x.wageId === w.id);
      w.payments = [{ id: uid(), amount: ex ? Number(ex.amount) : Number(w.amount) || 0, date: w.paidDate, note: '' }];
      needSave = true;
    } else if (!w.payments) {
      w.payments = [];
    }
  }
  if (needSave) {
    for (const w of S.wages) {
      if (w.payments && w.payments.length === 1 && !w.payments[0].__migrated) {
        await dbPut('wages', w);
        w.payments[0].__migrated = true;
      }
    }
  }
  const m = {};
  meta.forEach(r => { m[r.id] = r.value; });
  S.settings = Object.assign({}, DEFAULTS, m);
  S.settings.catGroups = Object.assign({}, DEFAULTS.catGroups, S.settings.catGroups || {});
}
const saveSetting = (key, value) => dbPut('meta', { id: key, value: value });

async function migrateCategories() {
  // 车队子分类统一为：上车费/高速费/油费/打印费（员工报销并入支出·车队）
  const FLEET_SUBS = ['上车费', '高速费', '油费', '打印费'];
  if (JSON.stringify(S.settings.catGroups['车队']) !== JSON.stringify(FLEET_SUBS)) {
    S.settings.catGroups['车队'] = FLEET_SUBS;
    await saveSetting('catGroups', S.settings.catGroups);
  }
  // 老数据补上「报销」子分类（历史报销生成的支出仍能显示分类名）
  if (!(S.settings.catGroups['员工'] || []).includes('报销')) {
    S.settings.catGroups['员工'] = (S.settings.catGroups['员工'] || []).concat(['报销']);
    await saveSetting('catGroups', S.settings.catGroups);
  }
  if (S.settings.catMigrated) return;
  let changed = false;
  for (const e2 of S.expenses) {
    const map = LEGACY_CATS[e2.category];
    if (map && !e2.sub) {
      e2.category = map[0];
      e2.sub = map[1];
      await dbPut('expenses', e2);
      changed = true;
    }
  }
  await saveSetting('catMigrated', true);
  if (changed) await loadState();
}

/* ---------- 派生状态 ---------- */
const custName = id => { const c = S.customers.find(c => c.id === id); return c ? c.name : '(已删除客户)'; };
const empName = id => { const e2 = S.employees.find(x => x.id === id); return e2 ? e2.name : '(已删除员工)'; };
const paidOf = billId => round2(S.payments.filter(p => p.billId === billId).reduce((s, p) => s + Number(p.amount), 0));
function billState(b) {
  const paid = paidOf(b.id);
  let remaining = round2(Number(b.amount) - paid);
  let key = 'unpaid', label = '待收';
  if (remaining <= 0) { key = 'settled'; label = '已结清'; remaining = 0; }
  else if (paid > 0)  { key = 'partial'; label = '部分收款'; }
  return { paid, remaining, key, label };
}
function invState(b) {
  const invoiced = round2(S.invoices.filter(i => i.billId === b.id).reduce((s, i) => s + (Number(i.amount) > 0 ? Number(i.amount) : Number(b.amount)), 0));
  const remaining = Math.max(0, round2(Number(b.amount) - invoiced));
  let key = 'none', label = '待开票';
  if (invoiced > 0 && remaining <= 0) { key = 'done'; label = '已开票'; }
  else if (invoiced > 0) { key = 'partial'; label = '部分开票'; }
  return { invoiced, remaining, key, label };
}
const invBadge = k => k === 'done' ? 'ok' : k === 'partial' ? 'info' : 'gray';
/* ---------- 员工报销已并入记一笔支出（待报销挂账模式） ---------- */

/* ---------- 页面切换 ---------- */
let currentPage = 'add';
$$('.nav-btn').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));
function switchPage(p) {
  currentPage = p;
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.page === p));
  $$('.page').forEach(pg => pg.classList.toggle('active', pg.id === 'page-' + p));
  renderPage(p);
}
function renderPage(p) {
  if (p === 'bills') {
    $('#cust-admin').classList.add('hidden');
    $('#cust-edit').classList.add('hidden');
    $('#bills-main').classList.remove('hidden');
  }
  ({ add: renderAdd, bills: renderBills, wages: renderWages, settings: () => {} }[p] || function () {})();
}

/* ---------- 客户页顶部统计 ---------- */
// 本年收入（按客户汇总，降序）：收入流水为主；历史收款（未生成收入流水的 payments）按收款台账兜底补计，不重复
// 收入按客户汇总：收入流水为主；历史收款（未生成收入流水的 payments）按收款台账兜底补计，不重复
// prefix 为 'YYYY'（按年）或 'YYYY-MM'（按月）
function incomeRowsByPrefix(prefix) {
  // 归属时间：优先业务日期；无日期按应收账期归属；再没有用创建时间（兼容早期无日期的收款记录）
  const keyOf = (d, createdAt, period) => {
    if (d) return d;
    if (period) return period;
    if (createdAt) {
      const dt = new Date(createdAt);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
    }
    return '';
  };
  const sums = {};
  const covered = new Set(); // 已计入的收入对应的收款，避免漏计
  S.incomes.forEach(i => {
    if (!keyOf(i.date, i.createdAt).startsWith(prefix)) return;
    sums[i.customerId] = (sums[i.customerId] || 0) + Number(i.amount || 0);
    if (i.paymentId) covered.add(i.paymentId);
  });
  S.payments.forEach(p => {
    if (covered.has(p.id)) return;
    const b = S.bills.find(x => x.id === p.billId);
    if (!b) return;
    if (!keyOf(p.date, p.createdAt, b.period).startsWith(prefix)) return;
    sums[b.customerId] = (sums[b.customerId] || 0) + Number(p.amount || 0);
  });
  return Object.keys(sums)
    .map(cid => ({ cid, amount: round2(sums[cid]) }))
    .sort((a, b) => b.amount - a.amount);
}

function yearIncomeRows() {
  return incomeRowsByPrefix(String(new Date().getFullYear()));
}

function renderUnpaid() {
  const unsettled = S.bills.map(b => ({ b, st: billState(b) })).filter(x => x.st.key !== 'settled');
  $('#stat-unpaid').textContent = fmt(round2(unsettled.reduce((s, x) => s + x.st.remaining, 0)));
  // 本年收入：本年度全部收入（含记一笔现结收入、账单收款及历史收款）
  const rows = yearIncomeRows();
  $('#stat-year-income').textContent = fmt(round2(rows.reduce((s, r) => s + r.amount, 0)));
}

// 点击本年收入卡片：各客户本年收入排名弹窗
function openYearIncomeModal() {
  const year = String(new Date().getFullYear());
  const rows = yearIncomeRows();
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const listHtml = rows.length ? rows.map((r, idx) =>
    '<div class="item-card" style="cursor:default">'
    + '<div class="ic-main">'
    + '<div class="ic-title"><span class="badge badge-gray">' + (idx + 1) + '</span>' + esc(custName(r.cid)) + '</div>'
    + '<div class="ic-sub">占总收入 ' + (total > 0 ? (r.amount / total * 100).toFixed(1) : '0.0') + '%</div>'
    + '</div>'
    + '<div class="ic-right"><div class="ic-amt">' + fmt(r.amount) + '</div></div>'
    + '</div>'
  ).join('') : '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">本年还没有收入记录</div>';
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>本年收入（' + year + '）</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="item-list">' + listHtml + '</div>'
    + (rows.length ? '<div class="kv" style="margin-top:10px;border-bottom:none"><span>合计</span><b>' + fmt(total) + '</b></div>' : '');
  $('#modal-mask').classList.remove('hidden');
}
$('#card-year-income').addEventListener('click', openYearIncomeModal);

/* ---------- 记一笔 ---------- */
const catLabel = r => r.sub ? r.category + ' · ' + r.sub : (r.category || '');

function renderAdd() {
  // page-add 显示月账本，表单按需弹出
  const lm = $('#ledger-month');
  if (lm && !lm.value) lm.value = todayStr().slice(0, 7);
  renderLedger();
}

let ledgerMonthCache = null;
// 点击当月支出：按主分类汇总弹窗（仓库/车队/其他，不含挂账与待报销）
function openExpenseBreakdown() {
  const period = $('#ledger-month').value || todayStr().slice(0, 7);
  const sums = {};
  let reimbSum = 0, payableSum = 0;
  S.expenses.forEach(e => {
    if (!(e.date || '').startsWith(period)) return;
    if (e.status === 'pending') {
      if (e.pendingKind === 'payable') payableSum += Number(e.amount || 0);
      else reimbSum += Number(e.amount || 0);
      return;
    }
    const g = e.category || '其他';
    sums[g] = (sums[g] || 0) + Number(e.amount || 0);
  });
  const rows = Object.keys(sums).map(k => ({ k, amt: round2(sums[k]) })).sort((a, b) => b.amt - a.amt);
  const total = round2(rows.reduce((s, r) => s + r.amt, 0));
  const pendNote = [reimbSum > 0 ? '待报销 ' + fmt2(reimbSum) : '', payableSum > 0 ? '挂账 ' + fmt2(payableSum) : ''].filter(Boolean).join('、');
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + period + ' 支出 · 按主分类</h2><button class="modal-x" data-close>&times;</button></div>'
    + (rows.length
      ? rows.map(r => '<div class="kv"><span>' + esc(r.k) + '</span><span class="strong">' + fmt(r.amt) + '</span></div>').join('')
        + '<div class="kv" style="border-bottom:none"><span class="strong">合计</span><span class="strong neg">' + fmt(total) + '</span></div>'
      : '<div class="empty">本月暂无支出</div>')
    + (pendNote ? '<p class="muted" style="margin-top:10px">另有（未计入支出）：' + pendNote + '</p>' : '');
  $('#modal-mask').classList.remove('hidden');
}
$('#stat-month-expense').addEventListener('click', openExpenseBreakdown);

// 点击当月收入：按来源客户汇总弹窗（含账单收款，与当月收入卡片同口径）
function openIncomeBreakdown() {
  const period = $('#ledger-month').value || todayStr().slice(0, 7);
  const rows = incomeRowsByPrefix(period);
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  const listHtml = rows.length ? rows.map(r =>
    '<div class="kv"><span>' + esc(custName(r.cid)) + '<span class="muted"> · 占比 ' + (total > 0 ? (r.amount / total * 100).toFixed(1) : '0.0') + '%</span></span><span class="strong pos">' + fmt(r.amount) + '</span></div>'
  ).join('') : '<div class="empty">本月暂无收入</div>';
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + period + ' 收入 · 按客户</h2><button class="modal-x" data-close>&times;</button></div>'
    + listHtml
    + (rows.length ? '<div class="kv" style="border-bottom:none;margin-top:4px"><span class="strong">合计</span><span class="strong pos">' + fmt(total) + '</span></div>' : '');
  $('#modal-mask').classList.remove('hidden');
}
$('#stat-month-income').addEventListener('click', openIncomeBreakdown);

function renderLedger() {
  const period = $('#ledger-month').value || todayStr().slice(0, 7);
  ledgerMonthCache = period;
  const [y, m] = period.split('-').map(Number);
  // 当月收支（挂账支出不计入统计）
  // 当月收入：收入流水 + 无对应流水的账单收款（已结清/部分收款都算，不重复）
  const income = round2(incomeRowsByPrefix(period).reduce((s, r) => s + r.amount, 0));
  let expense = 0, reimbSum = 0, payableSum = 0;
  S.expenses.forEach(e => {
    if (!(e.date || '').startsWith(period)) return;
    if (e.status === 'pending') {
      if (e.pendingKind === 'payable') payableSum += Number(e.amount || 0);
      else reimbSum += Number(e.amount || 0);
    } else expense += Number(e.amount || 0);
  });
  const pendNote = [reimbSum > 0 ? '待报销 ' + fmt2(reimbSum) : '', payableSum > 0 ? '挂账 ' + fmt2(payableSum) : ''].filter(Boolean).join('、');
  $('#ledger-income').textContent = '+' + fmt2(income);
  $('#ledger-expense').textContent = '−' + fmt2(expense) + (pendNote ? '（另有' + pendNote + '）' : '');
  if (!$('#ledger-month').value) $('#ledger-month').value = period;
  // 月流水列表（按日期分组）；有搜索词时搜索全部月份
  const all = S.incomes.map(i => ({ id: i.id, store: 'incomes', date: i.date, type: 'income', cat: i.type || '其他收入', who: custName(i.customerId), amount: Number(i.amount), note: i.note }))
    .concat(S.expenses.map(e => ({ id: e.id, store: 'expenses', date: e.date, type: 'expense', cat: catLabel(e), who: '', amount: Number(e.amount), note: e.note, pending: e.status === 'pending', kind: e.pendingKind === 'payable' ? 'payable' : 'reimb' })))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  // 搜索过滤：匹配分类、客户、备注、金额、日期（全部月份）
  const kw = (($('#ledger-search') && $('#ledger-search').value) || '').trim().toLowerCase();
  const filtered = kw
    ? all.filter(r => (r.cat + ' ' + (r.who || '') + ' ' + (r.note || '') + ' ' + r.amount + ' ' + r.date).toLowerCase().includes(kw))
    : all.filter(r => (r.date || '').startsWith(period));
  if (!all.length) {
    const hasAny = S.incomes.length + S.expenses.length > 0;
    $('#ledger-list').innerHTML = '<div class="ledger-list-empty">本月暂无收支<br><span style="font-size:12px">'
      + (hasAny ? '用上方 ‹ › 切换月份查看其他月份记录' : '点右下角 + 添加第一条')
      + '</span></div>';
    return;
  }
  if (!filtered.length) {
    $('#ledger-list').innerHTML = kw
      ? '<div class="ledger-list-empty">没有匹配「' + esc(kw) + '」的收支<br><span style="font-size:12px">换个关键词试试（搜索范围：全部月份）</span></div>'
      : '<div class="ledger-list-empty">本月暂无收支<br><span style="font-size:12px">用上方 ‹ › 切换月份查看其他月份记录</span></div>';
    return;
  }
  const weekday = d => {
    const arr = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return arr[new Date(d).getDay()];
  };
  let html = '';
  let lastDate = '';
  if (kw) {
    html += '<div class="ledger-search-meta">搜索全部月份 · 共 ' + filtered.length + ' 条 <button type="button" class="link-btn" data-clear-search>清空搜索</button></div>';
  }
  filtered.forEach(r => {
    if (r.date !== lastDate) {
      html += '<div class="ledger-day-group"><div class="ledger-day-head"><span class="dot"></span><span>' + r.date + '</span><span class="muted" style="margin-left:4px">' + weekday(r.date) + '</span><span style="flex:1"></span>';
      const dayInc = filtered.filter(x => x.date === r.date && x.type === 'income').reduce((s, x) => s + x.amount, 0);
      const dayExp = filtered.filter(x => x.date === r.date && x.type === 'expense').reduce((s, x) => s + x.amount, 0);
      if (dayInc) html += '<span class="pos" style="font-size:12px;margin-left:8px">收 +' + fmt2(dayInc) + '</span>';
      if (dayExp) html += '<span style="font-size:12px;margin-left:6px;color:#D84848">支 −' + fmt2(dayExp) + '</span>';
      html += '</div>';
      lastDate = r.date;
    }
    const amtSign = r.type === 'income' ? '+' : '−';
    const amtStyle = r.pending ? ' style="color:var(--warn)"' : '';
    const pendBadge = r.pending ? ' <span class="badge badge-warn">' + (r.kind === 'payable' ? '挂账' : '待报销') + '</span>' : '';
    html += '<div class="ledger-item ' + r.type + '" data-ledger="' + r.store + ':' + r.id + '">'
      + '<div class="li-main">'
      + '<div class="li-cat">' + esc(r.cat) + (r.who ? ' · ' + esc(r.who) : '') + pendBadge + '</div>'
      + '<div class="li-note">' + esc(r.note || '') + '</div>'
      + '</div>'
      + '<div class="li-amt"' + amtStyle + '>' + amtSign + fmt2(r.amount) + '</div>'
      + '<div class="li-date"></div>'
      + '</div>';
  });
  $('#ledger-list').innerHTML = html;
}

function renderTxSubs() {
  const g = $('#tx-group').value;
  const wrap = $('#wrap-subcategory');
  const subs = S.settings.catGroups[g] || [];
  if (g !== '其他' && subs.length) {
    wrap.classList.remove('hidden');
    $('#tx-category').innerHTML = subs.map(s => '<option>' + esc(s) + '</option>').join('');
  } else {
    wrap.classList.add('hidden');
  }
}

function initTxForm() {
  $('#tx-date').value = todayStr();
  $('#tx-amount').value = '';
  $('#tx-note').value = '';
  $('#tx-status').value = 'paid';
  $('#wrap-tx-date').classList.remove('hidden');
  if (!$('#tx-group').value) $('#tx-group').value = '仓库';
  renderTxSubs();
  const lastInc = S.settings.lastIncCustomer;
  if (lastInc && S.customers.some(c => c.id === lastInc)) $('#inc-customer').value = lastInc;
  setTxTab('expense');
  // 滚动到 modal 顶部
  const mask = $('#modal-mask');
  if (mask) mask.scrollTop = 0;
}

let txTab = 'expense';
function setTxTab(t) {
  txTab = t;
  const inc = t === 'income';
  $('#tx-title').textContent = inc ? '记一笔收入' : '记一笔支出';
  $('#seg-expense').classList.toggle('active', !inc);
  $('#seg-income').classList.toggle('active', inc);
  $('#wrap-tx-group').classList.toggle('hidden', inc);
  $('#wrap-subcategory').classList.toggle('hidden', inc);
  $('#wrap-tx-status').classList.toggle('hidden', inc);
  $('#wrap-inc-customer').classList.toggle('hidden', !inc);
  $('#wrap-inc-type').classList.toggle('hidden', !inc);
  $('#wrap-tx-date').classList.toggle('hidden', !inc && $('#tx-status').value !== 'paid');
  $('#tx-note').placeholder = inc ? '选填，可写车牌/事项' : '选填，可写司机名/供应商名';
  $('#tx-hint').textContent = inc
    ? '收入即时入账，自动计入该客户的「现结收入」'
    : '选「挂账」或「待报销」先挂账，不计入支出统计；点流水里的挂账条目可登记付款或确认报销，之后计入支出';
}

function openTxForm() {
  const tpl = $('#tx-form-modal');
  $('#modal').innerHTML = tpl.innerHTML;
  $('#modal-mask').classList.remove('hidden');
  $('#inc-customer').innerHTML = S.customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  initTxForm();
  bindTxFormEvents();
}

// 客户页：添加月账单（应收台账，与收支无关）
function openBillForm() {
  $('#modal').innerHTML = $('#bill-form-modal').innerHTML;
  $('#modal-mask').classList.remove('hidden');
  const prev = $('#bill3-customer').value;
  $('#bill3-customer').innerHTML = S.customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  const lastC = prev || S.settings.lastBillCustomer;
  if (lastC && S.customers.some(c => c.id === lastC)) $('#bill3-customer').value = lastC;
  $('#bill3-period').value = monthStr();
  $('#bill3-amount').value = '';
  $('#btn-save-bill3').addEventListener('click', saveBill3);
  $('#bill3-amount').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveBill3(); } });
}

async function saveBill3() {
  const cid = $('#bill3-customer').value;
  const period = $('#bill3-period').value;
  const amount = round2($('#bill3-amount').value);
  if (!cid) { toast('请先添加顾客'); return; }
  if (!period) { toast('请选择月份'); return; }
  if (!amount || amount <= 0) { toast('请输入正确金额'); return; }
  const dup = S.bills.some(b => b.customerId === cid && b.period === period);
  if (dup && !confirm('该顾客这个月份已有账单，确定再添加一张吗？')) return;
  await dbPut('bills', { id: uid(), customerId: cid, feeType: '进仓费', period: period, amount: amount, billDate: '', createdAt: Date.now() });
  await saveSetting('lastBillCustomer', cid);
  await loadState();
  closeModal();
  renderBills();
  toast('月账单已添加（待收）');
}

// 弹窗内容是动态注入的，事件必须在注入后再绑定
function bindTxFormEvents() {
  $('#seg-expense').addEventListener('click', () => setTxTab('expense'));
  $('#seg-income').addEventListener('click', () => setTxTab('income'));
  $('#tx-group').addEventListener('change', renderTxSubs);
  $('#tx-status').addEventListener('change', () => {
    $('#wrap-tx-date').classList.toggle('hidden', $('#tx-status').value !== 'paid');
  });
  $('#btn-save-tx').addEventListener('click', saveTx);
  ['#tx-amount', '#tx-note'].forEach(sel => {
    $(sel).addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); saveTx(); }
    });
  });
}

// 保存后跳到记录所在月份，滚动定位并高亮新增条目
function revealLedgerRecord(store, id, date) {
  if (currentPage !== 'add') { renderUnpaid(); return; }
  const period = (date || '').slice(0, 7);
  if (period) $('#ledger-month').value = period;
  renderLedger();
  setTimeout(() => {
    const el = document.querySelector('[data-ledger="' + store + ':' + id + '"]');
    if (!el) return;
    el.classList.add('flash-new');
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => el.classList.remove('flash-new'), 1800);
  }, 30);
}

async function saveTx() {
  const amount = round2($('#tx-amount').value);
  const note = $('#tx-note').value.trim();
  if (!amount || amount <= 0) { toast('请输入正确金额'); return; }
  if (txTab === 'income') {
    const cid = $('#inc-customer').value;
    const date = $('#tx-date').value;
    if (!cid) { toast('请先添加客户'); return; }
    if (!date) { toast('请选择日期'); return; }
    const newId = uid();
    await dbPut('incomes', { id: newId, date: date, type: $('#inc-type').value, customerId: cid, amount: amount, note: note, createdAt: Date.now() });
    await saveSetting('lastIncCustomer', cid);
    await loadState();
    closeModal();
    revealLedgerRecord('incomes', newId, date);
    toast('收入已保存，计入客户现结收入');
    return;
  }
  const statusVal = $('#tx-status').value;
  const isPending = statusVal !== 'paid';
  const date = isPending ? todayStr() : $('#tx-date').value;
  if (!isPending && !date) { toast('请选择日期'); return; }
  if (S.expenses.some(r => r.date === date && round2(Number(r.amount)) === amount)) {
    if (!confirm(date + ' 已有一笔相同金额的支出，是否重复录入？')) return;
  }
  const group = $('#tx-group').value;
  const sub = (group === '仓库' || group === '车队') ? ($('#tx-category').value || '') : '';
  const newId = uid();
  await dbPut('expenses', { id: newId, date: date, category: group, sub: sub, amount: amount, note: note, status: isPending ? 'pending' : null, pendingKind: isPending ? (statusVal === 'reimb' ? 'reimb' : 'payable') : null, createdAt: Date.now() });
  await loadState();
  closeModal();
  revealLedgerRecord('expenses', newId, date);
  toast(isPending ? (statusVal === 'reimb' ? '已挂账（待报销）' : '已挂账') : '已保存');
}

let currentLedgerId = null;
$('#ledger-search').addEventListener('input', renderLedger);
$('#ledger-list').addEventListener('click', e => {
  if (e.target.closest('[data-clear-search]')) {
    $('#ledger-search').value = '';
    renderLedger();
    return;
  }
  const item = e.target.closest('[data-ledger]');
  if (!item) return;
  const [store, id] = item.dataset.ledger.split(':');
  const rec = store === 'incomes' ? S.incomes.find(x => x.id === id) : S.expenses.find(x => x.id === id);
  if (!rec) return;
  currentLedgerId = { store: store, id: id };
  const isInc = store === 'incomes';
  const pending = !isInc && rec.status === 'pending';
  const kind = rec.pendingKind === 'payable' ? 'payable' : 'reimb';
  const pendLabel = kind === 'payable' ? '挂账' : '待报销';
  const payLabel = kind === 'payable' ? '登记付款' : '确认报销';
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + (isInc ? '收入详情' : '支出详情') + (pending ? ' <span class="badge badge-warn">' + pendLabel + '</span>' : '') + '</h2><button class="modal-x" data-close>&times;</button></div>'
    + (isInc
      ? '<div class="kv"><span>客户</span><b>' + esc(custName(rec.customerId)) + '</b></div>'
        + '<div class="kv"><span>费用类型</span><b>' + esc(rec.type || '—') + '</b></div>'
      : '<div class="kv"><span>分类</span><b>' + esc(catLabel(rec)) + '</b></div>')
    + (pending
      ? '<div class="kv"><span>日期</span><b>' + (rec.date || '—') + '</b></div>'
        + '<div class="form-grid" style="margin-top:10px;margin-bottom:0">'
        + '<label>金额（元） <input type="number" id="le-amount" min="0.01" step="0.01" inputmode="decimal" value="' + rec.amount + '"></label>'
        + '<label>备注 <input type="text" id="le-note" value="' + esc(rec.note || '') + '"></label>'
        + '</div>'
      : '<div class="form-grid" style="margin-top:12px;margin-bottom:0">'
        + '<label>日期 <input type="date" id="le-date" value="' + (rec.date || '') + '"></label>'
        + '<label>金额（元） <input type="number" id="le-amount" min="0.01" step="0.01" inputmode="decimal" value="' + rec.amount + '"></label>'
        + '<label class="span2">备注 <input type="text" id="le-note" value="' + esc(rec.note || '') + '"></label>'
        + '</div>')
    + '<button class="primary" id="btn-ledger-save" style="margin-top:12px">保存修改</button>'
    + (pending
      ? '<div class="inline-form" style="margin-top:12px"><input type="date" id="ledger-pay-date" value="' + todayStr() + '"><button class="primary small" id="btn-ledger-pay">' + payLabel + '</button></div>'
        + '<p class="muted" style="margin-top:8px">确认后计入所选日期的支出统计（原挂账日期为 ' + (rec.date || '—') + '）</p>'
      : '')
    + '<div class="modal-foot"><button class="ghost danger" id="btn-ledger-del">删除这条记录</button></div>';
  $('#modal-mask').classList.remove('hidden');
});

// FAB 打开新增表单
$('#fab-add').addEventListener('click', openTxForm);
$('#card-add-bill').addEventListener('click', () => {
  openBillForm();
});

// 月份切换
$('#ledger-month').addEventListener('change', renderLedger);
function shiftMonth(delta) {
  const [y, m] = ($('#ledger-month').value || todayStr().slice(0, 7)).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  $('#ledger-month').value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  renderLedger();
}
// 滚到底部再往下 → 上个月；滚到顶部再往上 → 下个月
(function ledgerSwipe() {
  const THRESHOLD = 70;
  let startY = 0, startX = 0, tracking = false, lastJump = 0;
  const scroller = () => document.scrollingElement || document.documentElement;
  const atBottom = () => {
    const s = scroller();
    return s.scrollTop + window.innerHeight >= s.scrollHeight - 4;
  };
  const atTop = () => scroller().scrollTop <= 2;
  const canJump = () => Date.now() - lastJump > 700;

  window.addEventListener('touchstart', e => {
    if (!document.getElementById('page-add').classList.contains('active')) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    tracking = true;
  }, { passive: true });

  window.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    if (!document.getElementById('page-add').classList.contains('active')) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - startY;
    const dx = t.clientX - startX;
    if (Math.abs(dx) > Math.abs(dy)) return;      // 横向滑动忽略
    if (Math.abs(dy) < THRESHOLD) return;
    if (!canJump()) return;
    if (atBottom() && dy < 0) {                   // 到底后继续往下滑 → 上个月
      lastJump = Date.now();
      shiftMonth(-1);
      window.scrollTo(0, 0);
    } else if (atTop() && dy > 0) {               // 到顶后继续往上拉 → 下个月
      lastJump = Date.now();
      shiftMonth(1);
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  // 电脑端：鼠标滚轮在边界继续滚动同样切月
  window.addEventListener('wheel', e => {
    if (!document.getElementById('page-add').classList.contains('active')) return;
    if (!canJump()) return;
    if (atBottom() && e.deltaY > 0) {
      lastJump = Date.now();
      shiftMonth(-1);
      window.scrollTo(0, 0);
    } else if (atTop() && e.deltaY < 0) {
      lastJump = Date.now();
      shiftMonth(1);
      window.scrollTo(0, 0);
    }
  }, { passive: true });
})();

/* ---------- 应收账单 ---------- */
function renderBills() {
  // 固定只展示待收（含部分收款）的账单
  const list = S.bills.slice()
    .sort((a, b) => b.period.localeCompare(a.period) || (b.billDate || '').localeCompare(a.billDate || ''))
    .filter(b => ['unpaid', 'partial'].includes(billState(b).key));

  // 按顾客折叠分组（组头含客户信息），默认收起
  const billCardHtml = b => {
    const st = billState(b);
    const ist = invState(b);
    return '<div class="item-card" data-bill="' + b.id + '">'
      + '<div class="ic-main">'
      + '<div class="ic-title"><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span><span class="badge badge-' + invBadge(ist.key) + '">' + ist.label + '</span></div>'
      + '<div class="ic-sub">' + esc(b.period) + (b.feeType ? ' · ' + esc(b.feeType) : '') + ' · 已收 ' + fmt(st.paid) + '</div>'
      + '</div>'
      + '<div class="ic-right"><div class="ic-amt">' + fmt(b.amount) + '</div><div class="ic-sub2">待收 ' + fmt(st.remaining) + '</div></div>'
      + '</div>';
  };
  // 默认展示所有客户，无待收账单的客户显示「全部已结清」
  const order = [];
  S.customers.forEach(c => order.push(c.id));
  list.forEach(b => { if (!order.includes(b.customerId)) order.push(b.customerId); });
  const html = order.map(cid => {
    const bills = list.filter(b => b.customerId === cid);
    const sum = bills.reduce((acc, b) => { acc.remaining += billState(b).remaining; return acc; }, { remaining: 0 });
    const inc = round2(S.incomes.filter(i => i.customerId === cid).reduce((s, i) => s + Number(i.amount), 0));
    const isOpen = expandedBillGroups.has(cid);
    const stateText = bills.length
      ? '待收 ' + bills.length + ' 张'
      : (S.bills.some(b => b.customerId === cid) ? '全部已结清' : '暂无账单');
    const sub = stateText + ' · 现结收入 ' + fmt(inc);
    return '<div class="bill-group">'
      + '<div class="item-card bill-group-head" data-group="' + cid + '">'
      + '<div class="ic-main">'
      + '<div class="ic-title">' + esc(custName(cid)) + (bills.length ? '<span class="badge badge-gray">' + bills.length + ' 张</span>' : '') + '</div>'
      + '<div class="ic-sub">' + sub + '</div>'
      + '</div>'
      + '<div class="ic-right"><div class="ic-amt ' + (sum.remaining > 0 ? 'neg' : '') + '">' + fmt(sum.remaining > 0 ? sum.remaining : 0) + '</div><div class="ic-sub2">' + (isOpen ? '收起 ▲' : '展开 ▼') + '</div></div>'
      + '</div>'
      + (isOpen ? '<div class="bill-group-inner">' + bills.map(billCardHtml).join('') + '<div class="group-foot"><button class="ghost small" data-custdetail="' + cid + '">客户详情</button></div></div>' : '')
      + '</div>';
  }).join('') || '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">暂无客户，点上方「客户管理」添加</div>';
  $('#bills-list').innerHTML = html;
  renderUnpaid();
}
const expandedBillGroups = new Set();

$('#bills-list').addEventListener('click', e => {
  const head = e.target.closest('.bill-group-head');
  if (head) {
    const cid = head.dataset.group;
    if (expandedBillGroups.has(cid)) expandedBillGroups.delete(cid);
    else expandedBillGroups.add(cid);
    renderBills();
    return;
  }
  const tr = e.target.closest('.item-card[data-bill]');
  if (tr) { openBillModal(tr.dataset.bill); return; }
  const cd = e.target.closest('[data-custdetail]');
  if (cd) openCustModal(cd.dataset.custdetail);
});

/* ---------- 账单详情弹窗 ---------- */
let currentBillId = null;
function openBillModal(billId) {
  const b = S.bills.find(x => x.id === billId);
  if (!b) return;
  currentBillId = billId;
  const st = billState(b);
  const ist = invState(b);
  const invs = S.invoices.filter(i => i.billId === b.id).sort((a, b2) => a.date.localeCompare(b2.date));
  const pays = S.payments.filter(p => p.billId === b.id).sort((a, b2) => a.date.localeCompare(b2.date));

  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + esc(custName(b.customerId)) + ' · ' + esc(b.period) + ' 账单</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="kv"><span>账单金额</span><b>' + fmt(b.amount) + '</b></div>'
    + '<div class="kv"><span>已收 / 待收</span><b>' + fmt(st.paid) + ' / <span class="strong">' + fmt(st.remaining) + '</span></b></div>'
    + '<div class="kv"><span>收款状态</span><b><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span></b></div>'
    + '<div class="kv"><span>开票状态</span><b><span class="badge badge-' + invBadge(ist.key) + '">' + ist.label + '</span></b></div>'
    + '<div class="kv"><span>已开票 / 待开</span><b>' + fmt(ist.invoiced) + ' / <span class="strong">' + fmt(ist.remaining) + '</span></b></div>'
    + '<div class="sub-title">收款记录</div>'
    + '<table class="mini-table"><thead><tr><th>日期</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>'
    + (pays.map(p => '<tr><td>' + (p.date || '—') + '</td><td>' + fmt(p.amount) + '</td><td>' + esc(p.note || '') + '</td>'
        + '<td><button class="link-btn danger" data-delpay="' + p.id + '">删除</button></td></tr>').join('')
      || '<tr><td colspan="4" class="empty">还没有收款</td></tr>')
    + '</tbody></table>'
    + (st.key !== 'settled'
      ? '<div class="inline-form">'
        + '<input type="date" id="pay-date" value="' + todayStr() + '">'
        + '<input type="number" id="pay-amount" placeholder="金额" step="0.01" min="0.01" value="' + (st.remaining > 0 ? st.remaining : '') + '">'
        + '<input type="text" id="pay-note" placeholder="备注（选填）">'
        + '<button class="primary small" id="btn-add-pay">登记收款</button></div>'
        + '<p class="muted" style="margin-top:8px">登记收款后自动在「记一笔」生成收入流水</p>'
      : '<p class="muted" style="margin-top:8px">账单已结清</p>')
    + '<div class="sub-title">开票记录</div>'
    + '<table class="mini-table"><thead><tr><th>日期</th><th>开票金额</th><th></th></tr></thead><tbody>'
    + (invs.map(v => '<tr><td>' + (v.date || '—') + '</td><td>' + fmt(Number(v.amount) > 0 ? v.amount : b.amount) + '</td>'
        + '<td><button class="link-btn danger" data-delinv="' + v.id + '">删除</button></td></tr>').join('')
      || '<tr><td colspan="3" class="empty">还没有开票</td></tr>')
    + '</tbody></table>'
    + (ist.key !== 'done'
      ? '<div class="inline-form">'
        + '<input type="number" id="inv-amount" placeholder="开票金额" step="0.01" min="0.01" inputmode="decimal" value="' + (ist.remaining > 0 ? ist.remaining : '') + '">'
        + '<input type="date" id="inv-date" value="' + todayStr() + '">'
        + '<button class="primary small" id="btn-add-inv">登记开票</button></div>'
      : '<p class="muted" style="margin-top:8px">发票已全部开完</p>')
    + '<div class="modal-foot"><button class="ghost danger" id="btn-del-bill">删除整张账单</button></div>';
  $('#modal-mask').classList.remove('hidden');
}

function closeModal() { $('#modal-mask').classList.add('hidden'); currentBillId = null; currentWageId = null; }
$('#modal-mask').addEventListener('click', e => { if (e.target.id === 'modal-mask') closeModal(); });

const handleModalClick = async e => {
  const t = e.target;
  if (t.closest('[data-close]')) { closeModal(); return; }

  if (t.id === 'btn-add-emp') {
    const name = $('#emp-name').value.trim();
    const role = $('#emp-role').value;
    if (!name) { toast('请输入员工姓名'); return; }
    if (!role) { toast('请选择职位'); return; }
    if (S.employees.some(e2 => e2.name === name)) { toast('员工已存在'); return; }
    await dbPut('employees', { id: uid(), name: name, role: role, active: true, createdAt: Date.now() });
    await loadState();
    $('#emp-name').value = '';
    $('#emp-role').value = '';
    renderEmpList();
    toast('员工已添加');
    return;
  }
  if (t.dataset.toggleEmp) {
    const emp = S.employees.find(x => x.id === t.dataset.toggleEmp);
    if (!emp) return;
    if (emp.active && !confirm('将「' + emp.name + '」设为离职？离职后生成工资单不再包含该员工。')) return;
    emp.active = !emp.active;
    await dbPut('employees', emp);
    await loadState();
    renderEmpList();
    return;
  }
  if (t.dataset.delEmp) {
    const emp = S.employees.find(x => x.id === t.dataset.delEmp);
    if (!emp) return;
    if (S.wages.some(w => w.employeeId === emp.id)) { alert('该员工已有工资单记录，不能删除；可设为离职'); return; }
    if (!confirm('确定删除员工「' + emp.name + '」？')) return;
    await dbDel('employees', emp.id);
    await loadState();
    renderEmpList();
    toast('员工已删除');
    return;
  }
  if (t.id === 'btn-gen-wages') {
    const period = $('#wage-period').value;
    if (!period) { toast('请选择工资月份'); return; }
    const empId = $('#wage-emp-select').value;
    if (!empId) { toast('请选择员工'); return; }
    const amount = Math.round(Number($('#wage-amount').value) || 0);
    const absence = Math.max(0, Math.round(Number($('#wage-absence').value) || 0));
    if (S.wages.some(w => w.employeeId === empId && w.period === period)) { toast('该员工本月工资已生成'); return; }
    await dbPut('wages', { id: uid(), employeeId: empId, period: period, amount: amount, absence: absence, absenceDates: [], paidDate: null, payments: [], createdAt: Date.now() });
    await loadState();
    closeModal();
    renderWageList();
    toast('已生成 ' + empName(empId) + ' ' + period + ' 工资');
    return;
  }

  if (t.id === 'btn-add-cust') {
    const name = $('#cust-name').value.trim();
    if (!name) { toast('请输入客户名称'); return; }
    if (S.customers.some(c => c.name === name)) { toast('客户已存在'); return; }
    await dbPut('customers', { id: uid(), name: name, business: $('#cust-business').value.trim(), pricing: { cash: $('#cust-pricing-cash').value.trim(), monthly: $('#cust-pricing-monthly').value.trim() }, createdAt: Date.now() });
    await loadState();
    closeModal();
    renderBills();
    toast('客户已添加');
    $('#card-cust-manage').click(); // 刷新客户管理页
    return;
  }
  if (t.closest('[data-rencust-modal]')) {
    openCustEdit(t.closest('[data-rencust-modal]').dataset.rencustModal);
    return;
  }
  if (t.id === 'btn-cust-rename-save') {
    const cid = t.dataset.custId;
    const c = S.customers.find(x => x.id === cid);
    if (!c) return;
    const name = $('#cust-rename').value.trim();
    if (!name) { toast('请输入客户名称'); return; }
    if (S.customers.some(x => x.name === name && x.id !== cid)) { toast('客户已存在'); return; }
    await dbPut('customers', Object.assign({}, c, { name: name, contact: $('#cust-contact-edit').value.trim(), business: $('#cust-business-edit').value.trim(), pricing: { cash: $('#cust-pricing-cash-edit').value.trim(), monthly: $('#cust-pricing-monthly-edit').value.trim() } }));
    await loadState();
    closeModal();
    renderBills();
    toast('已保存');
    $('#card-cust-manage').click(); // 刷新客户管理页
    return;
  }
  if (t.closest('[data-delcust-modal]')) {
    const del = t.closest('[data-delcust-modal]');
    const cid = del.dataset.delcustModal;
    const c = S.customers.find(x => x.id === cid);
    if (!c) return;
    const used = S.incomes.some(i => i.customerId === cid) || S.bills.some(b => b.customerId === cid);
    if (used) { toast('该客户已有收入/账单记录，不能删除'); return; }
    if (!confirm('确定删除客户「' + c.name + '」？')) return;
    await dbDel('customers', cid);
    await loadState();
    renderBills();
    $('#card-cust-manage').click(); // 刷新客户管理页
    return;
  }

  if (t.id === 'btn-add-pay') {
    const date = $('#pay-date').value || todayStr();
    const amount = round2($('#pay-amount').value);
    const note = $('#pay-note').value.trim();
    if (!amount || amount <= 0) { toast('请输入正确金额'); return; }
    const bill = S.bills.find(x => x.id === currentBillId);
    if (!bill) return;
    const pid = uid();
    await dbPut('payments', { id: pid, billId: currentBillId, date: date, amount: amount, note: note, createdAt: Date.now() });
    // 收款自动生成收入流水（记一笔可见，删除收款时联动删除）
    await dbPut('incomes', { id: uid(), date: date, type: bill.feeType || '账单收款', customerId: bill.customerId, amount: amount, note: note, billId: bill.id, paymentId: pid, createdAt: Date.now() });
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    toast('收款已登记，收入已计入记一笔');
    return;
  }
  if (t.dataset.delpay) {
    if (!confirm('删除这笔收款？「记一笔」中对应的收入将一并删除。')) return;
    for (const inc of S.incomes.filter(i => i.paymentId === t.dataset.delpay)) await dbDel('incomes', inc.id);
    await dbDel('payments', t.dataset.delpay);
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    return;
  }
  if (t.id === 'btn-add-inv') {
    const amount = round2($('#inv-amount').value);
    const date = $('#inv-date').value;
    if (!amount || amount <= 0) { toast('请输入正确金额'); return; }
    await dbPut('invoices', { id: uid(), billId: currentBillId, invoiceNo: '', amount: amount, date: date, createdAt: Date.now() });
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    toast('开票已登记');
    return;
  }
  if (t.dataset.delinv) {
    if (!confirm('删除这条发票记录？')) return;
    await dbDel('invoices', t.dataset.delinv);
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    return;
  }
  if (t.id === 'btn-del-bill') {
    if (!confirm('删除账单将同时删除它的收款、发票记录及记一笔中生成的收入，确定吗？')) return;
    const bid = currentBillId;
    for (const inc of S.incomes.filter(i => i.billId === bid)) await dbDel('incomes', inc.id);
    for (const p of S.payments.filter(p => p.billId === bid)) await dbDel('payments', p.id);
    for (const iv of S.invoices.filter(i => i.billId === bid)) await dbDel('invoices', iv.id);
    await dbDel('bills', bid);
    await loadState();
    closeModal();
    renderBills();
    toast('账单已删除');
  }

  if (t.id === 'btn-wage-amount-save') {
    const w = S.wages.find(x => x.id === currentWageId);
    if (!w) return;
    const val = Math.max(0, Math.round(Number($('#wage-amount-edit').value) || 0));
    w.amount = val;
    await dbPut('wages', w);
    await loadState();
    openWageModal(currentWageId);
    renderWages();
    toast(val > 0 ? '工资金额已更新' : '工资金额已清空');
    return;
  }
  if (t.id === 'btn-wage-pay-add') {
    const w = S.wages.find(x => x.id === currentWageId);
    if (!w) return;
    const total = Number(w.amount) || 0;
    if (total <= 0) { toast('请先填写工资金额'); return; }
    const paidBefore = wagePaid(w);
    const remain = Math.max(0, total - paidBefore);
    let amt = Math.round(Number($('#wage-pay-amount').value) || 0);
    if (!amt || amt <= 0) amt = remain; // 留空=全部剩余
    const date = $('#wage-pay-date').value;
    const note = $('#wage-pay-note').value.trim();
    if (!date) { toast('请选择发放日期'); return; }
    if (amt > remain) { if (!confirm('本次发放金额（' + fmtInt(amt) + '）超过剩余待发（' + fmtInt(remain) + '），确定吗？')) return; }
    w.payments = w.payments || [];
    const pid = uid();
    w.payments.push({ id: pid, amount: amt, date: date, note: note });
    w.paidDate = date; // latest payment date, kept for backward-compat display
    await dbPut('wages', w);
    await dbPut('expenses', { id: uid(), date: date, category: '员工', sub: '员工工资', amount: amt, note: empName(w.employeeId) + ' ' + w.period + ' 工资发放' + (note ? '（' + note + '）' : ''), wageId: w.id, paymentId: pid, createdAt: Date.now() });
    await loadState();
    openWageModal(currentWageId);
    renderWages();
    const stAfter = wageStatus(w);
    toast(stAfter === 'paid' ? '已全额发放' : '登记发放成功（累计 ' + fmtInt(wagePaid(w)) + '）');
    return;
  }
  if (t.dataset.delWagePay) {
    const w = S.wages.find(x => x.id === currentWageId);
    if (!w) return;
    const pid = t.dataset.delWagePay;
    const pay = (w.payments || []).find(p => p.id === pid);
    if (!pay) return;
    if (!confirm('删除这条发放记录？对应的工资支出也将一并删除。')) return;
    // 删对应支出
    const exToDel = S.expenses.filter(x => x.wageId === w.id && (x.paymentId === pid || (x.amount == pay.amount && !x.paymentId)));
    for (const ex of exToDel) await dbDel('expenses', ex.id);
    w.payments = (w.payments || []).filter(p => p.id !== pid);
    // 自动维护 paidDate（最后一条发放日期，无则清空）
    if (w.payments.length) {
      w.payments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      w.paidDate = w.payments[0].date;
    } else {
      w.paidDate = null;
    }
    await dbPut('wages', w);
    await loadState();
    openWageModal(currentWageId);
    renderWages();
    return;
  }
  if (t.id === 'btn-wage-del') {
    const w = S.wages.find(x => x.id === currentWageId);
    if (!w) return;
    const hasPay = (w.payments || []).length > 0;
    if (!confirm('删除这张工资单？' + (hasPay ? '所有发放记录及对应的工资支出将一并删除。' : ''))) return;
    for (const ex of S.expenses.filter(x => x.wageId === w.id)) await dbDel('expenses', ex.id);
    await dbDel('wages', w.id);
    await loadState();
    closeModal();
    renderWages();
    toast('工资单已删除');
  }

  if (t.id === 'btn-ledger-save') {
    if (!currentLedgerId) return;
    const store = currentLedgerId.store;
    const rec = (store === 'incomes' ? S.incomes : S.expenses).find(x => x.id === currentLedgerId.id);
    if (!rec) return;
    const amt = Number($('#le-amount').value);
    if (!isFinite(amt) || amt <= 0) { toast('金额需大于 0'); return; }
    const dateEl = $('#le-date');
    if (dateEl) {
      if (!dateEl.value) { toast('请选择日期'); return; }
      rec.date = dateEl.value;
    }
    rec.amount = amt;
    rec.note = $('#le-note').value.trim();
    await dbPut(store, rec);
    await loadState();
    closeModal();
    currentLedgerId = null;
    renderLedger(); renderBills(); renderUnpaid();
    toast('已保存修改');
    return;
  }

  if (t.id === 'btn-ledger-pay') {
    if (!currentLedgerId) return;
    const rec = S.expenses.find(x => x.id === currentLedgerId.id);
    if (!rec) return;
    const date = $('#ledger-pay-date').value;
    if (!date) { toast('请选择报销日期'); return; }
    const wasPayable = rec.pendingKind === 'payable';
    rec.date = date;
    rec.status = null;
    rec.pendingKind = null;
    await dbPut('expenses', rec);
    await loadState();
    closeModal();
    currentLedgerId = null;
    renderLedger();
    toast(wasPayable ? '付款已登记，计入 ' + date + ' 支出' : '已确认报销，计入 ' + date + ' 支出');
    return;
  }
  if (t.id === 'btn-ledger-del') {
    if (!currentLedgerId) return;
    if (!confirm('删除这条记录？')) return;
    await dbDel(currentLedgerId.store, currentLedgerId.id);
    await loadState();
    closeModal();
    currentLedgerId = null;
    renderLedger();
    toast('已删除');
    return;
  }

  if (t.classList.contains('cal-day') && t.dataset.absDay) {
    const w = S.wages.find(x => x.id === currentWageId);
    if (!w) return;
    const day = Number(t.dataset.absDay);
    const d = w.period + '-' + String(day).padStart(2, '0');
    const dates = (w.absenceDates || []).slice();
    const idx = dates.indexOf(d);
    if (idx >= 0) dates.splice(idx, 1); else dates.push(d);
    w.absenceDates = dates;
    w.absence = dates.length;
    await dbPut('wages', w);
    await loadState();
    openWageModal(currentWageId);
    renderWages();
    return;
  }
};
$('#modal').addEventListener('click', handleModalClick);
$('#cust-admin').addEventListener('click', e => {
  const d = e.target.closest('[data-cust-detail]');
  if (d && !e.target.closest('[data-rencust-modal]') && !e.target.closest('[data-delcust-modal]')) {
    openCustInfoModal(d.dataset.custDetail);
    return;
  }
  handleModalClick(e);
});

$('#modal').addEventListener('keydown', e => {
  if ((e.target.id === 'wage-pay-amount' || e.target.id === 'wage-pay-date' || e.target.id === 'wage-pay-note') && e.key === 'Enter') {
    e.preventDefault();
    const btn = $('#btn-wage-pay-add');
    if (btn && !btn.disabled) btn.click();
  }
  if (e.target.id === 'cust-name' && e.key === 'Enter') {
    e.preventDefault();
    const btn = $('#btn-add-cust');
    if (btn) btn.click();
  }
  if (e.target.id === 'emp-name' && e.key === 'Enter') {
    e.preventDefault();
    const btn = $('#btn-add-emp');
    if (btn) btn.click();
  }
  if ((e.target.id === 'wage-amount' || e.target.id === 'wage-absence' || e.target.id === 'wage-emp-select') && e.key === 'Enter') {
    e.preventDefault();
    const btn = $('#btn-gen-wages');
    if (btn) btn.click();
  }
});

$('#modal').addEventListener('change', e => {
  if (e.target.id === 'wage-period') renderWageGen();
});

$('#card-emp-manage').addEventListener('click', openEmpManage);
$('#card-wage-gen').addEventListener('click', openWageGen);

/* ---------- 客户 ---------- */
// 客户管理：完整页面（非弹窗），列表只显示名称；业务、收费在点具体客户后展示
function renderCustAdmin() {
  const el = $('#cust-admin-list');
  if (!el) return;
  $('#cust-admin-count').textContent = S.customers.length + ' 个';
  el.innerHTML = S.customers.map(c =>
    '<div class="item-card" data-cust-detail="' + c.id + '">'
    + '<div class="ic-main"><div class="ic-title">' + esc(c.name) + '</div></div>'
    + '<div class="ic-act"><button class="link-btn" data-rencust-modal="' + c.id + '">编辑</button><button class="link-btn danger" data-delcust-modal="' + c.id + '">删除</button></div>'
    + '</div>').join('') || '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">暂无客户，点右上角「添加客户」</div>';
}
function openCustAdmin() {
  $('#bills-main').classList.add('hidden');
  $('#cust-edit').classList.add('hidden');
  $('#cust-admin').classList.remove('hidden');
  renderCustAdmin();
}
// 兼容旧的单文本收费记录：原内容放到现结，保存后转为现结/月结两部分
function pricingParts(c) {
  const p = c && c.pricing;
  if (p && typeof p === 'object') return { cash: String(p.cash || ''), monthly: String(p.monthly || '') };
  return { cash: String(p || ''), monthly: '' };
}
// 编辑客户：完整页面（非弹窗），现结/月结分开填写
function openCustEdit(cid) {
  const c = S.customers.find(x => x.id === cid);
  if (!c) return;
  $('#cust-rename').value = c.name || '';
  $('#cust-contact-edit').value = c.contact || '';
  $('#cust-business-edit').value = c.business || '';
  const pricing = pricingParts(c);
  $('#cust-pricing-cash-edit').value = pricing.cash;
  $('#cust-pricing-monthly-edit').value = pricing.monthly;
  $('#btn-cust-rename-save').dataset.custId = cid;
  $('#cust-admin').classList.add('hidden');
  $('#bills-main').classList.add('hidden');
  $('#cust-edit').classList.remove('hidden');
}
$('#cust-edit').addEventListener('click', handleModalClick);
$('#btn-cust-edit-back').addEventListener('click', openCustAdmin);
// 新增客户：点按钮才弹窗，不自动聚焦
function openAddCustModal() {
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>添加客户</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="form-grid">'
    + '<label class="span2">客户名称 <input type="text" id="cust-name" placeholder="输入客户名称"></label>'
    + '<label class="span2">业务 <input type="text" id="cust-business" placeholder="如：电梯件、垃圾袋、铁路件（可选）"></label>'
    + '<label class="span2">现结 <textarea id="cust-pricing-cash" placeholder="填写现结收费情况"></textarea></label>'
    + '<label class="span2">月结 <textarea id="cust-pricing-monthly" placeholder="填写月结收费情况"></textarea></label>'
    + '</div>'
    + '<button class="primary" id="btn-add-cust">添加客户</button>';
  $('#modal-mask').classList.remove('hidden');
}
$('#btn-open-add-cust').addEventListener('click', openAddCustModal);
$('#card-cust-manage').addEventListener('click', openCustAdmin);
$('#btn-cust-back').addEventListener('click', () => {
  $('#cust-admin').classList.add('hidden');
  $('#bills-main').classList.remove('hidden');
  renderBills();
});

// 客户管理页点客户：只显示业务与收费情况
function openCustInfoModal(cid) {
  const c = S.customers.find(x => x.id === cid);
  if (!c) return;
  const pricing = pricingParts(c);
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + esc(c.name) + '</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="kv"><span>业务</span><b>' + (c.business ? esc(c.business) : '<span class="muted">未填写</span>') + '</b></div>'
    + '<div class="kv pricing-detail"><span>现结</span><div class="pricing-text">' + (pricing.cash ? esc(pricing.cash) : '<span class="muted">未填写</span>') + '</div></div>'
    + '<div class="kv pricing-detail" style="border-bottom:none"><span>月结</span><div class="pricing-text">' + (pricing.monthly ? esc(pricing.monthly) : '<span class="muted">未填写</span>') + '</div></div>'
    + '<p class="muted" style="margin-top:8px">点列表中的「编辑」可修改业务与收费</p>';
  $('#modal-mask').classList.remove('hidden');
}

function openCustModal(cid) {
  const c = S.customers.find(x => x.id === cid);
  if (!c) return;
  const incs = S.incomes.filter(i => i.customerId === cid).sort((a, b) => b.date.localeCompare(a.date));
  const bills = S.bills.filter(b => b.customerId === cid).sort((a, b) => b.period.localeCompare(a.period));
  const incTotal = round2(incs.reduce((s, i) => s + Number(i.amount), 0));
  const owed = round2(bills.reduce((s, b) => s + billState(b).remaining, 0));

  const typeSum = t => round2(incs.filter(i => (i.type || '进仓费') === t).reduce((s, i) => s + Number(i.amount), 0));

  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + esc(c.name) + '</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="kv"><span>收入合计（现结）</span><b>' + fmt(incTotal) + '</b></div>'
    + '<div class="kv"><span style="font-size:12px;color:var(--muted)">进仓费 ' + fmt(typeSum('进仓费')) + '　·　打印费 ' + fmt(typeSum('打印费')) + '</span><b></b></div>'
    + '<div class="kv"><span>当前欠款（账单未收）</span><b class="' + (owed > 0 ? 'neg' : '') + '">' + fmt(owed) + '</b></div>'
    + '<div class="sub-title">应收账单</div>'
    + '<table class="mini-table"><thead><tr><th>账期</th><th>金额</th><th>待收</th><th>状态</th></tr></thead><tbody>'
    + (bills.map(b => {
        const st = billState(b);
        return '<tr><td>' + esc(b.period) + '</td><td>' + fmt(b.amount) + '</td><td>' + fmt(st.remaining) + '</td>'
          + '<td><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span></td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">暂无账单</td></tr>')
    + '</tbody></table>'
    + '<div class="sub-title">现结收入记录</div>'
    + '<table class="mini-table"><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>备注</th></tr></thead><tbody>'
    + (incs.slice(0, 30).map(i => '<tr><td>' + i.date + '</td><td>' + esc(i.type || '进仓费') + '</td><td>' + fmt(i.amount) + '</td><td>' + esc(i.note || '') + '</td></tr>').join('')
      || '<tr><td colspan="4" class="empty">暂无收入记录</td></tr>')
    + '</tbody></table>';
  $('#modal-mask').classList.remove('hidden');
}

/* ---------- 员工工资 ---------- */
function renderWages() {
  renderEmpList(); // 弹窗未打开时 #emp-list 不存在，内部安全返回
  renderWageList();
}

function renderEmpList() {
  const el = $('#emp-list');
  if (!el) return;
  const sortedEmps = S.employees.slice().sort((a, b) => {
    const ai = ROLE_ORDER.indexOf(a.role);
    const bi = ROLE_ORDER.indexOf(b.role);
    const ar = ai < 0 ? ROLE_ORDER.length : ai;
    const br = bi < 0 ? ROLE_ORDER.length : bi;
    if (ar !== br) return ar - br;
    return (a.name || '').localeCompare(b.name || '', 'zh-CN');
  });
  el.innerHTML = sortedEmps.map(e2 =>
    '<div class="item-card">'
    + '<div class="ic-main">'
    + '<div class="ic-title">' + esc(e2.name) + ' ' + (e2.role ? '<span class="badge badge-info">' + esc(e2.role) + '</span>' : '') + '</div>'
    + '</div>'
    + '<div class="ic-act">'
    + (e2.active ? '<span class="badge badge-ok">在职</span>' : '<span class="badge badge-gray">离职</span>')
    + '<button class="link-btn" data-toggle-emp="' + e2.id + '">' + (e2.active ? '离职' : '恢复') + '</button>'
    + '<button class="link-btn danger" data-del-emp="' + e2.id + '">删除</button>'
    + '</div></div>'
  ).join('') || '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">暂无员工</div>';
}

function openEmpManage() {
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>员工管理</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="form-grid">'
    + '<label>新增员工 <input type="text" id="emp-name" placeholder="员工姓名"></label>'
    + '<label>职位 <select id="emp-role">'
    + '<option value="">请选择</option><option>叉车工</option><option>装卸工</option><option>司机</option><option>调度</option><option>操作</option><option>换单</option>'
    + '</select></label>'
    + '</div>'
    + '<button class="primary" id="btn-add-emp">添加员工</button>'
    + '<div class="sub-title">员工列表（' + S.employees.length + ' 人）</div>'
    + '<div class="item-list" id="emp-list"></div>';
  renderEmpList();
  $('#modal-mask').classList.remove('hidden');
}

function openWageGen() {
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>生成月工资单</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="form-grid">'
    + '<label>工资月份 <input type="month" id="wage-period"></label>'
    + '<label>员工 <select id="wage-emp-select"></select></label>'
    + '<label>工资金额（元） <input type="number" min="0" step="1" inputmode="numeric" id="wage-amount" placeholder="留空可生成后再填"></label>'
    + '<label>缺勤（天） <input type="number" min="0" step="1" inputmode="numeric" id="wage-absence" placeholder="无则留空"></label>'
    + '</div>'
    + '<button class="primary" id="btn-gen-wages">生成工资单</button>';
  renderWageGen();
  $('#modal-mask').classList.remove('hidden');
}

function renderWageGen() {
  const periodInput = $('#wage-period');
  if (!periodInput) return;
  if (!periodInput.value) periodInput.value = monthStr();
  const period = periodInput.value;
  const actives = S.employees.filter(e2 => e2.active);
  const pending = actives.filter(e2 => !S.wages.some(w => w.employeeId === e2.id && w.period === period));
  const sel = $('#wage-emp-select');
  sel.innerHTML = pending.length
    ? pending.map(e2 => '<option value="' + e2.id + '">' + esc(e2.name) + '</option>').join('')
    : '<option value="">' + (actives.length ? '本月工资已全部生成' : '暂无在职员工') + '</option>';
  sel.disabled = !pending.length;
  $('#wage-amount').disabled = !pending.length;
}

function renderWageList() {
  const m = $('#wage-filter-month').value;
  const st = $('#wage-filter-status').value;
  const n = ($('#wage-filter-name').value || '').trim();
  const stLabel = s => s === 'paid' ? '<span class="badge badge-ok">已发</span>' : s === 'partial' ? '<span class="badge badge-info">部分发放</span>' : '<span class="badge badge-gray">待发</span>';
  let list = S.wages.slice().sort((a, b) => b.period.localeCompare(a.period) || empName(a.employeeId).localeCompare(empName(b.employeeId), 'zh'));
  if (m) list = list.filter(w => w.period === m);
  if (st === 'pending') list = list.filter(w => wageStatus(w) === 'pending');
  if (st === 'partial') list = list.filter(w => wageStatus(w) === 'partial');
  if (st === 'paid') list = list.filter(w => wageStatus(w) === 'paid');
  if (n) list = list.filter(w => empName(w.employeeId).indexOf(n) >= 0);
  $('#wage-list').innerHTML = list.map(w => {
    const paid = wagePaid(w);
    const abs = absCount(w);
    return '<div class="item-card" data-wage="' + w.id + '">'
      + '<div class="ic-main">'
      + '<div class="ic-title">' + esc(empName(w.employeeId)) + ' ' + stLabel(wageStatus(w)) + '</div>'
      + '<div class="ic-sub">' + esc(w.period) + ' · ' + (abs === 0 ? '全勤' : '缺勤 ' + abs + ' 天') + '</div>'
      + '</div>'
      + '<div class="ic-right"><div class="ic-amt">' + fmtInt(w.amount) + ' 元</div><div class="ic-sub2">' + (wageStatus(w) === 'pending' ? '未发放' : '已发 ' + fmtInt(paid)) + '</div></div>'
      + '</div>';
  }).join('') || '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">暂无工资单</div>';
}

$('#wage-filter-month').addEventListener('change', renderWageList);
$('#wage-filter-status').addEventListener('change', renderWageList);
$('#wage-filter-name').addEventListener('input', renderWageList);

$('#wage-list').addEventListener('click', e => {
  const tr = e.target.closest('.item-card[data-wage]');
  if (tr) openWageModal(tr.dataset.wage);
});

let currentWageId = null;
function openWageModal(wid) {
  const w = S.wages.find(x => x.id === wid);
  if (!w) return;
  currentWageId = wid;
  const [y, m] = w.period.split('-').map(Number);
  const firstWeekday = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const absSet = new Set(w.absenceDates || []);
  const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
  let calCells = weekNames.map(n => '<div class="cal-head">' + n + '</div>').join('');
  for (let i = 0; i < firstWeekday; i++) calCells += '<div class="cal-day empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = w.period + '-' + String(d).padStart(2, '0');
    calCells += '<button class="cal-day' + (absSet.has(dateStr) ? ' selected' : '') + '" data-abs-day="' + d + '">' + d + '</button>';
  }
  const pad = (7 - ((firstWeekday + daysInMonth) % 7)) % 7;
  for (let i = 0; i < pad; i++) calCells += '<div class="cal-day empty"></div>';
  const total = Number(w.amount) || 0;
  const paid = wagePaid(w);
  const remain = Math.max(0, total - paid);
  const st = wageStatus(w);
  const stBadge = st === 'paid' ? '<span class="badge badge-ok">已发</span>' : st === 'partial' ? '<span class="badge badge-info">部分发放</span>' : '<span class="badge badge-gray">待发</span>';
  // 发放记录列表
  const payments = (w.payments || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const payListHtml = payments.length
    ? payments.map(p => '<tr><td>' + esc(p.date) + '</td><td>' + fmtInt(p.amount) + '</td><td>' + esc(p.note || '—') + '</td><td><button class="link-btn danger" data-del-wage-pay="' + p.id + '">删除</button></td></tr>').join('')
    : '<tr><td colspan="4" class="empty">暂无发放记录</td></tr>';
  const addBtnDisabled = (remain <= 0 && total > 0) ? ' disabled' : '';
  const addBtnText = st === 'paid' ? '工资已全额发放' : (remain > 0 ? '登记发放' : '登记发放');
  const remainderHint = st === 'paid'
    ? '<div class="kv"><span>已全额发放</span><b>' + fmtInt(paid) + '</b></div>'
    : '<div class="kv"><span>已发放</span><b>' + fmtInt(paid) + '</b></div>'
      + (total > 0 ? '<div class="kv"><span>剩余待发</span><b>' + fmtInt(remain) + '</b></div>' : '');
  const addPayHtml = (total <= 0)
    ? '<p class="muted" style="font-size:12px">先补全工资金额后再登记发放。</p>'
    : '<div class="form-grid" style="margin-top:10px">'
      + '<label>发放金额 <input type="number" id="wage-pay-amount" min="0" step="1" inputmode="numeric" value="' + (remain > 0 ? remain : '') + '" placeholder="留空等于剩余待发"></label>'
      + '<label>发放日期 <input type="date" id="wage-pay-date" value="' + todayStr() + '"></label>'
      + '<label class="span2">备注（如：预支、现金、微信）<input type="text" id="wage-pay-note" placeholder="可留空"></label>'
      + '</div>'
      + '<button class="primary" id="btn-wage-pay-add"' + addBtnDisabled + '>' + addBtnText + '</button>';
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + esc(empName(w.employeeId)) + ' · ' + esc(w.period) + ' 工资</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="kv"><span>工资金额</span><input type="number" id="wage-amount-edit" value="' + w.amount + '" min="0" step="1" style="width:120px"> <button class="ghost small" id="btn-wage-amount-save">保存</button></div>'
    + '<div class="kv"><span>状态</span><b>' + stBadge + '</b></div>'
    + remainderHint
    + '<div class="kv"><span>缺勤天数</span><b>' + absSet.size + ' 天</b></div>'
    + '<div class="kv" style="display:block"><span>缺勤日期（点击日期切换，红色为缺勤）</span>'
    + '<div class="cal-grid" id="wage-abs-cal">' + calCells + '</div></div>'
    + '<div style="border-top:1px solid var(--border);margin:12px 0"></div>'
    + '<div class="sub-title">发放记录</div>'
    + '<table style="width:100%;margin:6px 0"><thead><tr><th style="text-align:left">日期</th><th style="text-align:left">金额</th><th style="text-align:left">备注</th><th></th></tr></thead><tbody>' + payListHtml + '</tbody></table>'
    + addPayHtml
    + '<div style="margin-top:10px"><button class="ghost" id="btn-wage-del">删除工资单</button></div>';
  $('#modal-mask').classList.remove('hidden');
}

/* ---------- 设置页（报表/备份） ---------- */
$('#report-all').addEventListener('change', e => { $('#report-month').disabled = e.target.checked; });

// Excel 导出库按需加载：首屏只下载页面本身，点导出时才下载 xlsx.min.js
let xlsxLoading = null;
function ensureXLSX() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  if (xlsxLoading) return xlsxLoading;
  xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'xlsx.min.js';
    s.onload = resolve;
    s.onerror = () => { xlsxLoading = null; reject(new Error('导出组件加载失败，请检查网络后重试')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

$('#btn-export-xlsx').addEventListener('click', async () => {
  if (typeof XLSX === 'undefined') {
    toast('首次导出需加载组件，请稍候…');
    try { await ensureXLSX(); } catch (err) { alert(err.message); return; }
  }
  const all = $('#report-all').checked;
  const m = $('#report-month').value;
  const inMonth = d => all || !m || (d || '').indexOf(m) === 0;
  const billInMonth = b => all || !m || b.period === m;
  const label = all ? '全部' : (m || '全部');

  const wb = XLSX.utils.book_new();

  // 工作表1：收支明细
  const r1 = [['日期', '收支', '类别', '客户', '收入(元)', '支出(元)', '备注']];
  S.incomes.filter(i => inMonth(i.date)).forEach(i => r1.push([i.date, '收入', i.type || '进仓费', custName(i.customerId), Number(i.amount), '', i.note || '']));
  S.expenses.filter(e2 => inMonth(e2.date)).forEach(e2 => r1.push([e2.date, '支出', catLabel(e2), '', '', Number(e2.amount), e2.note || '']));
  const ws1 = XLSX.utils.aoa_to_sheet([r1[0]].concat(r1.slice(1).sort((a, b) => a[0].localeCompare(b[0]))));
  ws1['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws1, '收支明细');

  // 工作表2：应收台账
  const r2 = [['客户', '账期', '账单金额(元)', '已收(元)', '未收(元)', '收款状态', '开票状态']];
  S.bills.filter(billInMonth).sort((a, b) => custName(a.customerId).localeCompare(custName(b.customerId), 'zh') || (a.period || '').localeCompare(b.period || '')).forEach(b => {
    const st = billState(b);
    r2.push([custName(b.customerId), b.period, Number(b.amount), st.paid, st.remaining, st.label, invState(b).label]);
  });
  const ws2 = XLSX.utils.aoa_to_sheet(r2);
  ws2['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws2, '应收台账');

  // 工作表3：收款记录
  const r3 = [['日期', '客户', '账期', '金额(元)', '备注']];
  S.payments.filter(p => inMonth(p.date)).sort((a, b) => a.date.localeCompare(b.date)).forEach(p => {
    const b = S.bills.find(x => x.id === p.billId);
    r3.push([p.date, b ? custName(b.customerId) : '', b ? b.period : '', Number(p.amount), p.note || '']);
  });
  const ws3 = XLSX.utils.aoa_to_sheet(r3);
  ws3['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws3, '收款记录');

  // 工作表4：发票台账
  const r4 = [['开票日期', '客户', '账期', '开票金额(元)', '账单金额(元)']];
  S.invoices.filter(i => inMonth(i.date)).sort((a, b) => a.date.localeCompare(b.date)).forEach(i => {
    const b = S.bills.find(x => x.id === i.billId);
    r4.push([i.date || '', b ? custName(b.customerId) : '', b ? b.period : '', Number(i.amount) > 0 ? Number(i.amount) : (b ? Number(b.amount) : ''), b ? Number(b.amount) : '']);
  });
  const ws4 = XLSX.utils.aoa_to_sheet(r4);
  ws4['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws4, '发票台账');

  // 工作表5：工资表
  const r5 = [['月份', '员工', '金额(元)', '已发放(元)', '剩余(元)', '缺勤(天)', '状态']];
  S.wages.filter(w => all || !m || w.period === m)
    .sort((a, b) => a.period.localeCompare(b.period) || empName(a.employeeId).localeCompare(empName(b.employeeId), 'zh'))
    .forEach(w => {
      const st = wageStatus(w);
      r5.push([w.period, empName(w.employeeId), Math.round(Number(w.amount) || 0), Math.round(wagePaid(w)), Math.max(0, Math.round(Number(w.amount) || 0) - Math.round(wagePaid(w))), absCount(w), st === 'paid' ? '已发' : st === 'partial' ? '部分发放' : '待发']);
    });
  const ws5 = XLSX.utils.aoa_to_sheet(r5);
  ws5['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws5, '工资表');

  XLSX.writeFile(wb, '账本报表_' + label + '.xlsx');
  toast('Excel 已导出');
});

/* ---------- 备份与恢复 ---------- */
$('#btn-backup').addEventListener('click', () => {
  const data = {
    app: 'company-ledger', version: 1, exportedAt: new Date().toISOString(),
    customers: S.customers, incomes: S.incomes, expenses: S.expenses,
    bills: S.bills, payments: S.payments, invoices: S.invoices,
    employees: S.employees, wages: S.wages,
    settings: S.settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '账本备份_' + todayStr() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('备份文件已下载');
});

/* ---------- Excel 导入现结收入 ---------- */
// 解析各种日期格式为 YYYY-MM-DD，失败返回 null
function parseExcelDate(v) {
  if (v == null || v === '') return null;
  const pad = n => String(n).padStart(2, '0');
  // Date 对象（含跨上下文）：用 Object.prototype.toString 判定，避免 instanceof 失效
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
  }
  if (typeof v === 'number' && isFinite(v) && v > 0) {
    // Excel 序列号（1900 日期系统）
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  const m = String(v).trim().match(/(\d{4})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  return null;
}

// 从二维数组识别表头并解析为收入行（纯函数，便于测试）
// fallbackName：无客户列时用文件名作为客户名（一个文件一个客户）
function parseIncomeAOA(aoa, fallbackName) {
  if (!aoa || !aoa.length) return { error: 'Excel 里没有内容' };
  let headIdx = -1, cCust = -1, cDate = -1, cAmt = -1, cNo = -1;
  for (let r = 0; r < Math.min(aoa.length, 10); r++) {
    const row = (aoa[r] || []).map(x => String(x == null ? '' : x).trim());
    const cust = row.findIndex(t => /客户|顾客|公司|单位/.test(t));
    const date = row.findIndex(t => /日期|时间/.test(t));
    let amt = row.findIndex(t => /进仓费/.test(t));
    if (amt < 0) amt = row.findIndex(t => /金额|费用|收款|应收/.test(t));
    const no = row.findIndex(t => /委托编号|委托号|进仓编号|进仓号|编号/.test(t));
    if (date >= 0 && amt >= 0 && (cust >= 0 || fallbackName)) { headIdx = r; cCust = cust; cDate = date; cAmt = amt; cNo = no; break; }
  }
  if (headIdx < 0) return { error: '未识别到表头：需要包含「日期、进仓费（或金额）」列；客户列可选，没有客户列时用文件名作为客户名' };

  const existNames = new Set(S.customers.map(c => c.name.trim()));
  const rows = [];
  for (let r = headIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    const rawName = cCust >= 0 ? String(row[cCust] == null ? '' : row[cCust]).trim() : '';
    const rawDate = row[cDate], rawAmt = row[cAmt];
    // 整行空白跳过
    if (!rawName && (rawDate == null || rawDate === '') && (rawAmt == null || rawAmt === '')) continue;
    const name = cCust >= 0 ? rawName : fallbackName;
    const date = parseExcelDate(rawDate);
    const amount = Number(String(rawAmt == null ? '' : rawAmt).replace(/[¥￥,\s元]/g, ''));
    const rec = { name, date, amount, ok: false, reason: '', dup: false, newCust: false, no: cNo >= 0 ? String(row[cNo] == null ? '' : row[cNo]).trim() : '' };
    if (!name) rec.reason = '缺客户名';
    else if (!date) rec.reason = '日期无法识别';
    else if (!isFinite(amount) || amount <= 0) rec.reason = '金额无效';
    else {
      rec.ok = true;
      rec.newCust = !existNames.has(name);
      rec.dup = S.incomes.some(i => i.type === '进仓费' && i.date === date && Number(i.amount) === amount && custName(i.customerId) === name);
    }
    rows.push(rec);
  }
  if (!rows.length) return { error: '表头以下没有数据行' };
  return { rows };
}

// 遍历所有工作表收集收入行；识别不了表头的工作表跳过并记录
function collectIncomeRows(wb, fileCust) {
  const allRows = [], skippedSheets = [];
  wb.SheetNames.forEach(sn => {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    const r = parseIncomeAOA(aoa, fileCust);
    if (r.error) { skippedSheets.push(sn); return; }
    r.rows.forEach(row => { row.sheet = sn; allRows.push(row); });
  });
  return { rows: allRows, skippedSheets };
}

// 导入预览弹窗：核对后确认写入
function openImportPreview(result) {
  if (result.error) { alert(result.error); return; }
  const rows = result.rows;
  const valid = rows.filter(r => r.ok && !r.dup);
  const dupCount = rows.filter(r => r.ok && r.dup).length;
  const badRows = rows.filter(r => !r.ok);
  const newCusts = [...new Set(valid.filter(r => r.newCust).map(r => r.name))];
  const total = round2(valid.reduce((s, r) => s + r.amount, 0));

  const rowHtml = r => {
    if (!r.ok) return '<div class="kv"><span>' + esc(r.name || '(空行)') + ' · ' + esc(r.reason) + '</span><span class="badge badge-danger">跳过</span></div>';
    if (r.dup) return '<div class="kv" style="opacity:.55"><span>' + esc(r.name) + ' · ' + r.date + '</span><span>' + fmt(r.amount) + ' <span class="badge badge-gray">重复跳过</span></span></div>';
    return '<div class="kv"><span>' + esc(r.name) + (r.newCust ? ' <span class="badge badge-info">新客户</span>' : '') + '<br>' + r.date + (r.no ? ' · ' + esc(r.no) : '') + '</span><span class="pos strong">' + fmt(r.amount) + '</span></div>';
  };
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>导入预览</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<p class="muted" style="margin-bottom:10px">将导入 <b>' + valid.length + '</b> 条现结收入（进仓费），合计 <b>' + fmt(total) + '</b>；'
    + '新建客户 ' + newCusts.length + ' 个；重复跳过 ' + dupCount + ' 条；无效跳过 ' + badRows.length + ' 条。'
    + (result.skippedSheets && result.skippedSheets.length ? '<br>未识别、已跳过的工作表：' + result.skippedSheets.map(esc).join('、') : '')
    + '<br>已识别工作表：' + [...new Set(rows.map(r => r.sheet).filter(Boolean))].map(esc).join('、') + '</p>'
    + '<div style="max-height:45vh;overflow:auto;margin-bottom:12px">' + rows.map(rowHtml).join('') + '</div>'
    + '<button class="primary" id="btn-do-import"' + (valid.length ? '' : ' disabled') + '>确认导入 ' + valid.length + ' 条</button>';
  $('#modal-mask').classList.remove('hidden');
  $('#btn-do-import').addEventListener('click', async () => {
    const btn = $('#btn-do-import');
    btn.disabled = true; btn.textContent = '导入中…';
    try {
      const nameToId = {};
      S.customers.forEach(c => { nameToId[c.name.trim()] = c.id; });
      for (const r of valid) {
        if (!nameToId[r.name]) {
          const id = uid();
          await dbPut('customers', { id, name: r.name, createdAt: Date.now() });
          nameToId[r.name] = id;
        }
        await dbPut('incomes', { id: uid(), date: r.date, type: '进仓费', customerId: nameToId[r.name], amount: r.amount, note: r.no || 'Excel导入', createdAt: Date.now() });
      }
      await loadState();
      closeModal();
      renderAdd(); renderBills(); renderUnpaid();
      toast('已导入 ' + valid.length + ' 条收入');
    } catch (err) {
      btn.disabled = false; btn.textContent = '重试导入';
      alert('导入失败：' + err.message);
    }
  });
}

$('#btn-import-xlsx').addEventListener('click', () => $('#import-xlsx-file').click());
$('#import-xlsx-file').addEventListener('change', e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  (async () => {
    try { await ensureXLSX(); } catch (err) { alert(err.message); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: 'array', cellDates: true });
        const fileCust = file.name.replace(/\.(xlsx|xls)$/i, '').trim();
        const result = collectIncomeRows(wb, fileCust);
        if (!result.rows.length) { alert('未识别到有效数据：工作表需要「日期、进仓费（或金额）」列；客户列可选，无客户列时用文件名作为客户名'); return; }
        openImportPreview(result);
      } catch (err) { alert('Excel 解析失败：' + err.message); }
    };
    reader.onerror = () => alert('文件读取失败，请重试');
    reader.readAsArrayBuffer(file);
  })();
});

$('#btn-restore').addEventListener('click', () => $('#restore-file').click());
$('#restore-file').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importBackup(f);
});
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (err) { alert('备份文件格式不对'); return; }
  if (!data || data.app !== 'company-ledger' || !Array.isArray(data.customers)) { alert('这不是本软件的备份文件'); return; }
  if (!confirm('导入备份将覆盖当前浏览器中的全部账本数据，确定继续吗？')) return;
  for (const s of STORES) await dbClear(s);
  for (const c of data.customers || []) await dbPut('customers', c);
  for (const i of data.incomes || []) await dbPut('incomes', i);
  for (const e2 of data.expenses || []) await dbPut('expenses', e2);
  for (const b of data.bills || []) await dbPut('bills', b);
  for (const p of data.payments || []) await dbPut('payments', p);
  for (const iv of data.invoices || []) await dbPut('invoices', iv);
  for (const em of data.employees || []) await dbPut('employees', em);
  for (const wg of data.wages || []) await dbPut('wages', wg);
  for (const p of data.purchases || []) { /* 采购功能已删除 */ }
  // 报销功能已并入支出（车队分类），旧报销数据不再导入
  const st = data.settings || {};
  for (const k of Object.keys(st)) await dbPut('meta', { id: k, value: st[k] });
  await loadState();
  renderPage(currentPage);
  toast('备份已恢复');
}

/* ---------- 初始化 ---------- */
(async function init() {
  try {
    await openDB();
  } catch (err) {
    return;
  }
  await loadState();
  await migrateCategories();
  if (!S.settings.seeded) {
    for (const n of ['祺盾', '孙海洋', '陈武', '傲通']) {
      await dbPut('customers', { id: uid(), name: n, createdAt: Date.now() });
    }
    await saveSetting('seeded', true);
    await loadState();
  }
  $('#report-month').value = monthStr();
  if ($('#tx-date')) $('#tx-date').value = todayStr();
  renderPage(currentPage); // 打开网页即渲染当前页（默认记一笔），避免首屏空白需切页才出数据
  renderUnpaid();
})();
