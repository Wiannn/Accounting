(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LedgerCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 通过十进制指数移位换算，避免 1.005 * 100 的二进制浮点误差。
  function shiftDecimal(value, places) {
    const parts = String(value).toLowerCase().split('e');
    const exponent = parts.length > 1 ? Number(parts[1]) : 0;
    return Number(parts[0] + 'e' + String(exponent + places));
  }

  function toCents(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.round(shiftDecimal(number, 2));
  }

  function fromCents(cents) {
    const number = Number(cents);
    return Number.isFinite(number) ? shiftDecimal(number, -2) : 0;
  }

  const round2 = value => fromCents(toCents(value));
  const sumCents = values => (values || []).reduce((sum, value) => sum + toCents(value), 0);
  const sumMoney = values => fromCents(sumCents(values));
  const addMoney = (...values) => sumMoney(values);
  const subtractMoney = (left, right) => fromCents(toCents(left) - toCents(right));
  const compareMoney = (left, right) => toCents(left) - toCents(right);

  function getBillMetrics(bill, payments) {
    const baseCents = Math.max(0, toCents(bill.amount) - toCents(bill.writeOff || 0));
    const paidRecordsCents = sumCents((payments || []).filter(p => p.billId === bill.id).map(p => p.amount));
    const hasOverride = bill.remainingOverride !== undefined && bill.remainingOverride !== null && Number.isFinite(Number(bill.remainingOverride));
    const remainingCents = hasOverride
      ? Math.min(baseCents, Math.max(0, toCents(bill.remainingOverride)))
      : Math.max(0, baseCents - paidRecordsCents);
    const paidCents = hasOverride ? Math.max(0, baseCents - remainingCents) : paidRecordsCents;
    // 待收大于 0 时不再同时显示多收，避免同一张账单既欠款又多收
    const overpaidCents = remainingCents > 0 ? 0 : Math.max(0, paidRecordsCents - baseCents);
    let key = 'unpaid', label = '待收';
    if (remainingCents <= 0) { key = 'settled'; label = '已结清'; }
    else if (paidCents > 0) { key = 'partial'; label = '部分收款'; }
    return {
      baseCents,
      paidRecordsCents,
      paidCents,
      remainingCents,
      overpaidCents,
      base: fromCents(baseCents),
      paidRecords: fromCents(paidRecordsCents),
      paid: fromCents(paidCents),
      remaining: fromCents(remainingCents),
      overpaid: fromCents(overpaidCents),
      key,
      label
    };
  }

  // 差额核销：把剩余待收记为减免。以实际收款合计为准，不使用手动待收覆盖值；
  // 实收超过应收（多收）时保留已有减免，不再追加，也不会把已有减免清零。
  function getWriteOffAmount(bill, payments) {
    const amountCents = toCents(bill.amount);
    const writeOffCents = Math.max(0, toCents(bill.writeOff || 0));
    const paidCents = sumCents((payments || []).filter(p => p.billId === bill.id).map(p => p.amount));
    const targetCents = Math.max(writeOffCents, amountCents - paidCents);
    return fromCents(Math.min(amountCents, targetCents));
  }

  // 修改实收时生成收款与收入的最终变更集，所有差额均用整数分计算。
  function planPaymentAdjustment(options) {
    const payments = options.payments || [];
    const incomes = options.incomes || [];
    const oldPaidCents = sumCents(payments.filter(p => p.billId === options.billId).map(p => p.amount));
    const targetPaidCents = Math.max(0, toCents(options.targetPaid));
    const diffCents = targetPaidCents - oldPaidCents;
    const result = {
      oldPaid: fromCents(oldPaidCents),
      targetPaid: fromCents(targetPaidCents),
      diff: fromCents(diffCents),
      paymentPuts: [],
      paymentDeletes: [],
      addedPayments: [],
      incomePuts: [],
      incomeDeletes: []
    };
    if (diffCents > 0) {
      const pay = { id: options.createId(), billId: options.billId, date: options.date, amount: fromCents(diffCents), note: '手工调整', createdAt: options.createdAt };
      const income = { id: options.createId(), date: options.date, type: '账单收款', customerId: options.customerId, amount: fromCents(diffCents), note: '手工调整', billId: options.billId, paymentId: pay.id, createdAt: options.createdAt };
      result.paymentPuts.push(pay);
      result.addedPayments.push(pay);
      result.incomePuts.push(income);
    } else if (diffCents < 0) {
      let cutCents = -diffCents;
      const sorted = payments.filter(p => p.billId === options.billId)
        .sort((x, y) => (x.receiptId ? 1 : 0) - (y.receiptId ? 1 : 0) || (y.date || '').localeCompare(x.date || ''));
      for (const payment of sorted) {
        if (cutCents <= 0) break;
        const paymentCents = toCents(payment.amount);
        const useCents = Math.min(paymentCents, cutCents);
        cutCents -= useCents;
        for (const income of incomes.filter(i => i.paymentId === payment.id)) result.incomeDeletes.push(income.id);
        if (useCents === paymentCents) {
          result.paymentDeletes.push(payment.id);
        } else {
          const nextPayment = Object.assign({}, payment, { amount: fromCents(paymentCents - useCents) });
          const income = { id: options.createId(), date: nextPayment.date || options.today, type: '账单收款', customerId: options.customerId, amount: nextPayment.amount, note: nextPayment.note || '', billId: options.billId, paymentId: nextPayment.id, createdAt: options.createdAt };
          result.paymentPuts.push(nextPayment);
          result.incomePuts.push(income);
        }
      }
    }
    return result;
  }

  // 解析各种日期格式为 YYYY-MM-DD，失败返回 null。
  function parseExcelDate(value) {
    if (value == null || value === '') return null;
    const pad = n => String(n).padStart(2, '0');
    if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
      return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const date = new Date(Math.round((value - 25569) * 86400 * 1000));
      return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
    }
    const match = String(value).trim().match(/(\d{4})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})/);
    if (match) return match[1] + '-' + pad(match[2]) + '-' + pad(match[3]);
    return null;
  }

  function incomeBusinessNo(income) {
    const explicit = String(income.bizNo || '').trim();
    if (explicit) return explicit;
    return income.type === '进仓费' && income.note && income.note !== 'Excel导入' ? String(income.note).trim() : '';
  }

  // 纯 Excel 二维数组解析；外部数据通过参数注入，浏览器与测试共用。
  function parseIncomeAOA(aoa, fallbackName, existingIncomes, existingCustomers) {
    if (!aoa || !aoa.length) return { error: 'Excel 里没有内容' };
    const incomes = existingIncomes || [];
    const customers = existingCustomers || [];
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

    const existNames = new Set(customers.map(c => String(c.name || '').trim()));
    const customerName = id => {
      if (!id) return '';
      const customer = customers.find(c => c.id === id);
      return customer ? customer.name : '(已删除客户)';
    };
    const rows = [];
    for (let r = headIdx + 1; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const rawName = cCust >= 0 ? String(row[cCust] == null ? '' : row[cCust]).trim() : '';
      const rawDate = row[cDate], rawAmt = row[cAmt];
      if (!rawName && (rawDate == null || rawDate === '') && (rawAmt == null || rawAmt === '')) continue;
      const name = cCust >= 0 ? rawName : fallbackName;
      const date = parseExcelDate(rawDate);
      const amount = round2(Number(String(rawAmt == null ? '' : rawAmt).replace(/[¥￥,\s元]/g, '')));
      const rec = { name, date, amount, ok: false, reason: '', dup: false, fileDup: false, possibleDup: false, selected: false, newCust: false, no: cNo >= 0 ? String(row[cNo] == null ? '' : row[cNo]).trim() : '' };
      if (!name) rec.reason = '缺客户名';
      else if (!date) rec.reason = '日期无法识别';
      else if (!Number.isFinite(amount) || amount <= 0) rec.reason = '金额无效';
      else {
        rec.ok = true;
        rec.newCust = !existNames.has(name);
        const sameCustomer = i => i.type === '进仓费' && customerName(i.customerId) === name;
        if (rec.no) {
          rec.dup = incomes.some(i => sameCustomer(i) && incomeBusinessNo(i) === rec.no);
        } else {
          rec.possibleDup = incomes.some(i => sameCustomer(i) && i.date === date && compareMoney(i.amount, amount) === 0);
        }
        rec.selected = !rec.dup && !rec.possibleDup;
      }
      rows.push(rec);
    }
    if (!rows.length) return { error: '表头以下没有数据行' };
    return { rows };
  }

  // 同一文件不同工作表按「客户 + 业务编号」去重。
  function dedupeIncomeRows(rows) {
    const seenBusinessNos = new Set();
    (rows || []).forEach(row => {
      if (!row.ok || row.dup || !row.no) return;
      const key = row.name + '\0' + row.no;
      if (seenBusinessNos.has(key)) {
        row.dup = true;
        row.fileDup = true;
        row.selected = false;
      } else {
        seenBusinessNos.add(key);
      }
    });
    return rows;
  }

  return Object.freeze({
    toCents,
    fromCents,
    round2,
    sumCents,
    sumMoney,
    addMoney,
    subtractMoney,
    compareMoney,
    getBillMetrics,
    getWriteOffAmount,
    planPaymentAdjustment,
    parseExcelDate,
    incomeBusinessNo,
    parseIncomeAOA,
    dedupeIncomeRows
  });
});
