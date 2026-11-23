'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LedgerCore = require('../assets/js/ledger-core.js');

const {
  toCents,
  fromCents,
  round2,
  addMoney,
  subtractMoney,
  compareMoney,
  sumMoney,
  getBillMetrics,
  getWriteOffAmount,
  planPaymentAdjustment,
  parseExcelDate,
  parseIncomeAOA,
  dedupeIncomeRows
} = LedgerCore;

test('金额按整数分换算、舍入、汇总和比较', () => {
  assert.equal(toCents('1.005'), 101);
  assert.equal(fromCents(101), 1.01);
  assert.equal(round2(1.005), 1.01);
  assert.equal(addMoney(0.1, 0.2), 0.3);
  assert.equal(subtractMoney(0.3, 0.1), 0.2);
  assert.equal(compareMoney(0.1 + 0.2, 0.3), 0);
  assert.equal(sumMoney([0.1, 0.2, '1.005']), 1.31);
});

test('部分收款与刚好结清使用实际收款合计', () => {
  const bill = { id: 'b1', amount: 100 };
  const payments = [
    { id: 'p1', billId: 'b1', amount: 30.1 },
    { id: 'p2', billId: 'b1', amount: 20.2 },
    { id: 'other', billId: 'b2', amount: 999 }
  ];
  const partial = getBillMetrics(bill, payments);
  assert.equal(partial.key, 'partial');
  assert.equal(partial.paid, 50.3);
  assert.equal(partial.remaining, 49.7);
  assert.equal(partial.overpaid, 0);

  const settled = getBillMetrics(bill, payments.concat({ id: 'p3', billId: 'b1', amount: 49.7 }));
  assert.equal(settled.key, 'settled');
  assert.equal(settled.paid, 100);
  assert.equal(settled.remaining, 0);
});

test('超额收款保留实收并准确计算多收金额', () => {
  const bill = { id: 'b1', amount: 100, writeOff: 0.05 };
  const payments = [
    { id: 'p1', billId: 'b1', amount: 60 },
    { id: 'p2', billId: 'b1', amount: 40.1 }
  ];
  const metrics = getBillMetrics(bill, payments);
  assert.equal(metrics.base, 99.95);
  assert.equal(metrics.paidRecords, 100.1);
  assert.equal(metrics.paid, 100.1);
  assert.equal(metrics.remaining, 0);
  assert.equal(metrics.overpaid, 0.15);
  assert.equal(metrics.key, 'settled');
});

test('差额核销按实际收款计算，不读取手动待收覆盖值', () => {
  const bill = { id: 'b1', amount: 100, remainingOverride: 7.77 };
  const payments = [
    { id: 'p1', billId: 'b1', amount: 33.3 },
    { id: 'p2', billId: 'b1', amount: 66.66 },
    { id: 'other', billId: 'b2', amount: 100 }
  ];
  assert.equal(getBillMetrics(bill, payments).remaining, 7.77);
  assert.equal(getWriteOffAmount(bill, payments), 0.04);
});

test('修改实收增加时补登同额收款及关联收入', () => {
  const ids = ['pay-new', 'income-new'];
  const result = planPaymentAdjustment({
    payments: [{ id: 'p1', billId: 'b1', amount: 20.1 }, { id: 'p2', billId: 'b1', amount: 9.2 }],
    incomes: [],
    billId: 'b1',
    customerId: 'c1',
    targetPaid: 31.3,
    date: '2026-11-22',
    today: '2026-11-22',
    createId: () => ids.shift(),
    createdAt: 123
  });
  assert.equal(result.oldPaid, 29.3);
  assert.equal(result.targetPaid, 31.3);
  assert.equal(result.diff, 2);
  assert.deepEqual(result.paymentPuts, [
    { id: 'pay-new', billId: 'b1', date: '2026-11-22', amount: 2, note: '手工调整', createdAt: 123 }
  ]);
  assert.deepEqual(result.incomePuts, [
    { id: 'income-new', date: '2026-11-22', type: '账单收款', customerId: 'c1', amount: 2, note: '手工调整', billId: 'b1', paymentId: 'pay-new', createdAt: 123 }
  ]);
  assert.deepEqual(result.paymentDeletes, []);
  assert.deepEqual(result.incomeDeletes, []);
});

test('修改实收部分削减时更新收款并重建对应收入', () => {
  const payments = [
    { id: 'p1', billId: 'b1', date: '2026-01-01', amount: 30.1, note: '第一笔' },
    { id: 'p2', billId: 'b1', date: '2026-01-02', amount: 20.2, note: '第二笔' }
  ];
  const incomes = [
    { id: 'i1', paymentId: 'p1', amount: 30.1 },
    { id: 'i2', paymentId: 'p2', amount: 20.2 }
  ];
  const result = planPaymentAdjustment({
    payments,
    incomes,
    billId: 'b1',
    customerId: 'c1',
    targetPaid: 45.3,
    date: '2026-11-22',
    today: '2026-11-22',
    createId: () => 'income-new',
    createdAt: 123
  });
  assert.equal(result.diff, -5);
  assert.deepEqual(result.paymentDeletes, []);
  assert.deepEqual(result.incomeDeletes, ['i2']);
  assert.deepEqual(result.paymentPuts, [
    { id: 'p2', billId: 'b1', date: '2026-01-02', amount: 15.2, note: '第二笔' }
  ]);
  assert.deepEqual(result.incomePuts, [
    { id: 'income-new', date: '2026-01-02', type: '账单收款', customerId: 'c1', amount: 15.2, note: '第二笔', billId: 'b1', paymentId: 'p2', createdAt: 123 }
  ]);
  assert.equal(payments[1].amount, 20.2, '不得修改原收款对象');
});

