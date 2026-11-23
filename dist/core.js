(function (root) {
  'use strict';

  const SCHEMA_VERSION = 2;
  const APP_ID = 'money-where-did-it-go';
  const EXPENSE_CATEGORIES = ['餐饮', '交通', '购物', '住房', '娱乐', '医疗', '学习', '生活', '其他'];
  const INCOME_CATEGORIES = ['工资', '兼职', '奖金', '投资', '其他'];

  function toCents(value) {
    const text = String(value == null ? '' : value).replace(/,/g, '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const parts = text.split('.');
    const cents = Number(parts[0]) * 100 + Number(((parts[1] || '') + '00').slice(0, 2));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function formatCents(value) {
    const cents = Number(value);
    if (!Number.isSafeInteger(cents)) return '0.00';
    return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
    const parts = value.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
  }

  function monthOf(date) {
    return isValidDate(date) ? date.slice(0, 7) : '';
  }

  function shiftDate(date, days) {
    const parts = date.split('-').map(Number);
    const value = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
    return [value.getUTCFullYear(), String(value.getUTCMonth() + 1).padStart(2, '0'), String(value.getUTCDate()).padStart(2, '0')].join('-');
  }

  function todayISO(now) {
    const date = now || new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function validateBill(input, sourceVersion) {
    const bill = input || {};
    const type = bill.type;
    const amount = Number(bill.amount);
    const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    if (type !== 'expense' && type !== 'income') throw new Error('账单类型无效');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('金额必须是大于零的整数分');
    if (categories.indexOf(bill.category) < 0) throw new Error('账单分类无效');
    if (!isValidDate(bill.date)) throw new Error('账单日期无效');
    if (typeof bill.id !== 'string' || !bill.id) throw new Error('账单编号缺失');
    const version = Number(sourceVersion || bill.schemaVersion || SCHEMA_VERSION);
    if (version !== 1 && version !== SCHEMA_VERSION) throw new Error('账单版本不支持');
    return {
      id: bill.id,
      type,
      amount,
      category: bill.category,
      date: bill.date,
      note: String(bill.note || '').slice(0, 120),
      source: bill.source === 'voice' ? 'voice' : 'manual',
      originalText: bill.source === 'voice' ? String(bill.originalText || '').slice(0, 500) : '',
      createdAt: Number(bill.createdAt) || 0,
      updatedAt: Number(bill.updatedAt) || 0,
      schemaVersion: SCHEMA_VERSION
    };
  }

  function migrateBill(input, fromVersion) {
    if (fromVersion !== 1) return validateBill(input, SCHEMA_VERSION);
    // v1 already stored integer cents; v2 adds a bounded note and optional voice transcript.
    return validateBill(input, 1);
  }

  function monthStats(bills, month) {
    const rows = (bills || []).filter(function (bill) { return monthOf(bill.date) === month; });
    const stats = {
      month,
      income: 0,
      expense: 0,
      balance: 0,
      todayExpense: 0,
      billCount: rows.length,
      days: {},
      expenseCategories: {},
      incomeCategories: {}
    };
    const today = todayISO();
    rows.forEach(function (bill) {
      if (bill.type === 'income') {
        stats.income += bill.amount;
        stats.incomeCategories[bill.category] = (stats.incomeCategories[bill.category] || 0) + bill.amount;
      } else {
        stats.expense += bill.amount;
        stats.expenseCategories[bill.category] = (stats.expenseCategories[bill.category] || 0) + bill.amount;
        stats.days[bill.date] = (stats.days[bill.date] || 0) + bill.amount;
        if (bill.date === today) stats.todayExpense += bill.amount;
      }
    });
    stats.balance = stats.income - stats.expense;
    return stats;
  }

  function budgetUsage(stats, budget) {
    const totalBudget = Math.max(0, Number(budget && budget.totalBudget) || 0);
    const spent = stats ? stats.expense : 0;
    return {
      spent,
      totalBudget,
      remaining: totalBudget - spent,
      percent: totalBudget ? Math.min(100, Math.round(spent / totalBudget * 100)) : 0,
      over: totalBudget > 0 && spent > totalBudget
    };
  }

  function sortedTotals(totals) {
    return Object.keys(totals || {}).map(function (name) {
      return { category: name, amount: totals[name] };
    }).sort(function (a, b) {
      return b.amount - a.amount || a.category.localeCompare(b.category, 'zh-CN');
    });
  }

  function parseVoiceText(text, today) {
    const originalText = String(text || '').trim();
    const nowDate = isValidDate(today) ? today : todayISO();
    const amountRegex = /(?:(?:[¥￥]|人民币)\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(人民币|元钱|元|块钱|块))/g;
    const amountMatches = [];
    let match;
    while ((match = amountRegex.exec(originalText)) !== null) {
      amountMatches.push({ raw: match[0], value: match[1] || match[2] });
    }
    let amount = null;
    let status = 'ready';
    function markStatus(next) {
      if (status !== 'ambiguous' || next === 'ambiguous') status = next;
    }
    if (amountMatches.length === 1) amount = toCents(amountMatches[0].value);
    else status = amountMatches.length > 1 ? 'ambiguous' : 'needs_review';
    if (amountMatches.length === 1 && amount === null) markStatus('needs_review');

    let date = nowDate;
    const uncertainDate = /前几天|上周|下周|这周|本周|上个月|下个月|去年|明年|月底|月初|月中|最近|周末/.test(originalText);
    if (uncertainDate) {
      date = '';
      markStatus('ambiguous');
    } else if (/大前天/.test(originalText)) date = shiftDate(nowDate, -3);
    else if (/前天/.test(originalText)) date = shiftDate(nowDate, -2);
    else if (/昨天|昨日/.test(originalText)) date = shiftDate(nowDate, -1);
    else {
      const explicit = originalText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
      const shortDate = originalText.match(/(\d{1,2})月(\d{1,2})日/);
      if (explicit) {
        const candidate = explicit[1] + '-' + String(explicit[2]).padStart(2, '0') + '-' + String(explicit[3]).padStart(2, '0');
        date = isValidDate(candidate) ? candidate : '';
        if (!date) markStatus('ambiguous');
      } else if (shortDate) {
        const candidate = nowDate.slice(0, 4) + '-' + String(shortDate[1]).padStart(2, '0') + '-' + String(shortDate[2]).padStart(2, '0');
        date = isValidDate(candidate) ? candidate : '';
        markStatus(date ? 'needs_review' : 'ambiguous');
      }
    }

    const incomeWords = /收到|收入|工资|薪水|兼职|奖金|投资|入账/.test(originalText);
    const expenseWords = /花|消费|支出|买|购物|支付|付了|打车|吃饭|餐/.test(originalText);
    const type = incomeWords !== expenseWords ? (incomeWords ? 'income' : 'expense') : '';
    if (!type) markStatus('needs_review');

    const categoryRules = type === 'income'
      ? [['工资|薪水', '工资'], ['兼职', '兼职'], ['奖金', '奖金'], ['投资|利息', '投资']]
      : [['吃饭|吃|餐|咖啡|午餐|晚餐|早餐', '餐饮'], ['打车|出租|公交|地铁|交通|加油', '交通'], ['衣服|购物|买了|网购|超市|商场', '购物'], ['房租|住房|水电|物业', '住房'], ['电影|游戏|娱乐|看展|演出', '娱乐'], ['医院|看病|药|医疗', '医疗'], ['课程|学习|书|培训', '学习'], ['日用品|生活|买菜', '生活']];
    let category = '';
    categoryRules.some(function (rule) {
      if (new RegExp(rule[0]).test(originalText)) {
        category = rule[1];
        return true;
      }
      return false;
    });
    if (!category && type) {
      category = '其他';
      markStatus('needs_review');
    }

    let note = originalText;
    amountMatches.forEach(function (item) { note = note.replace(item.raw, ' '); });
    note = note.replace(/\d{4}年\d{1,2}月\d{1,2}日?|\d{1,2}月\d{1,2}日|今天|今日|昨天|昨日|大前天|前天/g, ' ');
    note = note.replace(/收到|收入|工资|薪水|兼职|奖金|投资|入账|花了|花费|花|消费|支出|买了|买|支付|付了/g, ' ');
    note = note.replace(/[，。,.!！?？、\s]+/g, ' ').trim().slice(0, 120);

    return {
      type,
      amount,
      category,
      date,
      note,
      originalText,
      status,
      confidence: status === 'ready' ? 0.9 : (status === 'ambiguous' ? 0.25 : 0.55)
    };
  }

  function validateGoal(input, sourceVersion) {
    const goal = input || {};
    const version = Number(sourceVersion || goal.schemaVersion || SCHEMA_VERSION);
    if (version !== 1 && version !== SCHEMA_VERSION) throw new Error('存钱目标版本不支持');
    if (typeof goal.id !== 'string' || !goal.id) throw new Error('目标编号缺失');
    if (!String(goal.name || '').trim()) throw new Error('请填写目标名称');
    if (!Number.isSafeInteger(Number(goal.targetAmount)) || Number(goal.targetAmount) <= 0) throw new Error('目标金额无效');
    if (!Number.isSafeInteger(Number(goal.savedAmount)) || Number(goal.savedAmount) < 0) throw new Error('已存金额无效');
    if (goal.targetDate && !isValidDate(goal.targetDate)) throw new Error('目标日期无效');
    return { id: goal.id, name: String(goal.name).trim().slice(0, 40), targetAmount: Number(goal.targetAmount), savedAmount: Number(goal.savedAmount), targetDate: goal.targetDate || '', createdAt: Number(goal.createdAt) || 0, updatedAt: Number(goal.updatedAt) || 0, schemaVersion: SCHEMA_VERSION };
  }

  function validateBudget(input, month, sourceVersion) {
    const budget = input || {};
    const version = Number(sourceVersion || budget.schemaVersion || SCHEMA_VERSION);
    if (version !== 1 && version !== SCHEMA_VERSION) throw new Error('预算版本不支持');
    if (budget.month !== month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('预算月份无效');
    const totalBudget = Number(budget.totalBudget) || 0;
    if (!Number.isSafeInteger(totalBudget) || totalBudget < 0) throw new Error('月预算必须为零或正整数分');
    const categoryBudgets = {};
    Object.keys(budget.categoryBudgets || {}).forEach(function (category) {
      const amount = Number(budget.categoryBudgets[category]);
      if (EXPENSE_CATEGORIES.indexOf(category) < 0 || !Number.isSafeInteger(amount) || amount < 0) throw new Error('分类预算无效');
      if (amount > 0) categoryBudgets[category] = amount;
    });
    return { month, totalBudget, categoryBudgets, schemaVersion: SCHEMA_VERSION };
  }

  function validateBackup(input) {
    const data = input || {};
    if (data.app !== APP_ID || (Number(data.schemaVersion) !== 1 && Number(data.schemaVersion) !== SCHEMA_VERSION)) throw new Error('备份文件不是兼容的钱去哪里了账本');
    const bills = (data.bills || []).map(function (bill) { return migrateBill(bill, Number(data.schemaVersion)); });
    const ids = {};
    bills.forEach(function (bill) {
      if (ids[bill.id]) throw new Error('备份中存在重复账单编号');
      ids[bill.id] = true;
    });
    const budgets = (data.budgets || []).map(function (budget) { return validateBudget(budget, budget.month, data.schemaVersion); });
    const goals = (data.goals || []).map(function (goal) { return validateGoal(goal, data.schemaVersion); });
    return { app: APP_ID, schemaVersion: SCHEMA_VERSION, bills, budgets, goals };
  }

  const api = {
    SCHEMA_VERSION,
    APP_ID,
    EXPENSE_CATEGORIES,
    INCOME_CATEGORIES,
    toCents,
    formatCents,
    isValidDate,
    monthOf,
    shiftDate,
    todayISO,
    validateBill,
    migrateBill,
    monthStats,
    budgetUsage,
    sortedTotals,
    parseVoiceText,
    validateGoal,
    validateBudget,
    validateBackup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LedgerCore = api;
}(typeof window !== 'undefined' ? window : null));
