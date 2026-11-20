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
const STORES = ['customers', 'incomes', 'expenses', 'bills', 'payments', 'invoices', 'employees', 'wages', 'meta', 'billFiles'];
let _db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('company-ledger', 8);
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
    '工资': ['员工工资']
  },
  incomeFees: ['进仓费', '打印费']
};
const LEGACY_CATS = { '工资': ['员工', '员工工资'], '办公用品': ['仓库', '办公用品'], '仓库工具': ['仓库', '工具材料'], '车队报销': ['车队', '其他'] };
const ROLE_ORDER = ['叉车工', '装卸工', '司机', '调度', '操作', '换单'];
let S = { customers: [], incomes: [], expenses: [], bills: [], payments: [], invoices: [], employees: [], wages: [], billFiles: [], settings: Object.assign({}, DEFAULTS) };

async function loadState() {
  const [customers, incomes, expenses, bills, payments, invoices, employees, wages, meta, billFiles] = await Promise.all(STORES.map(dbGetAll));
  S.customers = customers.sort((a, b) => a.createdAt - b.createdAt);
  S.incomes = incomes; S.expenses = expenses; S.bills = bills; S.payments = payments; S.invoices = invoices;
  S.billFiles = billFiles || [];
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
  // 迁移：历史账单收款生成的收入曾被标成「进仓费」，统一改为「账单收款」
  for (const i of S.incomes) {
    if (i.paymentId && i.type !== '账单收款') {
      i.type = '账单收款';
      await dbPut('incomes', i);
    }
  }
  const m = {};
  meta.forEach(r => { m[r.id] = r.value; });
  S.settings = Object.assign({}, DEFAULTS, m);
  S.settings.catGroups = Object.assign({}, DEFAULTS.catGroups, S.settings.catGroups || {});
}
const saveSetting = (key, value) => dbPut('meta', { id: key, value: value });