test('修改实收跨记录削减时依次删除并缩减收款', () => {
  const result = planPaymentAdjustment({
    payments: [
      { id: 'p1', billId: 'b1', date: '2026-01-01', amount: 30.1, note: '' },
      { id: 'p2', billId: 'b1', date: '2026-01-02', amount: 20.2, note: '' },
      { id: 'other', billId: 'b2', date: '2026-01-03', amount: 999 }
    ],
    incomes: [{ id: 'i1', paymentId: 'p1' }, { id: 'i2', paymentId: 'p2' }, { id: 'other', paymentId: 'other' }],
    billId: 'b1',
    customerId: 'c1',
    targetPaid: 5,
    date: '2026-11-22',
    today: '2026-11-22',
    createId: () => 'income-new',
    createdAt: 123
  });
  assert.equal(result.oldPaid, 50.3);
  assert.equal(result.diff, -45.3);
  assert.deepEqual(result.paymentDeletes, ['p2']);
  assert.deepEqual(result.incomeDeletes, ['i2', 'i1']);
  assert.equal(result.paymentPuts.length, 1);
  assert.equal(result.paymentPuts[0].id, 'p1');
  assert.equal(result.paymentPuts[0].amount, 5);
  assert.equal(result.incomePuts.length, 1);
  assert.equal(result.incomePuts[0].paymentId, 'p1');
  assert.equal(result.incomePuts[0].amount, 5);
});

test('Excel 日期支持序列值、字符串和 Date 对象', () => {
  assert.equal(parseExcelDate(45292), '2024-01-01');
  assert.equal(parseExcelDate('2026/1/2'), '2026-01-02');
  assert.equal(parseExcelDate('2026年11月22日'), '2026-11-22');
  assert.equal(parseExcelDate(new Date(2026, 10, 22)), '2026-11-22');
  assert.equal(parseExcelDate('不是日期'), null);
  assert.equal(parseExcelDate(''), null);
});

test('Excel 有编号按客户与编号判重，无编号仅标记疑似重复', () => {
  const customers = [{ id: 'c1', name: '甲方' }];
  const incomes = [
    { id: 'i1', type: '进仓费', customerId: 'c1', date: '2026-01-02', amount: 10.01, bizNo: 'A-1', note: 'A-1' },
    { id: 'i2', type: '进仓费', customerId: 'c1', date: '2026-01-02', amount: 10.01, bizNo: '', note: 'Excel导入' }
  ];
  const result = parseIncomeAOA([
    ['日期', '客户', '进仓费', '委托编号'],
    ['2026/1/2', '甲方', '10.01', 'A-1'],
    ['2026-01-02', '甲方', 10.01, 'B-2'],
    ['2026年1月2日', '甲方', '￥10.010', ''],
    ['2026-01-03', '甲方', '1.005', 'C-3']
  ], '', incomes, customers);
  assert.equal(result.error, undefined);
  assert.equal(result.rows[0].dup, true);
  assert.equal(result.rows[0].selected, false);
  assert.equal(result.rows[1].dup, false, '同金额不同编号不得误判');
  assert.equal(result.rows[1].possibleDup, false);
  assert.equal(result.rows[1].selected, true);
  assert.equal(result.rows[2].possibleDup, true);
  assert.equal(result.rows[2].selected, false, '无编号疑似重复默认不勾选');
  assert.equal(result.rows[3].amount, 1.01);
});

test('Excel 不同工作表按客户与编号判重', () => {
  const customers = [{ id: 'c1', name: '甲方' }, { id: 'c2', name: '乙方' }];
  const header = ['日期', '客户', '金额', '编号'];
  const first = parseIncomeAOA([header, ['2026-01-02', '甲方', 10, 'D-1']], '', [], customers).rows;
  const second = parseIncomeAOA([
    header,
    ['2026-01-03', '甲方', 20, 'D-1'],
    ['2026-01-04', '乙方', 30, 'D-1'],
    ['2026-01-02', '甲方', 10, '']
  ], '', [], customers).rows;
  const rows = first.concat(second);
  dedupeIncomeRows(rows);
  assert.equal(rows[0].dup, false);
  assert.equal(rows[1].dup, true);
  assert.equal(rows[1].fileDup, true);
  assert.equal(rows[1].selected, false);
  assert.equal(rows[2].dup, false, '相同编号属于不同客户时不得误判');
  assert.equal(rows[3].fileDup, false, '无编号记录不参与文件内编号去重');
});
