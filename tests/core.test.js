'use strict';

const assert = require('node:assert/strict');
const Core = require('../core.js');

assert.equal(Core.toCents('35'), 3500);
assert.equal(Core.toCents('1.2'), 120);
assert.equal(Core.toCents('0.01'), 1);
assert.equal(Core.toCents('1.239'), null);
assert.equal(Core.toCents('0'), null);
assert.equal(Core.toCents('1,200.50'), 120050);
assert.equal(Core.formatCents(123456), '1,234.56');
assert.equal(Core.isValidDate('2026-02-28'), true);
assert.equal(Core.isValidDate('2026-02-30'), false);
assert.equal(Core.monthOf('2026-11-01'), '2026-11');
assert.equal(Core.monthOf('bad-date'), '');
assert.equal(Core.shiftDate('2026-03-01', -1), '2026-02-28');

const today = Core.todayISO();
const summary = Core.monthStats([
  { type: 'expense', amount: 1200, category: '餐饮', date: today },
  { type: 'expense', amount: 800, category: '交通', date: today },
  { type: 'income', amount: 10000, category: '工资', date: today },
  { type: 'expense', amount: 500, category: '购物', date: '2020-01-01' }
], today.slice(0, 7));
assert.equal(summary.expense, 2000);
assert.equal(summary.income, 10000);
assert.equal(summary.balance, 8000);
assert.equal(summary.todayExpense, 2000);
assert.equal(summary.expenseCategories['餐饮'], 1200);
assert.equal(summary.incomeCategories['工资'], 10000);
assert.equal(summary.billCount, 3);

assert.equal(Core.budgetUsage(summary, { totalBudget: 4000 }).remaining, 2000);
assert.equal(Core.budgetUsage(summary, { totalBudget: 1500 }).over, true);
assert.deepEqual(Core.sortedTotals({ 交通: 200, 餐饮: 500 }).map((row) => row.category), ['餐饮', '交通']);

const voiceExpense = Core.parseVoiceText('今天中午吃饭花了35元', '2026-11-20');
assert.equal(voiceExpense.type, 'expense');
assert.equal(voiceExpense.amount, 3500);
assert.equal(voiceExpense.category, '餐饮');
assert.equal(voiceExpense.date, '2026-11-20');
assert.equal(voiceExpense.note, '中午吃饭');
assert.equal(voiceExpense.status, 'ready');
const voiceYesterday = Core.parseVoiceText('昨天打车花了28元', '2026-11-20');
assert.equal(voiceYesterday.date, '2026-11-19');
assert.equal(voiceYesterday.category, '交通');
const voiceIncome = Core.parseVoiceText('今天收到工资8000元', '2026-11-20');
assert.equal(voiceIncome.type, 'income');
assert.equal(voiceIncome.category, '工资');
assert.equal(voiceIncome.amount, 800000);
assert.equal(Core.parseVoiceText('买鞋花了100元又买裤子花了200元', '2026-11-20').status, 'ambiguous');
assert.equal(Core.parseVoiceText('上周买衣服花了200元', '2026-11-20').date, '');
assert.equal(Core.parseVoiceText('人民币35今天吃饭', '2026-11-20').amount, 3500);
assert.equal(Core.parseVoiceText('下周买衣服花了200元', '2026-11-20').status, 'ambiguous');
assert.equal(Core.parseVoiceText('今天买东西花了20元', '2026-11-20').status, 'needs_review');

const migrated = Core.migrateBill({ id: 'bill_1', type: 'expense', amount: 3500, category: '餐饮', date: '2026-11-19' }, 1);
assert.equal(migrated.amount, 3500);
assert.equal(migrated.schemaVersion, 2);
assert.equal(Core.validateBudget({ month: '2026-11', totalBudget: 50000 }, '2026-11', 1).schemaVersion, 2);
assert.equal(Core.validateGoal({ id: 'goal_1', name: '旅行', targetAmount: 100000, savedAmount: 0 }, 1).schemaVersion, 2);
assert.throws(() => Core.validateBill({ id: 'x', type: 'expense', amount: 0, category: '餐饮', date: '2026-11-19' }));
assert.throws(() => Core.validateBudget({ month: '2026-13', totalBudget: 100 }, '2026-13'));
assert.throws(() => Core.validateBackup({ app: Core.APP_ID, schemaVersion: 2, bills: [migrated, migrated] }));

console.log('core checks passed');