async function migrateCategories() {
  // 一次性统一车队默认子分类；之后用户自行新增的分类不再被覆盖
  const FLEET_SUBS = ['上车费', '高速费', '油费', '打印费'];
  if (!S.settings.fleetSubsMigrated) {
    const cur = S.settings.catGroups['车队'] || [];
    if (!cur.some(x => !FLEET_SUBS.includes(x))) S.settings.catGroups['车队'] = FLEET_SUBS.slice();
    S.settings.fleetSubsMigrated = true;
    await saveSetting('catGroups', S.settings.catGroups);
    await saveSetting('fleetSubsMigrated', true);
  }
  // 确保工资分类有子分类（员工工资 / 报销），兼容历史上用户自行新增的条目
  if (!(S.settings.catGroups['工资'] || []).includes('员工工资')) {
    S.settings.catGroups['工资'] = (S.settings.catGroups['工资'] || []).concat(['员工工资']);
    await saveSetting('catGroups', S.settings.catGroups);
  }
  // 一次性迁移：旧版工资相关支出 category='员工'（子分类'员工工资'/'报销'）统一改成 category='工资'
  if (!S.settings.wageCatMigrated) {
    let changed = false;
    for (const e2 of S.expenses) {
      if (e2.category === '员工') {
        e2.category = '工资';
        await dbPut('expenses', e2);
        changed = true;
      }
    }
    // 用户 settings 里自定义的"员工"分类（如曾经在分类设置里改过）也统一迁成"工资"
    if (S.settings.catGroups['员工'] && !S.settings.catGroups['工资']) {
      S.settings.catGroups['工资'] = S.settings.catGroups['员工'];
      delete S.settings.catGroups['员工'];
      await saveSetting('catGroups', S.settings.catGroups);
    }
    S.settings.wageCatMigrated = true;
    await saveSetting('wageCatMigrated', true);
    if (changed) await loadState();
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
const custName = id => { if (!id) return ''; const c = S.customers.find(c => c.id === id); return c ? c.name : '(已删除客户)'; };
const empName = id => { const e2 = S.employees.find(x => x.id === id); return e2 ? e2.name : '(已删除员工)'; };
const paidOf = billId => round2(S.payments.filter(p => p.billId === billId).reduce((s, p) => s + Number(p.amount), 0));
// 记一笔的"现结收入"：没有挂账单、也不是账单收款（含客户级整笔收款）的收入
const isCashIncome = i => !i.billId && !i.receiptId;
// 结账日期：取该账单最近一次登记收款的日期
const lastPayDate = billId => S.payments.filter(p => p.billId === billId).map(p => p.date || '').filter(Boolean).sort().pop() || '';
// 账单应收净额：账单金额扣除减免（抹零 / 差额核销）
const billBase = b => Math.max(0, round2(Number(b.amount) - Number(b.writeOff || 0)));
function billState(b) {
  const base = billBase(b);
  const paidRecords = paidOf(b.id);
  const hasOverride = b.remainingOverride !== undefined && b.remainingOverride !== null && isFinite(Number(b.remainingOverride));
  // 待收金额永远不超过账单净额；手动设置的 override 封顶为账单净额，避免删除收款时翻倍
  let remaining = hasOverride
    ? Math.min(round2(base), Math.max(0, round2(Number(b.remainingOverride))))
    : Math.max(0, round2(base - paidRecords));
  if (remaining <= 0) remaining = 0;
  // 已收 = 账单净额 − 待收金额；未手动设置待收时等同于收款记录合计
  const paid = hasOverride ? Math.max(0, round2(base - remaining)) : paidRecords;
  let key = 'unpaid', label = '待收';
  if (remaining <= 0) { key = 'settled'; label = '已结清'; }
  else if (paid > 0)  { key = 'partial'; label = '部分收款'; }
  return { paid, remaining, key, label };
}
function invState(b) {
  const invoiced = round2(S.invoices.filter(i => i.billId === b.id).reduce((s, i) => s + (Number(i.amount) > 0 ? Number(i.amount) : billBase(b)), 0));
  const remaining = Math.max(0, round2(billBase(b) - invoiced));
  let key = 'none', label = '待开票';
  // 手动覆盖开票状态：待开票/部分开票/已开票
  if (b.invOverride === 'done' || b.invOverride === 'partial' || b.invOverride === 'none') {
    key = b.invOverride;
    label = key === 'done' ? '已开票' : key === 'partial' ? '部分开票' : '待开票';
  } else if (invoiced > 0 && remaining <= 0) { key = 'done'; label = '已开票'; }
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
  syncMobileNav();
}
// 手机端底部导航：仅在四个主页面显示，进入次级页面（客户管理、编辑客户、账单明细、客户统计、支出统计）时隐藏
function syncMobileNav() {
  const nav = $('#mobile-nav');
  if (!nav) return;
  const inSubPage = ['cust-admin', 'cust-edit', 'cust-detail', 'cust-stats-page', 'stats-page'].some(id => {
    const el = $('#' + id);
    return el && !el.classList.contains('hidden');
  });
  nav.classList.toggle('hidden', inSubPage);
}
function renderPage(p) {
  if (p === 'bills') {
    $('#cust-admin').classList.add('hidden');
    $('#cust-edit').classList.add('hidden');
    $('#cust-detail').classList.add('hidden');
    $('#bills-main').classList.remove('hidden');
  }
  ({ add: renderAdd, bills: renderBills, wages: renderWages, settings: renderExportCustSelect }[p] || function () {})();
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
  $('#stat-unpaid').textContent = fmtInt(unsettled.reduce((s, x) => s + x.st.remaining, 0));
  // 本年收入：本年度全部收入（含记一笔现结收入、账单收款及历史收款）
  const rows = yearIncomeRows();
  $('#year-income-label').textContent = new Date().getFullYear() + '年收入';
  $('#stat-year-income').textContent = fmtInt(rows.reduce((s, r) => s + r.amount, 0));
}

// === 客户统计次页面（收入按客户 + 待收排名）===
let custStatsTab = 'income';
let custStatsMode = 'year';

function openCustStatsPage(defaultTab, defaultMode) {
  custStatsTab = defaultTab || 'income';
  custStatsMode = defaultMode || 'year';
  $('#bills-main').classList.add('hidden');
  $('#cust-admin').classList.add('hidden');
  $('#cust-detail').classList.add('hidden');
  $('#cust-stats-page').classList.remove('hidden');
  syncMobileNav();
  renderCustStatsPage();
}
function exitCustStatsPage() {
  $('#cust-stats-page').classList.add('hidden');
  $('#bills-main').classList.remove('hidden');
  syncMobileNav();
}
function custStatsPeriod() {
  const m = $('#ledger-month').value || todayStr().slice(0, 7);
  return custStatsMode === 'month' ? m : m.slice(0, 4);
}
function syncCustStatsPeriodPicker() {
  const lm = $('#ledger-month');
  const period = lm.value || todayStr().slice(0, 7);
  $('#cust-stats-period-month').value = period;
  $('#cust-stats-period-year').value = period.slice(0, 4);
  $('#cust-stats-period-month').classList.toggle('hidden', custStatsMode !== 'month');
  $('#cust-stats-period-year').classList.toggle('hidden', custStatsMode !== 'year');
}
function shiftCustStatsPeriod(delta) {
  const lm = $('#ledger-month');
  const cur = lm.value || todayStr().slice(0, 7);
  if (custStatsMode === 'year') {
    lm.value = String(Number(cur.slice(0, 4)) + delta) + '-' + cur.slice(5, 7);
  } else {
    const [y, m] = cur.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    lm.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  renderBills();
  renderCustStatsPage();
}
function setCustStatsPeriod() {
  const lm = $('#ledger-month');
  if (custStatsMode === 'month') {
    const v = $('#cust-stats-period-month').value;
    if (v) lm.value = v;
  } else {
    const v = $('#cust-stats-period-year').value;
    if (v) lm.value = v + '-' + (lm.value ? lm.value.slice(5, 7) : '01');
  }
  renderBills();
  renderCustStatsPage();
}
function renderCustStatsPage() {
  const period = custStatsPeriod();
  $$('[data-cust-stats-mode]').forEach(b => b.classList.toggle('active', b.dataset.custStatsMode === custStatsMode));
  $$('[data-cust-stats-tab]').forEach(b => b.classList.toggle('active', b.dataset.custStatsTab === custStatsTab));
  syncCustStatsPeriodPicker();
  const body = $('#cust-stats-body');
  if (custStatsTab === 'income') {
    body.innerHTML = renderCustIncomeTable(period);
  } else {
    body.innerHTML = renderUnpaidByCustomer(period);
  }
}
// 客户统计页收入表：三列口径拆分（应收=当期账单金额；已收=当期账单当前实收；现结=当期记一笔散收入）
// 对账关系：应收 = 已收 + 待收；实际到手 = 已收 + 现结
function renderCustIncomeTable(period) {
  const agg = {};
  const row = cid => (agg[cid] = agg[cid] || { receivable: 0, received: 0, cash: 0 });
  S.bills.forEach(b => {
    if (!(b.period || '').startsWith(period)) return;
    const st = billState(b);
    const r = row(b.customerId);
    r.receivable += billBase(b);
    r.received += st.paid;
  });
  S.incomes.forEach(i => {
    if (!isCashIncome(i)) return;
    if (!(i.date || '').startsWith(period)) return;
    row(i.customerId).cash += Number(i.amount || 0);
  });
  const rows = Object.keys(agg).map(cid => ({
    cid,
    receivable: round2(agg[cid].receivable),
    received: round2(agg[cid].received),
    cash: round2(agg[cid].cash),
  })).sort((a, b) => b.receivable - a.receivable || b.cash - a.cash);
  if (!rows.length) {
    return '<div class="empty" style="padding:24px;text-align:center;color:var(--muted)">' + (period.length === 4 ? '本年' : '本月') + '暂无收入</div>';
  }
  const tot = rows.reduce((t, r) => ({
    receivable: round2(t.receivable + r.receivable),
    received: round2(t.received + r.received),
    cash: round2(t.cash + r.cash),
  }), { receivable: 0, received: 0, cash: 0 });
  const label = period.length === 4 ? '当年' : '当月';
  const head = '<table class="mini-table cust-income-table"><thead><tr>'
    + '<th>客户</th><th style="text-align:right">应收</th><th style="text-align:right">已收</th><th style="text-align:right">现结</th>'
    + '</tr></thead><tbody>';
  const bodyRows = rows.map(r =>
    '<tr><td>' + esc(custName(r.cid) || '未选客户') + '</td>'
    + '<td style="text-align:right">' + fmtInt(r.receivable) + '</td>'
    + '<td style="text-align:right" class="pos">' + fmtInt(r.received) + '</td>'
    + '<td style="text-align:right" class="pos">' + fmtInt(r.cash) + '</td></tr>'
  ).join('');
  const foot = '</tbody><tfoot><tr><th>合计</th>'
    + '<th style="text-align:right">' + fmtInt(tot.receivable) + '</th>'
    + '<th style="text-align:right" class="pos">' + fmtInt(tot.received) + '</th>'
    + '<th style="text-align:right" class="pos">' + fmtInt(tot.cash) + '</th></tr></tfoot>';
  return head + bodyRows + foot + '</table>'
    + '<p class="muted">实际到手＝已收 ' + fmtInt(tot.received) + ' ＋ 现结 ' + fmtInt(tot.cash) + ' ＝ <b class="pos">' + fmtInt(round2(tot.received + tot.cash)) + '</b></p>';
}
// 待收排名：按账期归属过滤（月=当月账期，年=当年账期），仅统计当前仍未收清的账单
function renderUnpaidByCustomer(period) {
  const sums = {};
  S.bills.forEach(b => {
    if (!(b.period || '').startsWith(period)) return;
    const remain = billState(b).remaining;
    if (remain <= 0) return;
    sums[b.customerId] = (sums[b.customerId] || 0) + remain;
  });
  const rows = Object.keys(sums)
    .map(cid => ({ cid, amount: round2(sums[cid]) }))
    .sort((a, b) => b.amount - a.amount);
  const total = round2(rows.reduce((s, r) => s + r.amount, 0));
  if (!rows.length) {
    return '<div class="empty" style="padding:24px;text-align:center;color:var(--muted)">' + (period.length === 4 ? '本年' : '本月') + '暂无待收账款</div>';
  }
  return rows.map(r => {
    const pct = total > 0 ? (r.amount / total * 100).toFixed(1) : '0.0';
    return '<div class="exp-bar-row">'
      + '<div class="exp-bar-head"><span class="exp-bar-name">' + esc(custName(r.cid)) + '</span><span class="exp-bar-amt neg">' + fmt(r.amount) + ' <span class="muted" style="font-size:12px">' + pct + '%</span></span></div>'
      + '<div class="exp-bar-track"><div class="exp-bar-fill" style="width:' + pct + '%"></div></div>'
      + '</div>';
  }).join('')
  + '<div class="exp-total-row"><span class="strong">合计</span><span class="strong neg">' + fmt(total) + '</span></div>'
  + '<p class="muted" style="margin-top:10px">口径：' + (period.length === 4 ? '当年' : '当月') + '账期账单中仍未收清的金额</p>';
}

// 事件绑定
$('#btn-cust-stats-back').addEventListener('click', exitCustStatsPage);
$$('[data-cust-stats-mode]').forEach(b => b.addEventListener('click', () => {
  custStatsMode = b.dataset.custStatsMode;
  renderCustStatsPage();
}));
$$('[data-cust-stats-tab]').forEach(b => b.addEventListener('click', () => {
  custStatsTab = b.dataset.custStatsTab;
  renderCustStatsPage();
}));
$('#btn-cust-period-prev').addEventListener('click', () => shiftCustStatsPeriod(-1));
$('#btn-cust-period-next').addEventListener('click', () => shiftCustStatsPeriod(1));
$('#cust-stats-period-month').addEventListener('change', setCustStatsPeriod);
$('#cust-stats-period-year').addEventListener('change', setCustStatsPeriod);
$('#card-year-income').addEventListener('click', () => openCustStatsPage('income', 'year'));
$('#card-unpaid').addEventListener('click', () => openCustStatsPage('unpaid', 'year'));

/* ---------- 记一笔 ---------- */
const catLabel = r => r.sub ? r.category + ' · ' + r.sub : (r.category || '');

function renderAdd() {
  // page-add 显示月账本，表单按需弹出
  const lm = $('#ledger-month');
  if (lm && !lm.value) lm.value = todayStr().slice(0, 7);
  renderLedger();
}

let statsMode = 'month';
let ledgerMonthCache = null;

// === 支出统计页面 ===
function openStatsPage() {
  statsMode = 'month';
  $('.ledger-topbar').style.display = 'none';
  $('.ledger-search').style.display = 'none';
  $('.ledger-list').style.display = 'none';
  $('#fab-add').style.display = 'none';
  $('#stats-page').classList.remove('hidden');
  syncMobileNav();
  renderStatsPage();
}
function exitStatsPage() {
  $('#stats-page').classList.add('hidden');
  $('.ledger-topbar').style.display = '';
  $('.ledger-search').style.display = '';
  $('.ledger-list').style.display = '';
  $('#fab-add').style.display = '';
  syncMobileNav();
}
function statsPeriod() {
  const lm = $('#ledger-month').value || todayStr().slice(0, 7);
  return statsMode === 'month' ? lm : lm.slice(0, 4);
}
// 同步统计页的 period picker 状态 + 值
function syncStatsPeriodPicker() {
  const lm = $('#ledger-month');
  const period = lm.value || todayStr().slice(0, 7);
  $('#stats-period-month').value = period;
  $('#stats-period-year').value = period.slice(0, 4);
  $('#stats-period-month').classList.toggle('hidden', statsMode !== 'month');
  $('#stats-period-year').classList.toggle('hidden', statsMode !== 'year');
}
function renderStatsPage() {
  const period = statsPeriod();
  $$('[data-stats-mode]').forEach(b => b.classList.toggle('active', b.dataset.statsMode === statsMode));
  syncStatsPeriodPicker();
  const body = $('#stats-body');
  let trendHtml = '';
  if (statsMode === 'year') trendHtml = renderYearTrend(period);
  body.innerHTML = trendHtml + renderExpenseSub(period);
}
function shiftStatsPeriod(delta) {
  const lm = $('#ledger-month');
  const cur = lm.value || todayStr().slice(0, 7);
  if (statsMode === 'year') {
    const y = String(Number(cur.slice(0, 4)) + delta);
    lm.value = y + '-' + cur.slice(5, 7);
  } else {
    // month
    const [y, m] = cur.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    lm.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  renderLedger();
  renderStatsPage();
}
function setStatsPeriodFromPicker() {
  const lm = $('#ledger-month');
  if (statsMode === 'month') {
    const v = $('#stats-period-month').value;
    if (v) lm.value = v;
  } else {
    const v = $('#stats-period-year').value;
    if (v) lm.value = v + '-' + (lm.value ? lm.value.slice(5, 7) : '01');
  }
  renderLedger();
  renderStatsPage();
}

function renderExpenseMain(period) {
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
  if (!rows.length) {
    return '<div class="empty" style="padding:24px;text-align:center;color:var(--muted)">' + (statsMode === 'month' ? '本月' : '本年') + '暂无支出</div>'
      + (reimbSum || payableSum ? '<p class="muted" style="margin-top:10px;text-align:center">挂账 ' + fmt(payableSum) + ' · 待报销 ' + fmt(reimbSum) + '（未计入）</p>' : '');
  }
  return rows.map(r => {
    const pct = total > 0 ? (r.amt / total * 100).toFixed(1) : '0.0';
    return '<div class="exp-bar-row">'
      + '<div class="exp-bar-head"><span class="exp-bar-name">' + esc(r.k) + '</span><span class="exp-bar-amt">' + fmt(r.amt) + ' <span class="muted" style="font-size:12px">' + pct + '%</span></span></div>'
      + '<div class="exp-bar-track"><div class="exp-bar-fill" style="width:' + pct + '%"></div></div>'
      + '</div>';
  }).join('')
  + '<div class="exp-total-row"><span class="strong">合计</span><span class="strong neg">' + fmt(total) + '</span></div>'
  + (reimbSum || payableSum ? '<p class="muted" style="margin-top:10px">另有（未计入支出）：' + [reimbSum > 0 ? '待报销 ' + fmt(reimbSum) : '', payableSum > 0 ? '挂账 ' + fmt(payableSum) : ''].filter(Boolean).join('、') + '</p>' : '');
}
function renderExpenseSub(period) {
  const buckets = {};
  const driverBuckets = {}; // 车队支出按司机汇总
  const empBuckets = {};    // 工资支出按员工汇总
  let reimbSum = 0, payableSum = 0;
  S.expenses.forEach(e => {
    if (!(e.date || '').startsWith(period)) return;
    if (e.status === 'pending') {
      if (e.pendingKind === 'payable') payableSum += Number(e.amount || 0);
      else reimbSum += Number(e.amount || 0);
      return;
    }
    const g = e.category || '其他';
    const s = e.sub || '(无)';
    if (!buckets[g]) buckets[g] = {};
    buckets[g][s] = (buckets[g][s] || 0) + Number(e.amount || 0);
    // 车队支出额外按司机归集，未指定司机单独成块
    if (g === '车队') {
      const dn = e.driverId ? empName(e.driverId) : '未指定司机';
      driverBuckets[dn] = (driverBuckets[dn] || 0) + Number(e.amount || 0);
    }
    // 工资支出按员工归集
    if (g === '工资') {
      const en = e.employeeId ? empName(e.employeeId) : '未关联员工';
      empBuckets[en] = (empBuckets[en] || 0) + Number(e.amount || 0);
    }
  });
  // 主分类固定为仓库、车队、工资；历史数据里的其他分类仍然展示，避免金额凭空消失
  const ORDER = ['仓库', '车队', '工资'];
  const cats = Object.keys(buckets).sort((a, b) => {
    const ra = ORDER.indexOf(a), rb = ORDER.indexOf(b);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  if (!cats.length) {
    return '<div class="empty" style="padding:24px;text-align:center;color:var(--muted)">' + (statsMode === 'month' ? '本月' : '本年') + '暂无支出</div>';
  }
  return cats.map(cat => {
    const map = buckets[cat];
    const items = Object.keys(map).map(k => ({ k, amt: round2(map[k]) })).sort((a, b) => b.amt - a.amt);
    const total = round2(items.reduce((s, r) => s + r.amt, 0));
    const card = renderDonutCard(cat + '支出', items, total, { cat: cat, dim: 'sub', period: period });
    if (cat === '车队') {
      const dItems = Object.keys(driverBuckets).map(k => ({ k, amt: round2(driverBuckets[k]) })).sort((a, b) => b.amt - a.amt);
      const dTotal = round2(dItems.reduce((s, r) => s + r.amt, 0));
      return card + (dItems.length ? renderDonutCard('按司机支出', dItems, dTotal, { cat: '车队', dim: 'driver', period: period }) : '');
    }
    if (cat === '工资') {
      const wItems = Object.keys(empBuckets).map(k => ({ k, amt: round2(empBuckets[k]) })).sort((a, b) => b.amt - a.amt);
      const wTotal = round2(wItems.reduce((s, r) => s + r.amt, 0));
      return card + (wItems.length ? renderDonutCard('按员工支出', wItems, wTotal, { cat: '工资', dim: 'employee', period: period }) : '');
    }
    return card;
  }).join('')
  + (reimbSum || payableSum ? '<p class="muted" style="margin-top:10px">另有（未计入支出）：' + [reimbSum > 0 ? '待报销 ' + fmt(reimbSum) : '', payableSum > 0 ? '挂账 ' + fmt(payableSum) : ''].filter(Boolean).join('、') + '</p>' : '');
}
function renderYearTrend(year) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const key = year + '-' + mm;
    let expense = 0;
    S.expenses.forEach(e => {
      if ((e.date || '').startsWith(key) && e.status !== 'pending') expense += Number(e.amount || 0);
    });
    months.push({ label: mm + '月', expense: round2(expense) });
  }
  const max = Math.max(1, ...months.map(m => m.expense));
  const W = 320, H = 150, padL = 40, padR = 8, padT = 14, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const gap = plotW / 12;
  let expensePts = [], labels = '';
  months.forEach((m, i) => {
    const cx = padL + i * gap + gap / 2;
    const ye = padT + plotH - (m.expense / max) * plotH;
    expensePts.push(cx + ',' + ye);
    labels += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + m.label + '</text>';
  });
  let svg = '';
  [0, 0.5, 1].forEach(ratio => {
    const y = padT + plotH * (1 - ratio);
    const val = round2(max * ratio);
    const label = val >= 10000 ? (val / 10000).toFixed(1) + 'w' : Math.round(val);
    svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="#eef0f4" stroke-width="1"></line>'
      + '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="var(--muted)">' + label + '</text>';
  });
  const expensePath = expensePts.join(' ');
  svg += '<polygon points="' + padL + ',' + (padT + plotH) + ' ' + expensePath + ' ' + (W - padR) + ',' + (padT + plotH) + '" fill="#CE3A3A" opacity="0.12"></polygon>'
    + '<polyline points="' + expensePath + '" fill="none" stroke="#CE3A3A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>';
  months.forEach((m, i) => {
    const cx = padL + i * gap + gap / 2;
    const ye = padT + plotH - (m.expense / max) * plotH;
    svg += '<circle cx="' + cx + '" cy="' + ye + '" r="6" fill="transparent" data-month="' + m.label + '" data-expense="' + fmt(m.expense) + '"></circle>'
      + '<circle cx="' + cx + '" cy="' + ye + '" r="3.5" fill="#CE3A3A" stroke="#fff" stroke-width="1.2"></circle>';
  });
  svg += labels;
  const totalExpense = round2(months.reduce((s, m) => s + m.expense, 0));
  return '<div class="year-trend-card">'
    + '<div class="donut-title">' + year + '年 · 支出趋势</div>'
    + '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + svg + '</svg>'
    + '<div class="trend-legend"><span class="trend-dot" style="background:#CE3A3A"></span>支出合计 ' + fmt(totalExpense) + '</div>'
  + '</div>';
}

const DONUT_PALETTE = ['#0064FA', '#3BB346', '#F59E0B', '#8B5CF6', '#06B6D4', '#14B8A6', '#F97316', '#84CC16', '#6366F1', '#8B949E'];
function renderDonutCard(title, items, total, clickCtx) {
  // clickCtx 可选：{ cat, dim, period }
  //   cat: '仓库' | '车队' | '工资'
  //   dim: 'sub' 按子分类 | 'driver' 按司机 | 'employee' 按员工
  //   period: '2026' 或 '2026-11'
  // 点击某条 legend 时，会用 cat + dim + 该 legend 的 key 过滤支出记录并弹窗展示
  // 明细不再合并小项，所有子分类都原样列出
  const merged = items;

  // 用实心扇形路径（而非 stroke-dasharray）绘制，填充图形抗锯齿更平滑，不会再出现锯齿
  const size = 140, stroke = 26, cx = size / 2, cy = size / 2;
  const rOut = size / 2 - 1, rIn = rOut - stroke;
  const n = (v) => Math.round(v * 1000) / 1000;
  const pt = (r, a) => [n(cx + r * Math.cos(a)), n(cy + r * Math.sin(a))];
  const sector = (a0, a1) => {
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const o1 = pt(rOut, a0), o2 = pt(rOut, a1), i2 = pt(rIn, a1), i1 = pt(rIn, a0);
    return 'M' + o1[0] + ' ' + o1[1]
      + 'A' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + o2[0] + ' ' + o2[1]
      + 'L' + i2[0] + ' ' + i2[1]
      + 'A' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + i1[0] + ' ' + i1[1] + 'Z';
  };
  const GAP = 0.02; // 相邻扇区间留约 1° 缝隙
  // 不再丢弃细小扇区：全部按真实占比绘制，极细处不留缝，保证与下方明细一致
  const list = merged;
  const multi = list.length > 1;
  let angle = -Math.PI / 2;
  const segs = list.map((it, i) => {
    const sweep = (total > 0 ? it.amt / total : 0) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    // 只剩一块时画完整圆环，避免首尾接缝
    if (!multi) {
      const ring = 'M' + n(cx) + ' ' + n(cy - rOut) + 'A' + rOut + ' ' + rOut + ' 0 1 1 ' + n(cx) + ' ' + n(cy + rOut)
        + 'A' + rOut + ' ' + rOut + ' 0 1 1 ' + n(cx) + ' ' + n(cy - rOut) + 'Z'
        + 'M' + n(cx) + ' ' + n(cy - rIn) + 'A' + rIn + ' ' + rIn + ' 0 1 0 ' + n(cx) + ' ' + n(cy + rIn)
        + 'A' + rIn + ' ' + rIn + ' 0 1 0 ' + n(cx) + ' ' + n(cy - rIn) + 'Z';
      return '<path d="' + ring + '" fill="' + DONUT_PALETTE[0] + '" fill-rule="evenodd" />';
    }
    const d = sweep > GAP + 0.004 ? sector(a0 + GAP / 2, a1 - GAP / 2) : sector(a0, a1);
    return '<path d="' + d + '" fill="' + DONUT_PALETTE[i % DONUT_PALETTE.length] + '" />';
  }).join('');
  const legend = list.map((it, i) => {
    const pct = total > 0 ? (it.amt / total * 100).toFixed(1) : '0.0';
    const interactive = !!clickCtx;
    const ctxAttr = clickCtx
      ? ' data-cat="' + esc(clickCtx.cat || '') + '" data-dim="' + esc(clickCtx.dim || '') + '" data-period="' + esc(clickCtx.period || '') + '"'
      : '';
    return '<div class="donut-legend-row' + (interactive ? ' clickable' : '') + '"' + ctxAttr + ' data-key="' + esc(it.k) + '">'
      + '<span class="donut-dot" style="background:' + DONUT_PALETTE[i % DONUT_PALETTE.length] + '"></span>'
      + '<span class="donut-legend-name">' + esc(it.k) + '</span>'
      + '<span class="donut-legend-amt">' + fmt(it.amt) + ' <span class="muted" style="font-size:11px">' + pct + '%</span></span>'
      + '</div>';
  }).join('');
  return '<div class="donut-card">'
    + '<div class="donut-body">'
      + '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="geometricPrecision">' + segs
        // 环形图中间两行文字：第一行分类名，第二行合计金额
        + '<text x="' + cx + '" y="' + (cy - 3) + '" text-anchor="middle" font-size="11" fill="var(--muted)">' + esc(title) + '</text>'
        + '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text)">' + fmt(total) + '</text>'
      + '</svg>'
      + '<div class="donut-legend">' + legend + '</div>'
    + '</div>'
  + '</div>';
}

document.addEventListener('click', e => {
  const row = e.target.closest('.donut-legend-row.clickable');
  if (row) {
    showDonutDetail(row.dataset.cat, row.dataset.dim, row.dataset.period, row.dataset.key);
  }
});

function showDonutDetail(cat, dim, period, key) {
  let rows = S.expenses.filter(e => {
    if ((e.date || '').startsWith(period) === false) return false;
    if ((e.category || '其他') !== cat) return false;
    if (dim === 'sub') return (e.sub || '(无)') === key;
    if (dim === 'driver') {
      const dn = e.driverId ? empName(e.driverId) : '未指定司机';
      return dn === key;
    }
    if (dim === 'employee') {
      const en = e.employeeId ? empName(e.employeeId) : '未关联员工';
      return en === key;
    }
    return false;
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
  const catLabel = { 'sub': '子分类', 'driver': '司机', 'employee': '员工' }[dim] || '';

  if (!rows.length) {
    $('#modal').innerHTML = '<div class="panel" style="text-align:center;color:var(--muted);padding:32px">' + esc(cat) + ' · ' + esc(catLabel) + '：' + esc(key) + '<p style="margin-top:10px">暂无明细记录</p></div>';
    $('#modal-mask').classList.remove('hidden');
    return;
  }

  // 根据 period 长度判断：年统计（4位）用可折叠月卡片，月统计（7位）用扁平表格
  const isYear = period.length === 4;
  const headers = ['日期', '金额', '备注'];

  let html = '';
  if (isYear) {
    // 按月份分组 → 折叠卡片（默认收起）
    const groups = {};
    rows.forEach(r => {
      const m = (r.date || '').slice(0, 7);
      if (!groups[m]) groups[m] = [];
      groups[m].push(r);
    });
    const sortedMonths = Object.keys(groups).sort().reverse();
    sortedMonths.forEach(m => {
      const g = groups[m];
      const mSum = round2(g.reduce((s, r) => s + Number(r.amount || 0), 0));
      const mLabel = m.slice(5) + '月';
      const gid = 'md-' + m;
      const detailRows = g.map(r => {
        const mmdd = (r.date || '').slice(5) || '--';
        const cols = [esc(mmdd), fmt(r.amount), esc(r.note || '')];
        return '<tr><td>' + cols.join('</td><td>') + '</td></tr>';
      }).join('');
      html += '<div class="month-card">'
        + '<div class="month-card-head" data-target="' + gid + '">'
          + '<span class="month-card-label">' + esc(mLabel) + '</span>'
          + '<span class="month-card-meta">' + g.length + ' 条 · ' + fmt(mSum) + '</span>'
          + '<span class="month-card-caret">▾</span>'
        + '</div>'
        + '<div class="month-card-body hidden" id="' + gid + '">'
          + '<table class="mini-table"><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + detailRows + '</tbody></table>'
        + '</div>'
      + '</div>';
    });
  } else {
    // 月统计：扁平表格，不分月
    const tbody = rows.map(r => {
      const mmdd = (r.date || '').slice(5) || '--';
      const cols = [esc(mmdd), fmt(r.amount), esc(r.note || '')];
      return '<tr><td>' + cols.join('</td><td>') + '</td></tr>';
    }).join('');
    html = '<table class="mini-table"><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + tbody + '</tbody></table>';
  }

  $('#modal').innerHTML = '<div class="panel donut-detail-panel">'
    + '<div class="panel-title">' + esc(cat) + '支出 · ' + esc(key) + '</div>'
    + '<div class="panel-desc">' + esc(periodLabel(period)) + ' · 共 ' + rows.length + ' 条 · 合计 ' + fmt(total) + '</div>'
    + html
    + '</div>';
  // 绑定折叠展开
  $$('#modal .month-card-head').forEach(el => el.addEventListener('click', () => {
    const body = $('#' + el.dataset.target);
    if (!body) return;
    body.classList.toggle('hidden');
    el.querySelector('.month-card-caret').style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
  }));
  $('#modal-mask').classList.remove('hidden');
}
function periodLabel(period) {
  if (!period) return '';
  if (period.length === 4) return period + '年';
  if (period.length === 7) return period.replace('-', '年') + '月';
  return period;
}

// 折线图圆点点击 → 浮层显示月份+支出（兼容手机触屏）
document.addEventListener('click', e => {
  const c = e.target.closest('.year-trend-card svg circle[data-month]');
  if (!c) { // 点别处 → 关闭浮层
    const tip = $('#trend-tip');
    if (tip) tip.remove();
    return;
  }
  // 用 SVG viewBox → 屏幕坐标换算：先取 SVG 的 getBoundingClientRect，再按 viewBox 比例
  const svg = c.ownerSVGElement;
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  // circle 的 cx/cy 是 viewBox 坐标 → 屏幕坐标
  const cx = Number(c.getAttribute('cx'));
  const cy = Number(c.getAttribute('cy'));
  const sx = rect.left + (cx / vb.width) * rect.width;
  const sy = rect.top + (cy / vb.height) * rect.height;
  const month = c.dataset.month;
  const expense = c.dataset.expense;
  // 关旧的
  const old = $('#trend-tip');
  if (old) old.remove();
  const tip = document.createElement('div');
  tip.id = 'trend-tip';
  tip.textContent = month + ' ' + expense;
  document.body.appendChild(tip);
  // 定位（默认圆点上方，屏幕边缘时翻转）
  const tipW = tip.offsetWidth, tipH = tip.offsetHeight;
  let left = sx - tipW / 2;
  let top = sy - tipH - 8;
  if (left < 6) left = 6;
  if (left + tipW > window.innerWidth - 6) left = window.innerWidth - tipW - 6;
  if (top < 6) top = sy + 14; // 上方不够空间 → 显示下方
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
});

// === 事件绑定 ===
$('#btn-stats-back').addEventListener('click', exitStatsPage);
$$('[data-stats-mode]').forEach(b => b.addEventListener('click', () => {
  statsMode = b.dataset.statsMode;
  renderStatsPage();
}));
$('#stat-month-expense').addEventListener('click', () => openStatsPage());
$('#btn-period-prev').addEventListener('click', () => shiftStatsPeriod(-1));
$('#btn-period-next').addEventListener('click', () => shiftStatsPeriod(1));
$('#stats-period-month').addEventListener('change', setStatsPeriodFromPicker);
$('#stats-period-year').addEventListener('change', setStatsPeriodFromPicker);

// 已迁入统一统计页面

function renderLedger() {
  const period = $('#ledger-month').value || todayStr().slice(0, 7);
  ledgerMonthCache = period;
  const [y, m] = period.split('-').map(Number);
  $('#ledger-month-text').textContent = m + '月';
  $('#ledger-year').textContent = y + '年';
  // 当月收支（挂账支出不计入统计）
  // 当月收入：仅现结收入，账单收款（客户页已结清）不计入记一笔
  const income = round2(S.incomes.filter(i => isCashIncome(i) && (i.date || '').startsWith(period)).reduce((s, i) => s + Number(i.amount || 0), 0));
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
  // 账单收款（客户页已结清）不计入记一笔流水
  const all = S.incomes.filter(isCashIncome).map(i => ({ id: i.id, store: 'incomes', date: i.date, type: 'income', cat: i.type || '其他收入', who: custName(i.customerId), amount: Number(i.amount), note: i.note }))
    .concat(S.expenses.map(e => ({ id: e.id, store: 'expenses', date: e.date, type: 'expense', cat: catLabel(e), who: (e.employeeId ? empName(e.employeeId) : '') || (e.driverId ? empName(e.driverId) : ''), amount: Number(e.amount), note: e.note, pending: e.status === 'pending', kind: e.pendingKind === 'payable' ? 'payable' : 'reimb' })))
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
      if (lastDate) html += '</div>';
      html += '<div class="ledger-day-group"><div class="ledger-day-head"><span class="ledger-day-date">' + r.date.slice(5) + '</span><span class="muted">' + weekday(r.date) + '</span><span style="flex:1"></span>';
      const dayInc = filtered.filter(x => x.date === r.date && x.type === 'income').reduce((s, x) => s + x.amount, 0);
      const dayExp = filtered.filter(x => x.date === r.date && x.type === 'expense').reduce((s, x) => s + x.amount, 0);
      if (dayInc) html += '<span class="pos" style="font-size:12px;margin-left:8px">收 +' + fmt2(dayInc) + '</span>';
      if (dayExp) html += '<span style="font-size:12px;margin-left:6px;color:var(--danger)">支 −' + fmt2(dayExp) + '</span>';
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
  if (lastDate) html += '</div>';
  $('#ledger-list').innerHTML = html;
}

function renderTxSubs() {
  const g = $('#tx-group').value;
  // 切换主分类会重绘子分类下拉，这里保留用户已输入的金额，避免被清空
  const amountEl = $('#tx-amount');
  const keptAmount = amountEl ? amountEl.value : '';
  const wrap = $('#wrap-subcategory');
  const subs = S.settings.catGroups[g] || [];
  if (g === '工资' || !subs.length) {
    wrap.classList.add('hidden');
  } else {
    wrap.classList.remove('hidden');
    $('#tx-category').innerHTML = subs.map(s => '<option>' + esc(s) + '</option>').join('');
    $('#tx-category')._sync && $('#tx-category')._sync();
  }
  // 车队支出可关联司机
  const drvWrap = $('#wrap-tx-driver');
  if (drvWrap) {
    drvWrap.classList.toggle('hidden', g !== '车队');
    if (g === '车队') {
      const keep = $('#tx-driver').value;
      $('#tx-driver').innerHTML = driverOptions(keep);
      $('#tx-driver').value = keep; // 触发劫持的 value setter 自动 sync
    }
  }
  // 工资支出可关联员工（用 initCustPick 绑定的，手动 sync 按钮文字）
  const empWrap = $('#wrap-tx-employee');
  if (empWrap) {
    empWrap.classList.toggle('hidden', g !== '工资');
    if (g === '工资') {
      const sel = $('#tx-employee');
      const keep = sel.value;
      sel.innerHTML = empOptions(keep);
      sel.value = keep;
      const label = $('#tx-emp-label');
      if (label) {
        const o = sel.options[sel.selectedIndex];
        label.textContent = (o && o.value) ? o.textContent : '选择员工';
      }
    }
  }
  if (amountEl) amountEl.value = keptAmount;
}

function empOptions(selected) {
  const list = S.employees.filter(e2 => e2.active !== false)
    .sort((a, b) => (a.role || '').localeCompare(b.role || '', 'zh') || a.name.localeCompare(b.name, 'zh'));
  let html = '<option value=""' + (selected ? '' : ' selected') + '>不关联</option>'
    + list.map(e2 => '<option value="' + e2.id + '"' + (e2.id === selected ? ' selected' : '') + '>' + esc(e2.name) + '</option>').join('');
  if (selected && !list.some(e2 => e2.id === selected)) html += '<option value="' + selected + '" selected>' + esc(empName(selected)) + '</option>';
  return html;
}

// 司机下拉：仅在职的「司机」职位员工
function driverOptions(selected) {
  const list = S.employees.filter(e2 => e2.active !== false && e2.role === '司机')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  let html = '<option value=""' + (selected ? '' : ' selected') + '>不关联</option>'
    + list.map(e2 => '<option value="' + e2.id + '"' + (e2.id === selected ? ' selected' : '') + '>' + esc(e2.name) + '</option>').join('');
  if (selected && !list.some(e2 => e2.id === selected)) html += '<option value="' + selected + '" selected>' + esc(empName(selected)) + '</option>';
  return html;
}

/* ---------- 自定义支出子分类 ---------- */
let subcatGroup = '';
function openSubcatModal() {
  const g = $('#tx-group').value;
  if (!g) { toast('请先选择主分类'); return; }
  subcatGroup = g;
  $('#subcat-modal').innerHTML =
    '<div class="modal-head"><h2>新增分类 · ' + esc(g) + '</h2><button class="modal-x" id="btn-subcat-x">&times;</button></div>'
    + '<label style="display:block">分类名称<input type="text" id="subcat-name" autocomplete="off" placeholder="例如：叉车维修" style="width:100%;margin-top:6px"></label>'
    + '<div class="modal-foot"><button class="ghost" id="btn-subcat-cancel">取消</button><button class="primary" id="btn-subcat-save">保存</button></div>';
  $('#subcat-mask').classList.remove('hidden');
  $('#btn-subcat-x').addEventListener('click', closeSubcatModal);
  $('#btn-subcat-cancel').addEventListener('click', closeSubcatModal);
  $('#btn-subcat-save').addEventListener('click', saveSubcat);
  $('#subcat-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveSubcat(); } });
}
function closeSubcatModal() {
  $('#subcat-mask').classList.add('hidden');
  $('#subcat-modal').innerHTML = '';
}
async function saveSubcat() {
  const name = ($('#subcat-name').value || '').trim();
  const g = subcatGroup;
  if (!name) { toast('请输入分类名称'); return; }
  const list = S.settings.catGroups[g] || [];
  if (list.includes(name)) { toast('该分类已存在'); return; }
  S.settings.catGroups[g] = list.concat([name]);
  await saveSetting('catGroups', S.settings.catGroups);
  renderTxSubs();
  $('#tx-category').value = name;
  closeSubcatModal();
  toast('已新增分类：' + name);
}
// 按钮位于弹窗模板内，挂载后才存在，使用事件委托绑定
document.addEventListener('click', e => {
  if (e.target.closest('#btn-add-sub')) { e.preventDefault(); openSubcatModal(); }
  if (e.target.closest('#btn-add-inc-type')) { e.preventDefault(); openIncTypeModal(); }
});

/* ---------- 自定义收入费用类型 ---------- */
function renderIncTypes(selected) {
  const list = S.settings.incomeFees && S.settings.incomeFees.length ? S.settings.incomeFees : ['进仓费', '打印费'];
  const keep = selected || ($('#inc-type') && $('#inc-type').value);
  $('#inc-type').innerHTML = list.map(s => '<option' + (s === keep ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
  $('#inc-type')._sync && $('#inc-type')._sync();
}
function openIncTypeModal() {
  $('#subcat-modal').innerHTML =
    '<div class="modal-head"><h2>新增费用类型</h2><button class="modal-x" id="btn-subcat-x">&times;</button></div>'
    + '<label style="display:block">类型名称<input type="text" id="subcat-name" autocomplete="off" style="width:100%;margin-top:6px"></label>'
    + '<div class="modal-foot"><button class="ghost" id="btn-subcat-cancel">取消</button><button class="primary" id="btn-inc-type-save">保存</button></div>';
  $('#subcat-mask').classList.remove('hidden');
  $('#btn-subcat-x').addEventListener('click', closeSubcatModal);
  $('#btn-subcat-cancel').addEventListener('click', closeSubcatModal);
  $('#btn-inc-type-save').addEventListener('click', saveIncType);
  $('#subcat-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveIncType(); } });
}
async function saveIncType() {
  const name = ($('#subcat-name').value || '').trim();
  if (!name) { toast('请输入类型名称'); return; }
  const list = S.settings.incomeFees || [];
  if (list.includes(name)) { toast('该类型已存在'); return; }
  S.settings.incomeFees = list.concat([name]);
  await saveSetting('incomeFees', S.settings.incomeFees);
  renderIncTypes(name);
  closeSubcatModal();
  toast('已新增类型：' + name);
}

function initTxForm() {
  // 沿用上一笔的分类与日期（金额从空开始，方便录入新一笔）
  const last = S.settings.lastTx || {};
  const groups = ['仓库', '车队', '工资'];
  const group = groups.includes(last.group) ? last.group : '仓库';
  $('#tx-date').value = last.date || todayStr();
  $('#tx-group').value = group;
  $('#tx-amount').value = '';
  $('#tx-note').value = '';
  $('#wrap-tx-date').classList.remove('hidden');
  renderTxSubs();
  if (last.group === group && last.category) {
    const catSel = $('#tx-category');
    if (catSel && Array.from(catSel.options).some(o => o.value === last.category)) catSel.value = last.category;
  }
  renderIncTypes();
  const lastInc = S.settings.lastIncCustomer;
  $('#inc-customer').value = (lastInc && S.customers.some(c => c.id === lastInc)) ? lastInc : '';
  setTxTab('expense');
  // 滚动到顶部（抽屉页的滚动容器是 #modal）
  const mask = $('#modal-mask');
  if (mask) mask.scrollTop = 0;
  const panel = $('#modal');
  if (panel) panel.scrollTop = 0;
}

let txTab = 'expense';
function setTxTab(t) {
  txTab = t;
  const inc = t === 'income';
  const g = $('#tx-group').value;
  $('#seg-expense').classList.toggle('active', !inc);
  $('#seg-income').classList.toggle('active', inc);
  $('#wrap-tx-group').classList.toggle('hidden', inc);
  // 子分类：收入 tab 隐藏；支出 tab 只有仓库/车队才显示（工资无子分类）
  const needSub = !inc && (g === '仓库' || g === '车队');
  $('#wrap-subcategory').classList.toggle('hidden', !needSub);
  $('#wrap-tx-driver').classList.toggle('hidden', inc || g !== '车队');
  $('#wrap-tx-employee').classList.toggle('hidden', inc || g !== '工资');
  $('#wrap-inc-customer').classList.toggle('hidden', !inc);
  $('#wrap-inc-type').classList.toggle('hidden', !inc);
  if (inc) renderIncTypes();
  $('#wrap-tx-date').classList.remove('hidden');
}

function openTxForm() {
  const tpl = $('#tx-form-modal');
  const mask = $('#modal-mask');
  $('#modal').innerHTML = tpl.innerHTML;
  // 以右侧滑出的抽屉页展示，而不是居中弹窗
  mask.classList.add('drawer-mode');
  mask.classList.remove('hidden');
  void mask.offsetWidth; // 触发一次重排，让滑入动画生效
  mask.classList.add('open');
  $('#inc-customer').innerHTML = '<option value="">不选客户</option>' + S.customers.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');

  // 把抽屉里的原生 select 全部变成 cust-pick 风格
  pickifySelect($('#tx-group'), { placeholder: '仓库' });
  pickifySelect($('#tx-driver'), { placeholder: '不关联' });
  pickifySelect($('#tx-category'), { placeholder: '选择子分类' });
  pickifySelect($('#inc-type'), { placeholder: '选择费用类型' });

  initTxForm();
  initCustPick({ select: '#inc-customer', btn: '#inc-cust-btn', pop: '#inc-cust-pop', label: '#inc-cust-label', placeholder: '不选客户' });
  initCustPick({ select: '#tx-employee', btn: '#tx-emp-btn', pop: '#tx-emp-pop', label: '#tx-emp-label', placeholder: '选择员工' });
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
  initBillCustPick();
  $('#bill3-period').value = monthStr();
  $('#bill3-amount').value = '';
  $('#bill3-note').value = '';
  $('#btn-save-bill3').addEventListener('click', saveBill3);
  $('#bill3-amount').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveBill3(); } });
}

// 把一个已存在的原生 <select> 改造成 cust-pick 风格的下拉
function pickifySelect(selectEl, opts) {
  if (!selectEl || selectEl._pickified) return null;
  // 如果 select 已经在 cust-pick wrapper 里（比如 initCustPick 处理过的），跳过
  if (selectEl.closest('.cust-pick')) return null;
  opts = opts || {};
  const placeholder = opts.placeholder || '选择';

  const id = selectEl.id || ('sel_' + Math.random().toString(36).slice(2, 8));
  selectEl.id = id;

  // 把原 select 从文档流中拿出来，放在 wrapper 里隐藏（保留兄弟元素在父级）
  const wrapper = document.createElement('span');
  wrapper.className = 'cust-pick cust-pick-enhanced';
  selectEl.parentNode.replaceChild(wrapper, selectEl);
  selectEl.classList.add('hidden');
  selectEl.style.display = 'none';
  wrapper.appendChild(selectEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cust-pick-btn';
  btn.id = id + '_btn';

  const label = document.createElement('span');
  label.id = id + '_label';
  const caret = document.createElement('span');
  caret.className = 'cust-pick-caret';
  caret.textContent = '▾';
  btn.appendChild(label);
  btn.appendChild(caret);

  const pop = document.createElement('div');
  pop.className = 'cust-pick-pop hidden';
  pop.id = id + '_pop';

  wrapper.insertBefore(btn, selectEl);
  wrapper.appendChild(pop);

  const sync = () => {
    const o = selectEl.options[selectEl.selectedIndex];
    label.textContent = (o && o.value) ? o.textContent : placeholder;
  };
  const renderPop = () => {
    pop.innerHTML = Array.from(selectEl.options).map(o =>
      '<div class="cust-pick-item' + (o.value === selectEl.value ? ' active' : '') + '" data-v="' + esc(o.value) + '">' + esc(o.textContent) + '</div>'
    ).join('') || '<div class="cust-pick-empty">—</div>';
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    renderPop();
    pop.classList.toggle('hidden');
  });

  pop.addEventListener('click', e => {
    const item = e.target.closest('[data-v]');
    if (!item) return;
    e.stopPropagation();
    selectEl.value = item.dataset.v;
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    pop.classList.add('hidden');
  });

  // 劫持 .value setter —— 让 JS 代码直接改 select.value 时按钮文字也自动刷新
  try {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(selectEl, 'value', {
      configurable: true,
      enumerable: origDesc.enumerable,
      get: origDesc.get,
      set: function(v) { origDesc.set.call(this, v); sync(); }
    });
  } catch (_) { /* 某些环境无法劫持，忽略 */ }

  sync();
  selectEl._pickified = true;
  selectEl._sync = sync;
  return { wrapper, btn, pop, label, sync };
}

function initCustPick(cfg) {
  const sel = $(cfg.select), btn = $(cfg.btn), pop = $(cfg.pop), label = $(cfg.label);
  if (!sel || !btn) return;
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    label.textContent = (o && o.value) ? o.textContent : (cfg.placeholder || '选择客户');
  };
  const renderPop = () => {
    const opts = Array.from(sel.options);
    pop.innerHTML = opts.map(o =>
      '<div class="cust-pick-item' + (o.value === sel.value ? ' active' : '') + '" data-v="' + esc(o.value) + '">' + esc(o.textContent) + '</div>'
    ).join('') || '<div class="cust-pick-empty">暂无客户</div>';
  };
  btn.addEventListener('click', e => { e.stopPropagation(); renderPop(); pop.classList.toggle('hidden'); });
  pop.addEventListener('click', e => {
    const item = e.target.closest('[data-v]');
    if (!item) return;
    e.stopPropagation();
    sel.value = item.dataset.v;
    sync();
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    pop.classList.add('hidden');
  });
  sync();
}
function initBillCustPick() {
  initCustPick({ select: '#bill3-customer', btn: '#bill3-cust-btn', pop: '#bill3-cust-pop', label: '#bill3-cust-label', placeholder: '选择客户' });
}
document.addEventListener('click', e => {
  if (!e.target.closest('.cust-pick')) $$('.cust-pick-pop').forEach(p => p.classList.add('hidden'));
});

async function saveBill3() {
  const cid = $('#bill3-customer').value;
  const period = $('#bill3-period').value;
  const amount = round2($('#bill3-amount').value);
  const note = $('#bill3-note').value.trim();
  if (!cid) { toast('请先添加顾客'); return; }
  if (!period) { toast('请选择月份'); return; }
  if (!amount || amount <= 0) { toast('请输入正确金额'); return; }
  const dup = S.bills.some(b => b.customerId === cid && b.period === period);
  if (dup && !confirm('该顾客这个月份已有账单，确定再添加一张吗？')) return;
  const bill = { id: uid(), customerId: cid, feeType: '进仓费', period: period, amount: amount, note: note, billDate: '', createdAt: Date.now() };
  await dbPut('bills', bill);
  await saveSetting('lastBillCustomer', cid);
  // 有预收余额时自动抵扣这张新账单（钱已在收款时计入收入，这里不再生成收入）
  const c = S.customers.find(x => x.id === cid);
  let usedPrepaid = 0;
  if (c && Number(c.prepaid || 0) > 0) {
    usedPrepaid = Math.min(round2(c.prepaid), amount);
    await addBillPayment(bill, usedPrepaid, todayStr(), '预收余额抵扣', { fromPrepaid: true });
    c.prepaid = round2(Number(c.prepaid) - usedPrepaid);
  }
  if (c) { c.lastActiveAt = Date.now(); await dbPut('customers', c); }
  await loadState();
  closeModal();
  renderBills();
  toast(usedPrepaid > 0 ? ('月账单已添加，预收抵扣 ' + fmtInt(usedPrepaid)) : '月账单已添加（待收）');
}

// 弹窗内容是动态注入的，事件必须在注入后再绑定
function bindTxFormEvents() {
  $('#seg-expense').addEventListener('click', () => setTxTab('expense'));
  $('#seg-income').addEventListener('click', () => setTxTab('income'));
  $('#tx-group').addEventListener('change', renderTxSubs);
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
    if (!date) { toast('请选择日期'); return; }
    const newId = uid();
    await dbPut('incomes', { id: newId, date: date, type: $('#inc-type').value, customerId: cid || '', amount: amount, note: note, createdAt: Date.now() });
    await saveSetting('lastIncCustomer', cid || '');
    await saveSetting('lastTx', Object.assign({}, S.settings.lastTx || {}, { date: date }));
    await loadState();
    closeModal();
    revealLedgerRecord('incomes', newId, date);
    toast(cid ? '收入已保存，计入客户现结收入' : '收入已保存');
    return;
  }
  const date = $('#tx-date').value;
  if (!date) { toast('请选择日期'); return; }
  if (S.expenses.some(r => r.date === date && round2(Number(r.amount)) === amount)) {
    if (!confirm(date + ' 已有一笔相同金额的支出，是否重复录入？')) return;
  }
  const group = $('#tx-group').value;
  const needSub = (group === '仓库' || group === '车队');
  const sub = needSub ? ($('#tx-category').value || '') : '';
  const newId = uid();
  const driverId = group === '车队' ? ($('#tx-driver').value || null) : null;
  const employeeId = group === '工资' ? ($('#tx-employee').value || null) : null;
  await dbPut('expenses', { id: newId, date: date, category: group, sub: sub, amount: amount, note: note, driverId: driverId, employeeId: employeeId, status: null, pendingKind: null, createdAt: Date.now() });
  await saveSetting('lastTx', { group: group, category: sub, date: date });
  await loadState();
  closeModal();
  revealLedgerRecord('expenses', newId, date);
  toast('已保存');
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
      ? '<div class="kv"><span>客户</span><b>' + esc(custName(rec.customerId) || '未选客户') + '</b></div>'
        + '<div class="kv"><span>费用类型</span><b>' + esc(rec.type || '—') + '</b></div>'
      : '<div class="kv"><span>分类</span><b>' + esc(catLabel(rec)) + '</b></div>'
        + (rec.category === '工资' ? '<div class="kv"><span>员工</span><b>' + esc(empName(rec.employeeId) || '未关联') + '</b></div>' : '')
        + (rec.category === '车队' && rec.driverId ? '<div class="kv"><span>司机</span><b>' + esc(empName(rec.driverId)) + '</b></div>' : ''))
    + (pending
      ? '<div class="kv"><span>日期</span><b>' + (rec.date || '—') + '</b></div>'
        + '<div class="form-grid" style="margin-top:10px;margin-bottom:0">'
        + '<label>金额（元） <input type="number" id="le-amount" min="0.01" step="0.01" inputmode="decimal" value="' + rec.amount + '"></label>'
        + '<label>备注 <input type="text" id="le-note" value="' + esc(rec.note || '') + '"></label>'
        + (rec.category === '车队' ? '<label>司机 <select id="le-driver">' + driverOptions(rec.driverId) + '</select></label>' : '')
        + (rec.category === '工资' ? '<label>员工 <select id="le-employee">' + empOptions(rec.employeeId) + '</select></label>' : '')
        + '</div>'
      : '<div class="form-grid" style="margin-top:12px;margin-bottom:0">'
        + '<label>日期 <input type="date" id="le-date" value="' + (rec.date || '') + '"></label>'
        + '<label>金额（元） <input type="number" id="le-amount" min="0.01" step="0.01" inputmode="decimal" value="' + rec.amount + '"></label>'
        + '<label class="span2">备注 <input type="text" id="le-note" value="' + esc(rec.note || '') + '"></label>'
        + (rec.category === '车队' ? '<label class="span2">司机 <select id="le-driver">' + driverOptions(rec.driverId) + '</select></label>' : '')
        + (rec.category === '工资' ? '<label class="span2">员工 <select id="le-employee">' + empOptions(rec.employeeId) + '</select></label>' : '')
        + '</div>')
    + '<button class="primary" id="btn-ledger-save" style="margin-top:12px">保存修改</button>'
    + (pending
      ? '<div class="inline-form" style="margin-top:12px"><input type="date" id="ledger-pay-date" value="' + todayStr() + '"><button class="primary small" id="btn-ledger-pay">' + payLabel + '</button></div>'
        + '<p class="muted" style="margin-top:8px">确认后计入所选日期的支出统计（原挂账日期为 ' + (rec.date || '—') + '）</p>'
      : '')
    + '<div class="modal-foot"><button class="ghost danger" id="btn-ledger-del">删除这条记录</button></div>';
  $('#modal-mask').classList.remove('hidden');
  pickifySelect($('#le-driver'), { placeholder: '不关联' });
  pickifySelect($('#le-employee'), { placeholder: '不关联' });
});

// FAB 打开新增表单
$('#fab-add').addEventListener('click', openTxForm);
$('#card-add-bill').addEventListener('click', () => {
  openBillForm();
});

// 月份切换
$('#ledger-month').addEventListener('change', function () {
  renderLedger();
  if (!$('#stats-page').classList.contains('hidden')) renderStatsPage();
});
$('#ledger-month').addEventListener('click', function () {
  if (this.showPicker) {
    try { this.showPicker(); } catch (_) {}
  }
});
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
    const periodText = b.period ? b.period.replace('-', '年') + '月' : '未设账期';
    return '<div class="item-card" data-bill="' + b.id + '">'
      + '<div class="ic-main">'
      + '<div class="ic-title"><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span><span class="badge badge-' + invBadge(ist.key) + '">' + ist.label + '</span></div>'
      + '<div class="ic-sub">' + esc(periodText) + ' · 已收 ' + fmtInt(paidOf(b.id)) + '</div>'
      + '</div>'
      + '<div class="ic-right"><div class="ic-amt">' + fmtInt(billBase(b)) + '</div><div class="ic-sub2">待收 ' + fmtInt(st.remaining) + '</div></div>'
      + '</div>';
  };
  // 默认展示所有客户，无待收账单的客户显示「全部已结清」
  // 客户排序：最近新增月账单或登记收款的客户在前，其余按创建顺序
  const lastBillAt = {};
  S.bills.forEach(b => { lastBillAt[b.customerId] = Math.max(lastBillAt[b.customerId] || 0, Number(b.createdAt) || 0); });
  const billCust = {};
  S.bills.forEach(b => { billCust[b.id] = b.customerId; });
  S.payments.forEach(p => {
    const cid = p.customerId || billCust[p.billId];
    if (!cid || !lastBillAt[cid]) return;
    lastBillAt[cid] = Math.max(lastBillAt[cid] || 0, Number(p.createdAt) || (Date.parse(p.date) || 0));
  });
  const order = S.customers
    .map((c, i) => ({ id: c.id, at: Math.max(lastBillAt[c.id] || 0, Number(c.lastActiveAt) || 0), i }))
    .sort((a, b) => (b.at - a.at) || (a.i - b.i))
    .map(c => c.id);
  list.forEach(b => { if (!order.includes(b.customerId)) order.push(b.customerId); });
  const yearReceived = {};
  yearIncomeRows().forEach(r => { yearReceived[r.cid] = r.amount; });
  const html = order.map(cid => {
    const bills = list.filter(b => b.customerId === cid);
    const sum = bills.reduce((acc, b) => { acc.remaining += billState(b).remaining; return acc; }, { remaining: 0 });
    const isOpen = expandedBillGroups.has(cid);
    return '<div class="bill-group">'
      + '<div class="item-card bill-group-head" data-group="' + cid + '">'
      + '<div class="bill-group-top"><div class="ic-title bill-group-name">' + esc(custName(cid)) + '</div><div class="ic-sub2 bill-group-toggle">' + (isOpen ? '收起 ▲' : '展开 ▼') + '</div></div>'
      + '<div class="bill-group-summary">'
      + '<div class="bill-group-stat"><span>本年已收</span><strong>' + fmtInt(yearReceived[cid] || 0) + '</strong></div>'
      + '<div class="bill-group-stat"><span>待收金额</span><strong class="' + (sum.remaining > 0 ? 'neg' : '') + '">' + fmtInt(sum.remaining > 0 ? sum.remaining : 0) + '</strong></div>'
      + '</div>'
      + '</div>'
      + (isOpen ? '<div class="bill-group-inner">' + bills.map(billCardHtml).join('') + '<div class="group-foot"><button class="ghost small" data-custdetail="' + cid + '">账单明细</button><button class="ghost small" data-custinfo="' + cid + '">收费标准</button></div></div>' : '')
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
  if (cd) { openCustDetail(cd.dataset.custdetail); return; }
  const ci = e.target.closest('[data-custinfo]');
  if (ci) openCustInfoModal(ci.dataset.custinfo);
});

/* ---------- 账单详情弹窗 ---------- */
let currentBillId = null;

// 给账单登记一笔收款，并同步手动设置的待收金额（override）
async function addBillPayment(bill, amount, date, note, extra) {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const pay = Object.assign({ id: uid(), billId: bill.id, date: date, amount: amt, note: note || '', createdAt: Date.now() }, extra || {});
  await dbPut('payments', pay);
  // 登记收款即视为该客户最近有动作，列表排序置顶
  const rcust = S.customers.find(x => x.id === bill.customerId);
  if (rcust) { rcust.lastActiveAt = Date.now(); await dbPut('customers', rcust); }
  if (bill.remainingOverride !== undefined && bill.remainingOverride !== null && isFinite(Number(bill.remainingOverride))) {
    bill.remainingOverride = Math.max(0, round2(Number(bill.remainingOverride) - amt));
    const naturalAfter = Math.max(0, round2(billBase(bill) - (paidOf(bill.id) + amt)));
    if (bill.remainingOverride <= 0 || round2(bill.remainingOverride) === naturalAfter) delete bill.remainingOverride;
    await dbPut('bills', bill);
  }
  return pay;
}


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
    + '<div class="kv"><span>账单金额</span><b>' + fmtInt(billBase(b)) + (Number(b.writeOff || 0) > 0 ? '<span class="muted">（原 ' + fmtInt(b.amount) + '，减免 ' + fmtInt(b.writeOff) + '）</span>' : '') + '</b></div>'
    + '<div class="kv"><span>已收 / 待收</span><b>' + fmtInt(paidOf(b.id)) + ' / <span class="strong">' + fmtInt(st.remaining) + '</span></b></div>'
    + (round2(paidOf(b.id) - billBase(b)) > 0 ? '<div class="kv"><span>多收</span><b class="muted">' + fmtInt(round2(paidOf(b.id) - billBase(b))) + '（收款合计超出应收）</b></div>' : '')
    + '<div class="kv"><span>收款状态</span><b><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span></b></div>'
    + '<div class="kv"><span>开票状态</span><b><span class="badge badge-' + invBadge(ist.key) + '">' + ist.label + '</span></b></div>'
    + '<div class="kv"><span>已开票 / 待开</span><b>' + fmtInt(ist.invoiced) + ' / <span class="strong">' + fmtInt(ist.remaining) + '</span></b></div>'
    + '<div class="sub-title">收款记录</div>'
    + '<table class="mini-table"><thead><tr><th>日期</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>'
    + (pays.map(p => '<tr><td>' + (p.date || '—') + '</td><td>' + fmtInt(p.amount) + '</td><td>' + esc(p.note || '') + '</td>'
        + '<td>' + (p.receiptId
          ? '<button class="link-btn danger" data-delreceipt="' + p.receiptId + '" title="撤销这笔整笔收款">撤销</button>'
          : '<button class="link-btn danger" data-delpay="' + p.id + '">删除</button>') + '</td></tr>').join('')
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
    + (invs.map(v => '<tr><td>' + (v.date || '—') + '</td><td>' + fmtInt(Number(v.amount) > 0 ? v.amount : billBase(b)) + '</td>'
        + '<td><button class="link-btn danger" data-delinv="' + v.id + '">删除</button></td></tr>').join('')
      || '<tr><td colspan="3" class="empty">还没有开票</td></tr>')
    + '</tbody></table>'
    + (ist.key !== 'done'
      ? '<div class="inline-form">'
        + '<input type="number" id="inv-amount" placeholder="开票金额" step="0.01" min="0.01" inputmode="decimal" value="' + (ist.remaining > 0 ? ist.remaining : '') + '">'
        + '<input type="date" id="inv-date" value="' + todayStr() + '">'
        + '<button class="primary small" id="btn-add-inv">登记开票</button></div>'
      : '<p class="muted" style="margin-top:8px">发票已全部开完</p>')
    + '<div class="modal-foot">'
    + (st.remaining > 0 ? '<button class="ghost" id="btn-writeoff">差额核销 ' + fmtInt(st.remaining) + '</button>' : '')
    + '<button class="ghost danger" id="btn-del-bill">删除整张账单</button></div>';
  $('#modal-mask').classList.remove('hidden');
}

function closeModal() {
  const mask = $('#modal-mask');
  currentBillId = null; currentWageId = null;
  if (mask.classList.contains('drawer-mode')) {
    // 抽屉页先滑出再隐藏
    mask.classList.remove('open');
    setTimeout(() => { mask.classList.add('hidden'); mask.classList.remove('drawer-mode'); }, 240);
    return;
  }
  mask.classList.add('hidden');
}
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
    const pay = await addBillPayment(bill, amount, date, note);
    // 收款自动生成收入流水（记一笔可见，删除收款时联动删除）；月账单收款固定记为「账单收款」，不混入现结收入
    await dbPut('incomes', { id: uid(), date: date, type: '账单收款', customerId: bill.customerId, amount: amount, note: note, billId: bill.id, paymentId: pay.id, createdAt: Date.now() });
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    toast('收款已登记，收入已计入记一笔');
    return;
  }
  // 撤销一笔整笔收款：删除所有核销记录、收入流水并回补预收余额
  if (t.dataset.delreceipt) {
    if (!confirm('撤销这笔整笔收款？将同时删除它在所有账期上的核销记录和对应收入。')) return;
    const rid = t.dataset.delreceipt;
    const pays = S.payments.filter(p => p.receiptId === rid);
    const incs = S.incomes.filter(i => i.receiptId === rid);
    let prepaidBack = 0;
    for (const i of incs) { prepaidBack += Number(i.prepaidPart || 0); await dbDel('incomes', i.id); }
    for (const b of S.bills) {
      if (!pays.some(p => p.billId === b.id)) continue;
      if (b.remainingOverride !== undefined) { delete b.remainingOverride; await dbPut('bills', b); }
    }
    for (const p of pays) await dbDel('payments', p.id);
    const cid = incs[0] && incs[0].customerId;
    if (cid && prepaidBack > 0) {
      const c = S.customers.find(x => x.id === cid);
      if (c) { c.prepaid = Math.max(0, round2(Number(c.prepaid || 0) - prepaidBack)); await dbPut('customers', c); }
    }
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    if (document.getElementById('cust-detail') && !document.getElementById('cust-detail').classList.contains('hidden') && cid) openCustDetail(cid);
    toast('该笔收款已撤销');
    return;
  }
  // 差额核销（抹零）：把剩余待收记为减免，账单置为已结清
  if (t.id === 'btn-writeoff') {
    const bill = S.bills.find(x => x.id === currentBillId);
    if (!bill) return;
    const st = billState(bill);
    const rem = st.remaining;
    if (!(rem > 0)) return;
    if (!confirm('把待收 ' + fmtInt(rem) + ' 记为减免（抹零），这张账单将置为已结清？')) return;
    bill.writeOff = round2(Number(bill.amount) - Math.min(paidOf(bill.id), Number(bill.amount)));
    delete bill.remainingOverride;
    await dbPut('bills', bill);
    await loadState();
    openBillModal(currentBillId);
    renderBills();
    toast('已核销 ' + fmtInt(rem));
    return;
  }
  if (t.dataset.delpay) {
    if (!confirm('删除这笔收款？「记一笔」中对应的收入将一并删除。')) return;
    const delPay = S.payments.find(p => p.id === t.dataset.delpay);
    const delBill = S.bills.find(x => x.id === currentBillId);
    for (const inc of S.incomes.filter(i => i.paymentId === t.dataset.delpay)) await dbDel('incomes', inc.id);
    await dbDel('payments', t.dataset.delpay);
    // 若账单被手动设置过待收金额，删除收款后同步回补该待收金额；封顶为账单金额，避免翻倍
    if (delPay && delBill && delBill.remainingOverride !== undefined && delBill.remainingOverride !== null && isFinite(Number(delBill.remainingOverride))) {
      delBill.remainingOverride = Math.min(
        round2(billBase(delBill)),
        round2(Number(delBill.remainingOverride) + Number(delPay.amount))
      );
      const naturalAfter = Math.max(0, round2(billBase(delBill) - (paidOf(delBill.id) - Number(delPay.amount))));
      if (round2(delBill.remainingOverride) === naturalAfter) delete delBill.remainingOverride;
      await dbPut('bills', delBill);
    }
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
    w.paidDate = date;
    await dbPut('wages', w);
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
    if (!confirm('删除这条发放记录？')) return;
    // 清理历史上（改版前）登记发放时自动生成的 expense，新数据不会再产生 expense
    const oldEx = S.expenses.filter(x => x.wageId === w.id && (x.paymentId === pid || (!x.paymentId && x.amount == pay.amount)));
    for (const ex of oldEx) await dbDel('expenses', ex.id);
    w.payments = (w.payments || []).filter(p => p.id !== pid);
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
    if (!confirm('删除这张工资单？' + (hasPay ? '所有发放记录将一并清除。' : ''))) return;
    // 清理历史 expense，新版工资单不再自动生成
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
    const drvEl = $('#le-driver');
    if (drvEl) rec.driverId = drvEl.value || null;
    const empEl = $('#le-employee');
    if (empEl) rec.employeeId = empEl.value || null;
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
// 客户管理：只显示名称与编辑、删除
function renderCustAdmin() {
  const el = $('#cust-admin-list');
  if (!el) return;
  $('#cust-admin-count').textContent = S.customers.length + ' 个';
  el.innerHTML = S.customers.map(c =>
    '<div class="item-card">'
    + '<div class="ic-main"><div class="ic-title">' + esc(c.name) + '</div></div>'
    + '<div class="ic-act"><button class="link-btn" data-rencust-modal="' + c.id + '">编辑</button><button class="link-btn danger" data-delcust-modal="' + c.id + '">删除</button></div>'
    + '</div>').join('') || '<div class="empty" style="padding:18px;text-align:center;color:var(--muted)">暂无客户，点右上角「添加客户」</div>';
}
function openCustAdmin() {
  $('#bills-main').classList.add('hidden');
  $('#cust-edit').classList.add('hidden');
  $('#cust-detail').classList.add('hidden');
  $('#cust-admin').classList.remove('hidden');
  renderCustAdmin();
  syncMobileNav();
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
  $('#cust-detail').classList.add('hidden');
  $('#cust-edit').classList.remove('hidden');
  syncMobileNav();
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
  syncMobileNav();
});

// 收费标准弹窗：展示业务、联系方式、现结、月结
function openCustInfoModal(cid) {
  const c = S.customers.find(x => x.id === cid);
  if (!c) return;
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>' + esc(c.name) + ' · 收费标准</h2><button class="modal-x" data-close>&times;</button></div>'
    + customerInfoHtml(c);
  $('#modal-mask').classList.remove('hidden');
}
// 客户资料（业务、联系方式、现结、月结）
function customerInfoHtml(c) {
  const pricing = pricingParts(c);
  return '<div class="kv pricing-detail"><span>业务</span><div class="pricing-text">' + (c.business ? esc(c.business) : '<span class="muted">未填写</span>') + '</div></div>'
    + '<div class="kv pricing-detail"><span>联系方式</span><div class="pricing-text">' + (c.contact ? esc(c.contact) : '<span class="muted">未填写</span>') + '</div></div>'
    + '<div class="kv pricing-detail"><span>现结</span><div class="pricing-text">' + (pricing.cash ? esc(pricing.cash) : '<span class="muted">未填写</span>') + '</div></div>'
    + '<div class="kv pricing-detail" style="border-bottom:none"><span>月结</span><div class="pricing-text">' + (pricing.monthly ? esc(pricing.monthly) : '<span class="muted">未填写</span>') + '</div></div>';
}

// 账单明细：完整页面（非弹窗）
let custDetailYear = String(new Date().getFullYear());
let custDetailCid = null;
function openCustDetail(cid) {
  custDetailCid = cid;
  const c = S.customers.find(x => x.id === cid);
  if (!c) return;
  const incs = S.incomes.filter(i => i.customerId === cid).sort((a, b) => b.date.localeCompare(a.date));
  const cashIncs = incs.filter(isCashIncome);
  const bills = S.bills.filter(b => b.customerId === cid).sort((a, b) => b.period.localeCompare(a.period));
  const yearPrefix = custDetailYear;
  // 四行合计统一按选择年份计算
  const yearBills = bills.filter(b => (b.period || '').startsWith(yearPrefix));
  const owed = round2(yearBills.reduce((s, b) => s + billState(b).remaining, 0));
  const settledTotal = round2(yearBills.filter(b => billState(b).key === 'settled').reduce((s, b) => s + billBase(b), 0));
  const incTotal = round2(cashIncs.filter(i => (i.date || '').startsWith(yearPrefix)).reduce((s, i) => s + Number(i.amount), 0));
  const yearReceivable = round2(yearBills.reduce((s, b) => s + billBase(b), 0));

  $('#cust-detail-name').textContent = c.name;
  const yearLabel = $('#cust-detail-year-label');
  if (yearLabel) yearLabel.textContent = yearPrefix + '年';
  $('#cust-detail-body').innerHTML =
    '<div class="panel">'
    + '<div class="kv"><span>现结合计</span><b>' + fmtInt(incTotal) + '</b></div>'
    + '<div class="kv"><span>应收合计</span><b>' + fmtInt(yearReceivable) + '</b></div>'
    + '<div class="kv"><span>已收合计</span><b>' + fmtInt(settledTotal) + '</b></div>'
    + '<div class="kv"><span>待收欠款</span><b class="' + (owed > 0 ? 'neg' : '') + '">' + fmtInt(owed) + '</b></div>'
    + (Number(c.prepaid || 0) > 0 ? '<div class="kv"><span>预收余额</span><b>' + fmtInt(c.prepaid) + '</b></div>' : '')
    + '<div class="sub-title">应收账单</div>'
    + '<table class="mini-table"><thead><tr><th>账期</th><th>应收</th><th>实收</th><th>待收</th><th>收款状态</th><th>结账日期</th><th>开票状态</th><th>备注</th></tr></thead><tbody>'
    + (bills.map(b => {
        const st = billState(b);
        const ist = invState(b);
        const realPaid = paidOf(b.id);
        return '<tr data-custbill="' + b.id + '"><td>' + esc(b.period) + '</td><td>' + fmtInt(billBase(b)) + (Number(b.writeOff || 0) > 0 ? '<div class="muted">减免 ' + fmtInt(b.writeOff) + '</div>' : '') + '</td><td>' + fmtInt(realPaid) + (round2(realPaid - billBase(b)) > 0 ? '<div class="muted">多收 ' + fmtInt(round2(realPaid - billBase(b))) + '</div>' : '') + '</td><td>' + fmtInt(st.remaining) + '</td>'
          + '<td><span class="badge badge-' + stBadge(st.key) + '">' + st.label + '</span></td>'
          + '<td>' + (lastPayDate(b.id) || '—') + '</td>'
          + '<td><span class="badge badge-' + invBadge(ist.key) + '">' + ist.label + '</span></td>'
          + '<td>' + esc(b.note || '') + '</td>'
          + '</tr>';
      }).join('') || '<tr><td colspan="8" class="empty">暂无账单</td></tr>')
    + '</tbody></table>'
    + '<div class="sub-title">现结收入记录</div>'
    + '<table class="mini-table"><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>备注</th></tr></thead><tbody>'
    + (cashIncs.slice(0, 30).map(i => '<tr><td>' + i.date + '</td><td>' + esc(i.type || '进仓费') + '</td><td>' + fmtInt(i.amount) + '</td><td>' + esc(i.note || '') + '</td></tr>').join('')
      || '<tr><td colspan="4" class="empty">暂无收入记录</td></tr>')
    + '</tbody></table>'
    + '</div>';
  $('#bills-main').classList.add('hidden');
  $('#cust-admin').classList.add('hidden');
  $('#cust-edit').classList.add('hidden');
  $('#cust-detail').classList.remove('hidden');
  syncMobileNav();
}
$('#btn-cust-detail-back').addEventListener('click', () => {
  $('#cust-detail').classList.add('hidden');
  $('#bills-main').classList.remove('hidden');
  renderBills();
  syncMobileNav();
});
// 客户详情页年份切换
$('#btn-cust-year-prev').addEventListener('click', () => {
  custDetailYear = String(Number(custDetailYear) - 1);
  if (custDetailCid) openCustDetail(custDetailCid);
});
$('#btn-cust-year-next').addEventListener('click', () => {
  custDetailYear = String(Number(custDetailYear) + 1);
  if (custDetailCid) openCustDetail(custDetailCid);
});
// 双击应收账单明细行：修改账期与金额
$('#cust-detail-body').addEventListener('dblclick', e => {
  const row = e.target.closest('[data-custbill]');
  if (row) openBillEditModal(row.dataset.custbill);
});

/* ---------- 应收账单交互 ---------- */
let editingBillId = null;
function openBillEditModal(billId) {
  const b = S.bills.find(x => x.id === billId);
  if (!b) return;
  editingBillId = billId;
  const st = billState(b);
  const hasPays = S.payments.some(p => p.billId === b.id);
  $('#modal').innerHTML =
    '<div class="modal-head"><h2>修改账单</h2><button class="modal-x" data-close>&times;</button></div>'
    + '<div class="kv"><span>客户</span><b>' + esc(custName(b.customerId)) + '</b></div>'
    + '<label class="edit-line">账期<input type="month" id="edit-bill-period" value="' + esc(b.period || '') + '"></label>'
    + '<label class="edit-line">应收<input type="number" id="edit-bill-amount" step="1" min="1" inputmode="numeric" value="' + (billBase(b) || '') + '"></label>'
    + '<label class="edit-line">实收<input type="number" id="edit-bill-paid" step="1" min="0" inputmode="numeric" value="' + paidOf(b.id) + '"></label>'
    + '<label class="edit-line">收款状态<select id="edit-bill-status">'
    + '<option value="unpaid"' + (st.key === 'unpaid' ? ' selected' : '') + '>待收</option>'
    + '<option value="partial"' + (st.key === 'partial' ? ' selected' : '') + '>部分收款</option>'
    + '<option value="settled"' + (st.key === 'settled' ? ' selected' : '') + '>已结清</option>'
    + '</select></label>'
    + '<label class="edit-line">待收<input type="number" id="edit-bill-remaining" step="1" min="0" inputmode="numeric" value="' + (st.remaining || 0) + '"></label>'
    + '<label class="edit-line">结账日期<input type="date" id="edit-bill-settledate" value="' + esc(lastPayDate(b.id)) + '"' + (hasPays ? '' : ' disabled') + '></label>'
    + (hasPays ? '' : '<div class="muted" style="font-size:12px;margin:-4px 0 10px">该账单暂无收款记录，结账日期来自「登记收款」</div>')
    + '<label class="edit-line">开票状态<select id="edit-bill-inv">'
    + '<option value="none"' + (invState(b).key === 'none' ? ' selected' : '') + '>待开票</option>'
    + '<option value="partial"' + (invState(b).key === 'partial' ? ' selected' : '') + '>部分开票</option>'
    + '<option value="done"' + (invState(b).key === 'done' ? ' selected' : '') + '>已开票</option>'
    + '</select></label>'
    + '<label class="edit-line">备注<input type="text" id="edit-bill-note" value="' + esc(b.note || '') + '"></label>'
    + '<div class="modal-foot"><button class="ghost" data-close>取消</button><button class="primary" id="btn-edit-bill-save">保存</button></div>';
  $('#modal-mask').classList.remove('hidden');
  pickifySelect($('#edit-bill-status'), { placeholder: '待收' });
  pickifySelect($('#edit-bill-inv'), { placeholder: '自动' });
  $('#btn-edit-bill-save').addEventListener('click', saveBillEdit);
  ['#edit-bill-amount', '#edit-bill-paid', '#edit-bill-remaining'].forEach(s => {
    const el = $(s);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveBillEdit(); } });
  });
  // 待收 = 应收 − 实收，随输入实时联动
  // 待收 = 应收 − 实收，随输入实时联动；收款状态随之同步
  const syncRemaining = () => {
    const rec = round2($('#edit-bill-amount').value);
    const paid = round2($('#edit-bill-paid').value);
    const rem = Math.max(0, round2(rec - paid));
    $('#edit-bill-remaining').value = rem;
    $('#edit-bill-status').value = rem <= 0 ? 'settled' : (paid <= 0 ? 'unpaid' : 'partial');
  };
  ['#edit-bill-amount', '#edit-bill-paid'].forEach(s => $(s).addEventListener('input', syncRemaining));
  // 选「已结清」待收清零；选「待收 / 部分收款」按差额回填
  $('#edit-bill-status').addEventListener('change', e => {
    const rec = round2($('#edit-bill-amount').value);
    const paid = round2($('#edit-bill-paid').value);
    $('#edit-bill-remaining').value = e.target.value === 'settled' ? 0 : Math.max(0, round2(rec - paid));
  });
}
async function saveBillEdit() {
  const b = S.bills.find(x => x.id === editingBillId);
  if (!b) return;
  const period = $('#edit-bill-period').value;
  const receivable = round2($('#edit-bill-amount').value);
  const paidInput = Math.max(0, round2($('#edit-bill-paid').value));
  const remainingInput = Math.max(0, round2($('#edit-bill-remaining').value));
  if (!period) { toast('请选择账期'); return; }
  if (!receivable || receivable <= 0) { toast('请输入正确金额'); return; }
  const cid = b.customerId;
  const oldPaid = paidOf(b.id);
  // 应收 = 账单金额 − 减免；改动应收时保留已登记的减免
  b.period = period;
  b.amount = round2(receivable + Number(b.writeOff || 0));
  // 实收：差额通过补登/削减收款记录调整，保证收入流水与收款明细一致
  const diff = round2(paidInput - oldPaid);
  if (diff > 0) {
    const date = $('#edit-bill-settledate').value || todayStr();
    const pay = { id: uid(), billId: b.id, date: date, amount: diff, note: '手工调整', createdAt: Date.now() };
    await dbPut('payments', pay);
    await dbPut('incomes', { id: uid(), date: date, type: '账单收款', customerId: cid, amount: diff, note: '手工调整', billId: b.id, paymentId: pay.id, createdAt: Date.now() });
  } else if (diff < 0) {
    let cut = -diff;
    const pays = S.payments.filter(p => p.billId === b.id)
      .sort((x, y) => (x.receiptId ? 1 : 0) - (y.receiptId ? 1 : 0) || (y.date || '').localeCompare(x.date || ''));
    for (const p of pays) {
      if (cut <= 0) break;
      const use = Math.min(Number(p.amount), cut);
      cut = round2(cut - use);
      for (const inc of S.incomes.filter(i => i.paymentId === p.id)) await dbDel('incomes', inc.id);
      if (use >= Number(p.amount)) {
        await dbDel('payments', p.id);
      } else {
        p.amount = round2(Number(p.amount) - use);
        await dbPut('payments', p);
        await dbPut('incomes', { id: uid(), date: p.date || todayStr(), type: '账单收款', customerId: cid, amount: p.amount, note: p.note || '', billId: b.id, paymentId: p.id, createdAt: Date.now() });
      }
    }
  }
  // 待收金额独立保存；与「应收 − 实收」一致时不保留覆盖值，恢复自动计算
  const naturalRemaining = Math.max(0, round2(receivable - paidInput));
  if (remainingInput !== naturalRemaining) b.remainingOverride = Math.min(receivable, Math.max(0, remainingInput));
  else delete b.remainingOverride;
  // 开票状态：默认按 invoices 自动算，用户手动选不同的才存为覆盖值
  const invSel = $('#edit-bill-inv').value;
  const autoInv = invState(b).key;
  if (invSel === autoInv) delete b.invOverride;
  else b.invOverride = invSel;
  b.note = $('#edit-bill-note').value.trim();
  // 结账日期：回写到最近一次收款记录，并同步对应收入流水的日期；留空则不修改
  const settleDate = $('#edit-bill-settledate').value;
  if (settleDate) {
    const pays = S.payments.filter(p => p.billId === b.id).sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    const last = pays[pays.length - 1];
    if (last && last.date !== settleDate) {
      last.date = settleDate;
      await dbPut('payments', last);
      const inc = S.incomes.find(i => i.paymentId === last.id);
      if (inc) { inc.date = settleDate; await dbPut('incomes', inc); }
    }
  }
  await dbPut('bills', b);
  const ecust = S.customers.find(x => x.id === cid);
  if (ecust) { ecust.lastActiveAt = Date.now(); await dbPut('customers', ecust); }
  await loadState();
  closeModal();
  renderBills();
  if (!$('#cust-detail').classList.contains('hidden')) openCustDetail(cid);
  toast('账单已更新');
}

/* ---------- 员工工资 ---------- */
function renderWages() {
  pickifySelect($('#wage-filter-status'), { placeholder: '全部状态' });
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
    + '<div class="field">员工 <span class="cust-pick">'
    + '<button type="button" class="cust-pick-btn" id="wage-emp-btn"><span id="wage-emp-label">选择员工</span><span class="cust-pick-caret">▾</span></button>'
    + '<div class="cust-pick-pop hidden" id="wage-emp-pop"></div>'
    + '<select id="wage-emp-select" class="hidden"></select>'
    + '</span></div>'
    + '<label>工资金额（元） <input type="number" min="0" step="1" inputmode="numeric" id="wage-amount"></label>'
    + '<label>缺勤（天） <input type="number" min="0" step="1" inputmode="numeric" id="wage-absence"></label>'
    + '</div>'
    + '<button class="primary" id="btn-gen-wages">生成工资单</button>';
  renderWageGen();
  initCustPick({ select: '#wage-emp-select', btn: '#wage-emp-btn', pop: '#wage-emp-pop', label: '#wage-emp-label', placeholder: '选择员工' });
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
  const prev = sel.value;
  sel.innerHTML = pending.length
    ? pending.map(e2 => '<option value="' + e2.id + '">' + esc(e2.name) + '</option>').join('')
    : '<option value="">' + (actives.length ? '本月工资已全部生成' : '暂无在职员工') + '</option>';
  const okVals = Array.from(sel.options).map(o => o.value);
  sel.value = okVals.includes(prev) ? prev : (okVals[0] || '');
  sel.disabled = !pending.length;
  $('#wage-emp-pop') && $('#wage-emp-pop').classList.add('hidden');
  const btn = $('#wage-emp-btn');
  if (btn) {
    btn.disabled = !pending.length;
    btn.classList.toggle('is-disabled', !pending.length);
  }
  const label = $('#wage-emp-label');
  if (label) {
    const o = sel.options[sel.selectedIndex];
    label.textContent = (o && o.value) ? o.textContent : '选择员工';
  }
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
  S.expenses.filter(e2 => inMonth(e2.date)).forEach(e2 => r1.push([e2.date, '支出', catLabel(e2), (e2.employeeId ? empName(e2.employeeId) : '') || (e2.driverId ? empName(e2.driverId) : ''), '', Number(e2.amount), e2.note || '']));
  const ws1 = XLSX.utils.aoa_to_sheet([r1[0]].concat(r1.slice(1).sort((a, b) => a[0].localeCompare(b[0]))));
  ws1['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws1, '收支明细');

  // 工作表2：应收台账
  const r2 = [['客户', '账期', '账单金额(元)', '已收(元)', '未收(元)', '收款状态', '开票状态']];
  S.bills.filter(billInMonth).sort((a, b) => custName(a.customerId).localeCompare(custName(b.customerId), 'zh') || (a.period || '').localeCompare(b.period || '')).forEach(b => {
    const st = billState(b);
    r2.push([custName(b.customerId), b.period, billBase(b), st.paid, st.remaining, st.label, invState(b).label]);
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
    r4.push([i.date || '', b ? custName(b.customerId) : '', b ? b.period : '', Number(i.amount) > 0 ? Number(i.amount) : (b ? billBase(b) : ''), b ? billBase(b) : '']);
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

// 客户选择下拉：进入设置页时按客户名重新填充
function renderExportCustSelect() {
  const sel = $('#export-cust-select');
  if (!sel) return;
  pickifySelect(sel, { placeholder: '选择客户' });
  const prev = sel.value;
  sel.innerHTML = S.customers.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    .map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('');
  sel.value = prev; // 劫持 setter 自动 sync
}

// 按客户导出全部月账单 + 记一笔日收入（含备注）
$('#btn-export-cust').addEventListener('click', async () => {
  const cid = $('#export-cust-select').value;
  if (!cid) { toast('请先选择客户'); return; }
  if (typeof XLSX === 'undefined') {
    toast('首次导出需加载组件，请稍候…');
    try { await ensureXLSX(); } catch (err) { alert(err.message); return; }
  }
  const wb = XLSX.utils.book_new();

  // 月账单
  const r1 = [['客户', '账期', '账单金额(元)', '已收(元)', '待收(元)', '收款状态', '开票状态', '备注']];
  S.bills.filter(b => b.customerId === cid)
    .sort((a, b) => (a.period || '').localeCompare(b.period || ''))
    .forEach(b => {
      const st = billState(b);
      r1.push([custName(cid), b.period || '', billBase(b) || 0, st.paid, st.remaining, st.label, invState(b).label, b.note || '']);
    });
  const ws1 = XLSX.utils.aoa_to_sheet(r1);
  ws1['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws1, '月账单');

  // 记一笔日收入（现结收入，不含账单收款）
  const r2 = [['日期', '费用类型', '金额(元)', '备注']];
  S.incomes.filter(i => i.customerId === cid && isCashIncome(i))
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .forEach(i => r2.push([i.date || '', i.type || '进仓费', Number(i.amount) || 0, i.note || '']));
  const ws2 = XLSX.utils.aoa_to_sheet(r2);
  ws2['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, ws2, '日收入');

  XLSX.writeFile(wb, '客户账单_' + custName(cid) + '_' + todayStr() + '.xlsx');
  toast('客户账单已导出');
});

/* ---------- 备份与恢复 ---------- */
$('#btn-backup').addEventListener('click', () => {
  const data = {
    app: 'company-ledger', version: 1, exportedAt: new Date().toISOString(),
    customers: S.customers, incomes: S.incomes, expenses: S.expenses,
    bills: S.bills, payments: S.payments, invoices: S.invoices,
    employees: S.employees, wages: S.wages, billFiles: S.billFiles,
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
  for (const bf of data.billFiles || []) await dbPut('billFiles', bf);
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
