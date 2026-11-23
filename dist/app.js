(function () {
  'use strict';

  const Core = window.LedgerCore;
  const store = window.LedgerStorage.createStorage(window.xhs, Core);
  const icons = { 餐饮: 'utensils', 交通: 'bike', 购物: 'shopping-bag', 住房: 'house', 娱乐: 'palette', 医疗: 'bandage', 学习: 'book-open', 生活: 'leaf', 工资: 'briefcase-business', 兼职: 'sparkles', 奖金: 'gift', 投资: 'trending-up', 其他: 'circle-ellipsis' };
  const state = { bills: [], budgets: [], goals: [], currentMonth: Core.todayISO().slice(0, 7), page: 'home', filter: 'all', loaded: false, loadError: null, saving: false, editingId: '', selectedBillId: '', entrySource: 'manual', voiceDraft: null, speech: null, speechTimer: null, toastTimer: null };
  const $ = function (selector) { return document.querySelector(selector); };
  const $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function categoryIconMarkup(category, className) {
    const name = icons[category] || 'circle-help';
    return '<span class="' + className + '" aria-hidden="true"><img src="./assets/icons/' + name + '.svg" alt="" /></span>';
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }

  function setStatus(message, isError) {
    const node = $('#app-status');
    node.textContent = message || '';
    node.classList.toggle('error', !!isError);
  }

  function monthLabel(month) {
    const parts = month.split('-');
    return parts[0] + '年' + Number(parts[1]) + '月';
  }

  function shiftMonth(month, offset) {
    const parts = month.split('-').map(Number);
    const date = new Date(Date.UTC(parts[0], parts[1] - 1 + offset, 1));
    return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
  }

  function dateLabel(date) {
    const parts = date.split('-').map(Number);
    const value = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(value);
  }

  function getMonthBudget(month) {
    return state.budgets.find(function (item) { return item.month === month; }) || { month, totalBudget: 0, categoryBudgets: {} };
  }

  function monthBills(month) {
    return state.bills.filter(function (bill) { return Core.monthOf(bill.date) === month; });
  }

  function renderBillList(target, rows, limit) {
    const sorted = rows.slice().sort(function (a, b) { return b.date.localeCompare(a.date) || b.createdAt - a.createdAt; });
    const visible = typeof limit === 'number' ? sorted.slice(0, limit) : sorted;
    if (!visible.length) {
      target.innerHTML = '';
      return;
    }
    const groups = {};
    visible.forEach(function (bill) {
      if (!groups[bill.date]) groups[bill.date] = [];
      groups[bill.date].push(bill);
    });
    target.innerHTML = Object.keys(groups).sort().reverse().map(function (date) {
      return '<section class="bill-day"><div class="bill-date">' + escapeHtml(dateLabel(date)) + '</div>' + groups[date].map(function (bill) {
        const sign = bill.type === 'income' ? '+' : '−';
        const iconClass = bill.type === 'income' ? 'category-icon income-icon' : 'category-icon';
        return '<button class="bill-row" type="button" data-bill-id="' + escapeHtml(bill.id) + '">' + categoryIconMarkup(bill.category, iconClass) + '<span class="bill-main"><span class="bill-category">' + escapeHtml(bill.category) + '</span><span class="bill-note">' + escapeHtml(bill.note || (bill.source === 'voice' ? '语音记账' : '未填写备注')) + '</span></span><span class="bill-amount ' + bill.type + '">' + sign + ' ¥' + Core.formatCents(bill.amount) + '</span></button>';
      }).join('') + '</section>';
    }).join('');
  }

  function categoryMarkup(rows, total, type) {
    if (!rows.length || !total) return '<p class="hint">记录几笔' + (type === 'income' ? '收入' : '支出') + '后，这里会显示真实分类。</p>';
    return rows.slice(0, 6).map(function (row) {
      const percent = Math.round(row.amount / total * 100);
      const iconClass = type === 'income' ? 'category-icon income-icon' : 'category-icon';
      return '<div class="category-stat">' + categoryIconMarkup(row.category, iconClass) + '<span class="category-stat-main"><b>' + escapeHtml(row.category) + '</b><small>' + percent + '%</small></span><span class="category-stat-value">¥' + Core.formatCents(row.amount) + '</span></div>';
    }).join('');
  }

  function renderHome() {
    const rows = monthBills(state.currentMonth);
    const stats = Core.monthStats(state.bills, state.currentMonth);
    const budget = Core.budgetUsage(stats, getMonthBudget(state.currentMonth));
    $('#home-expense').textContent = '¥' + Core.formatCents(stats.expense);
    $('#home-income').textContent = '¥' + Core.formatCents(stats.income);
    $('#home-balance').textContent = '¥' + Core.formatCents(stats.balance);
    $('#home-today').textContent = '今日支出 ¥' + Core.formatCents(stats.todayExpense);
    $('#home-income-count').textContent = rows.filter(function (bill) { return bill.type === 'income'; }).length + ' 笔收入';
    $('#home-budget-spent').textContent = '本月支出 ¥' + Core.formatCents(stats.expense);
    if (budget.totalBudget) {
      $('#home-budget-caption').textContent = budget.over ? '已经超过预算，慢慢调整就好' : '预算还剩 ¥' + Core.formatCents(Math.max(0, budget.remaining));
      $('#home-budget-remaining').textContent = Core.formatCents(budget.percent) + '% 已使用';
      $('#home-budget-bar').style.width = Math.min(100, budget.percent) + '%';
      $('#home-budget-bar').classList.toggle('over', budget.over);
    } else {
      $('#home-budget-caption').textContent = '设置预算，温柔地提醒自己';
      $('#home-budget-remaining').textContent = '预算未设置';
      $('#home-budget-bar').style.width = '0%';
      $('#home-budget-bar').classList.remove('over');
    }
    renderBillList($('#home-bills'), rows, 5);
    $('#home-empty').hidden = rows.length > 0 || !!state.loadError;
  }

  function renderRecord() {
    const rows = monthBills(state.currentMonth).filter(function (bill) { return state.filter === 'all' || bill.type === state.filter; });
    renderBillList($('#all-bills'), rows);
    $('#record-empty').hidden = rows.length > 0 || !!state.loadError;
  }

  function renderStats() {
    const stats = Core.monthStats(state.bills, state.currentMonth);
    const previousMonth = shiftMonth(state.currentMonth, -1);
    const previous = Core.monthStats(state.bills, previousMonth);
    $('#stats-income').textContent = '¥' + Core.formatCents(stats.income);
    $('#stats-expense').textContent = '¥' + Core.formatCents(stats.expense);
    $('#stats-balance').textContent = '¥' + Core.formatCents(stats.balance);
    $('#previous-income').textContent = '¥' + Core.formatCents(previous.income);
    $('#previous-expense').textContent = '¥' + Core.formatCents(previous.expense);
    const days = new Date(Number(state.currentMonth.slice(0, 4)), Number(state.currentMonth.slice(5, 7)), 0).getDate();
    const values = [];
    for (let day = 1; day <= days; day += 1) {
      const date = state.currentMonth + '-' + String(day).padStart(2, '0');
      values.push({ date, amount: stats.days[date] || 0 });
    }
    const max = values.reduce(function (value, item) { return Math.max(value, item.amount); }, 0);
    $('#daily-chart').innerHTML = max ? values.map(function (item) {
      const height = item.amount ? Math.max(4, Math.round(item.amount / max * 100)) : 0;
      const todayClass = item.date === Core.todayISO() ? ' today' : '';
      return '<div class="day-column" title="' + escapeHtml(item.date) + '：¥' + Core.formatCents(item.amount) + '"><span class="day-bar' + todayClass + '" style="height:' + height + '%"></span></div>';
    }).join('') : '<p class="hint chart-empty">这个月还没有支出记录。</p>';
    $('.chart-axis').hidden = !max;
    $('#expense-categories').innerHTML = categoryMarkup(Core.sortedTotals(stats.expenseCategories), stats.expense, 'expense');
    $('#income-categories').innerHTML = categoryMarkup(Core.sortedTotals(stats.incomeCategories), stats.income, 'income');
    const expenses = Core.sortedTotals(stats.expenseCategories);
    if (!stats.billCount) $('#monthly-summary').textContent = '这个月还没有记录。记下几笔后，这里会根据真实账单生成小结。';
    else if (!stats.expense) $('#monthly-summary').textContent = '这个月记录了 ' + stats.billCount + ' 笔账单，目前没有支出。';
    else $('#monthly-summary').textContent = '本月支出 ¥' + Core.formatCents(stats.expense) + '，' + (expenses.length ? '花费最多的是' + expenses[0].category + '，共 ¥' + Core.formatCents(expenses[0].amount) + '。' : '') + '本月结余 ¥' + Core.formatCents(stats.balance) + '。';
  }

  function renderBudgetSettings() {
    const budget = getMonthBudget(state.currentMonth);
    $('#budget-form').elements.total.value = budget.totalBudget ? (budget.totalBudget / 100).toFixed(2) : '';
    const select = $('#budget-category');
    const selected = select.value;
    select.innerHTML = Core.EXPENSE_CATEGORIES.map(function (category) { return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>'; }).join('');
    if (Core.EXPENSE_CATEGORIES.indexOf(selected) >= 0) select.value = selected;
    const list = Core.sortedTotals(budget.categoryBudgets || {});
    const spentByCategory = Core.monthStats(state.bills, state.currentMonth).expenseCategories;
    $('#category-budget-list').innerHTML = list.map(function (row) {
      const spent = spentByCategory[row.category] || 0;
      const remaining = row.amount - spent;
      return '<div class="simple-list-row"><span>' + escapeHtml(row.category) + ' · 已用 ¥' + Core.formatCents(spent) + ' / ¥' + Core.formatCents(row.amount) + (remaining < 0 ? ' · 已超 ¥' + Core.formatCents(-remaining) : ' · 剩余 ¥' + Core.formatCents(remaining)) + '</span><button type="button" data-remove-budget="' + escapeHtml(row.category) + '">移除</button></div>';
    }).join('');
  }

  function renderGoals() {
    const rows = state.goals.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    $('#goals-list').innerHTML = rows.length ? rows.map(function (goal) {
      const percent = Math.min(100, Math.round(goal.savedAmount / goal.targetAmount * 100));
      return '<article class="goal-item" data-goal-id="' + escapeHtml(goal.id) + '"><div class="goal-title-row"><b>' + escapeHtml(goal.name) + '</b><small>' + (goal.targetDate ? escapeHtml(goal.targetDate) + ' 前' : '不设期限') + '</small></div><div class="goal-progress"><span style="width:' + percent + '%"></span></div><div class="goal-foot"><span>已存 ¥' + Core.formatCents(goal.savedAmount) + '</span><b>目标 ¥' + Core.formatCents(goal.targetAmount) + ' · ' + percent + '%</b></div><div class="goal-actions"><input type="text" inputmode="decimal" placeholder="本次存入金额（元）" data-goal-add-input="' + escapeHtml(goal.id) + '" /><button type="button" data-goal-add="' + escapeHtml(goal.id) + '">记一笔存入</button><button type="button" data-goal-delete="' + escapeHtml(goal.id) + '">删除</button></div></article>';
    }).join('') : '<p class="hint">添加一个小目标，记录每次存入。</p>';
  }

  function render() {
    $('#month-label').textContent = monthLabel(state.currentMonth);
    $('#today-label').textContent = dateLabel(Core.todayISO()) + ' · 今天也要开心';
    $$('.page').forEach(function (page) { page.classList.toggle('active', page.id === 'page-' + state.page); });
    $$('.nav-item').forEach(function (item) { item.classList.toggle('active', item.dataset.page === state.page); });
    renderHome();
    renderRecord();
    renderStats();
    renderBudgetSettings();
    renderGoals();
  }

  function syncFromStore() {
    const snapshot = store.snapshot();
    state.bills = snapshot.bills;
    state.budgets = snapshot.budgets;
    state.goals = snapshot.goals;
    state.loadError = null;
    state.loaded = true;
    $('#storage-usage').textContent = '账本保存在小红书小工具本地存储中';
    return store.storageInfo().then(function (info) {
      $('#storage-usage').textContent = '本地空间已用 ' + (info.usedBytes / 1024 / 1024).toFixed(2) + ' MB / ' + (info.limitBytes / 1024 / 1024).toFixed(0) + ' MB';
      if (info.warning) setStatus('账本已保存，但旧分片清理未完成：' + info.warning, true);
    }).catch(function (error) {
      setStatus(error.message, true);
    });
  }

  function navigate(page) {
    if (['home', 'record', 'stats', 'mine'].indexOf(page) < 0) return;
    state.page = page;
    render();
    window.scrollTo(0, 0);
  }

  function updateCategoryOptions(type, selected) {
    const categories = type === 'income' ? Core.INCOME_CATEGORIES : Core.EXPENSE_CATEGORIES;
    $('#entry-category').innerHTML = categories.map(function (category) { return '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + '</option>'; }).join('');
    if (selected && categories.indexOf(selected) >= 0) $('#entry-category').value = selected;
  }

  function setEntryType(type) {
    const value = type === 'income' ? 'income' : 'expense';
    $('#entry-form').elements.type.value = value;
    $$('[data-entry-type]').forEach(function (button) { button.classList.toggle('active', button.dataset.entryType === value); });
    updateCategoryOptions(value, value === 'income' ? '工资' : '餐饮');
  }

  function openEntry(type, bill, source, originalText) {
    const form = $('#entry-form');
    state.editingId = bill ? bill.id : '';
    state.entrySource = source || (bill && bill.source) || 'manual';
    form.reset();
    $('#entry-error').textContent = '';
    $('#entry-title').textContent = bill ? '修改账单' : '记一笔';
    $('#entry-save').disabled = false;
    setEntryType((bill && bill.type) || type || 'expense');
    form.elements.amount.value = bill ? (bill.amount / 100).toFixed(2) : '';
    form.elements.date.value = bill ? bill.date : Core.todayISO();
    form.elements.note.value = bill ? bill.note : '';
    if (bill) updateCategoryOptions(bill.type, bill.category);
    if (state.entrySource === 'voice' && originalText) state.voiceDraft = { originalText };
    else if (bill && bill.source === 'voice') state.voiceDraft = { originalText: bill.originalText || '' };
    else state.voiceDraft = null;
    $('#entry-dialog').showModal();
    setTimeout(function () { form.elements.amount.focus(); }, 40);
  }

  function closeDialog(dialog) {
    if (dialog && typeof dialog.close === 'function' && dialog.open) dialog.close();
  }

  function showBillDetail(id) {
    const bill = state.bills.find(function (item) { return item.id === id; });
    if (!bill) return;
    state.selectedBillId = id;
    $('#bill-detail').innerHTML = '<div class="detail-amount ' + bill.type + '">' + (bill.type === 'income' ? '+' : '−') + ' ¥' + Core.formatCents(bill.amount) + '</div><div class="detail-row">类型 <b>' + (bill.type === 'income' ? '收入' : '支出') + '</b></div><div class="detail-row">分类 <b>' + escapeHtml(bill.category) + '</b></div><div class="detail-row">日期 <b>' + escapeHtml(bill.date) + '</b></div><div class="detail-row">备注 <b>' + escapeHtml(bill.note || '—') + '</b></div><div class="detail-row">来源 <b>' + (bill.source === 'voice' ? '语音确认' : '手动记录') + '</b></div>';
    $('#bill-dialog').showModal();
  }

  function withSaving(action) {
    if (state.saving) return Promise.resolve(false);
    state.saving = true;
    $$('#entry-form button[type="submit"], #budget-form button, #category-budget-form button, #goal-form button').forEach(function (button) { button.disabled = true; });
    return Promise.resolve().then(action).then(function (value) {
      state.saving = false;
      $$('#entry-form button[type="submit"], #budget-form button, #category-budget-form button, #goal-form button').forEach(function (button) { button.disabled = false; });
      return value;
    }, function (error) {
      state.saving = false;
      $$('#entry-form button[type="submit"], #budget-form button, #category-budget-form button, #goal-form button').forEach(function (button) { button.disabled = false; });
      throw error;
    });
  }

  function handleEntrySubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const amount = Core.toCents(form.elements.amount.value);
    if (amount === null) { $('#entry-error').textContent = '金额需大于 0，最多保留两位小数。'; return; }
    const bill = {
      id: state.editingId || undefined,
      type: form.elements.type.value,
      amount,
      category: form.elements.category.value,
      date: form.elements.date.value,
      note: form.elements.note.value.trim(),
      source: state.entrySource,
      originalText: state.voiceDraft ? state.voiceDraft.originalText : '',
      createdAt: state.editingId ? (state.bills.find(function (row) { return row.id === state.editingId; }) || {}).createdAt : Date.now(),
      schemaVersion: Core.SCHEMA_VERSION
    };
    try { Core.validateBill(Object.assign({}, bill, { id: bill.id || 'pending' })); } catch (error) { $('#entry-error').textContent = error.message; return; }
    $('#entry-error').textContent = '';
    withSaving(async function () {
      try {
        await store.saveBill(bill, state.editingId || '');
        await syncFromStore();
        render();
        closeDialog($('#entry-dialog'));
        state.voiceDraft = null;
        state.editingId = '';
        showToast('账单已保存。');
      } catch (error) {
        $('#entry-error').textContent = error.message;
        setStatus(error.message, true);
      }
    });
  }

  async function saveBudgetForm(event) {
    event.preventDefault();
    const value = event.currentTarget.elements.total.value.trim();
    const total = value ? Core.toCents(value) : 0;
    if (value && total === null) { showToast('请填写有效的预算金额。'); return; }
    const old = getMonthBudget(state.currentMonth);
    try {
      await store.saveBudget({ month: state.currentMonth, totalBudget: total, categoryBudgets: old.categoryBudgets });
      await syncFromStore(); render(); showToast('本月预算已保存。');
    } catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function saveCategoryBudget(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const raw = form.elements.amount.value.trim();
    const amount = raw ? Core.toCents(raw) : null;
    if (amount === null) { showToast('请填写有效的分类预算。'); return; }
    const budget = getMonthBudget(state.currentMonth);
    const categoryBudgets = Object.assign({}, budget.categoryBudgets);
    categoryBudgets[form.elements.category.value] = amount;
    try {
      await store.saveBudget({ month: state.currentMonth, totalBudget: budget.totalBudget, categoryBudgets });
      await syncFromStore(); render(); form.elements.amount.value = ''; showToast('分类预算已保存。');
    } catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  function makeId(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  async function addGoal(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const target = Core.toCents(form.elements.target.value);
    if (target === null) { showToast('目标金额需大于 0。'); return; }
    const now = Date.now();
    const goal = { id: makeId('goal'), name: form.elements.name.value, targetAmount: target, savedAmount: 0, targetDate: form.elements.date.value, createdAt: now, updatedAt: now };
    try { await store.saveGoal(goal); await syncFromStore(); render(); form.reset(); showToast('存钱目标已添加。'); }
    catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function saveGoalContribution(id) {
    const goal = state.goals.find(function (item) { return item.id === id; });
    const input = document.querySelector('[data-goal-add-input="' + id + '"]');
    const amount = Core.toCents(input ? input.value : '');
    if (!goal || amount === null) { showToast('请输入本次存入金额。'); return; }
    const next = Object.assign({}, goal, { savedAmount: goal.savedAmount + amount, updatedAt: Date.now() });
    try { await store.saveGoal(next); await syncFromStore(); render(); showToast('这次存入记下了。'); }
    catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function removeCategoryBudget(category) {
    const old = getMonthBudget(state.currentMonth);
    const categoryBudgets = Object.assign({}, old.categoryBudgets);
    delete categoryBudgets[category];
    try { await store.saveBudget({ month: state.currentMonth, totalBudget: old.totalBudget, categoryBudgets }); await syncFromStore(); render(); }
    catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function exportJSON() {
    try {
      const data = await store.exportData();
      $('#export-text').value = JSON.stringify(data, null, 2);
      $('#export-text').focus(); $('#export-text').select();
      showToast('JSON 已准备好，请手动复制并妥善保存。');
    } catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  async function exportCSV() {
    try {
      const data = await store.exportData();
      const lines = [['日期', '类型', '金额(元)', '分类', '备注', '来源'].map(csvCell).join(',')];
      data.bills.slice().sort(function (a, b) { return a.date.localeCompare(b.date); }).forEach(function (bill) {
        lines.push([bill.date, bill.type === 'income' ? '收入' : '支出', (bill.amount / 100).toFixed(2), bill.category, bill.note, bill.source === 'voice' ? '语音' : '手动'].map(csvCell).join(','));
      });
      $('#export-text').value = lines.join('\r\n');
      $('#export-text').focus(); $('#export-text').select();
      showToast('CSV 已准备好，请手动复制并妥善保存。');
    } catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function restoreJSON() {
    if (!$('#backup-confirm').checked) { showToast('恢复前请先导出并备份当前账本。'); return; }
    let data;
    try { data = Core.validateBackup(JSON.parse($('#restore-text').value)); }
    catch (error) { showToast(error.message || '备份内容无效。'); return; }
    if (!window.confirm('恢复会替换当前账本。已校验 ' + data.bills.length + ' 笔账单、' + data.budgets.length + ' 个预算和 ' + data.goals.length + ' 个目标，继续吗？')) return;
    try { await store.replaceAll(data); await syncFromStore(); render(); $('#restore-text').value = ''; $('#backup-confirm').checked = false; showToast('账本恢复完成。'); }
    catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  async function clearLedger() {
    if (!window.confirm('确定清空当前小工具的全部账单、预算和存钱目标吗？此操作无法撤销。建议先导出备份。')) return;
    try { await store.replaceAll({ app: Core.APP_ID, schemaVersion: Core.SCHEMA_VERSION, bills: [], budgets: [], goals: [] }); await syncFromStore(); render(); showToast('账本已清空。'); }
    catch (error) { setStatus(error.message, true); showToast(error.message); }
  }

  function parseVoice() {
    const text = $('#voice-text').value.trim();
    if (!text) { showToast('先说一句或粘贴一段记账内容。'); return; }
    state.voiceDraft = Core.parseVoiceText(text, Core.todayISO());
    const draft = state.voiceDraft;
    const status = draft.status === 'ready' ? '已提取到金额、类型、分类和日期，请检查后确认。' : (draft.status === 'ambiguous' ? '内容有歧义，请手动补全信息；不会自动保存。' : '部分信息未识别，请在表单中补齐；不会自动保存。');
    $('#voice-result-status').textContent = status + ' 原文：' + draft.originalText + (draft.amount ? '；金额 ¥' + Core.formatCents(draft.amount) : '') + (draft.category ? '；分类 ' + draft.category : '');
    $('#voice-result').hidden = false;
  }

  function finishVoice(recognition, message, focusInput) {
    if (state.speech !== recognition) return;
    window.clearTimeout(state.speechTimer);
    state.speechTimer = null;
    state.speech = null;
    $('#voice-start').disabled = false;
    if (message) $('#voice-hint').textContent = message;
    if (focusInput) window.setTimeout(function () { $('#voice-text').focus(); }, 0);
  }

  function startVoice() {
    if (state.speech) return;
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      $('#voice-hint').textContent = '当前小红书环境没有提供语音识别接口。已打开输入框，可点手机键盘上的麦克风语音转文字，或手动输入。';
      $('#voice-text').focus();
      return;
    }
    try {
      const recognition = new Recognition();
      state.speech = recognition;
      let receivedText = false;
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = false;
      $('#voice-start').disabled = true;
      $('#voice-hint').textContent = '正在请求语音识别；请允许麦克风访问。识别结果需要你确认后才会保存。';
      recognition.onstart = function () {
        if (state.speech !== recognition) return;
        $('#voice-hint').textContent = '正在听，请说出金额和用途…';
      };
      recognition.onresult = function (event) {
        if (state.speech !== recognition) return;
        const result = event.results && event.results[0] && event.results[0][0];
        if (result && result.transcript) {
          receivedText = true;
          $('#voice-text').value = result.transcript;
          parseVoice();
          $('#voice-hint').textContent = '识别完成，请检查内容后确认保存。';
        }
      };
      recognition.onerror = function (event) {
        const errors = {
          'not-allowed': '麦克风权限未开启。请检查小红书的麦克风权限，或使用键盘麦克风语音输入。',
          'service-not-allowed': '当前容器未开放语音识别服务；可使用键盘麦克风语音输入或手动输入。',
          'audio-capture': '没有检测到可用麦克风；可使用键盘麦克风语音输入或手动输入。',
          'network': '语音识别服务连接失败；可使用键盘麦克风语音输入或手动输入。',
          'no-speech': '没有听到语音，请重试或使用键盘麦克风输入。',
          'aborted': '语音识别已停止。'
        };
        finishVoice(recognition, errors[event && event.error] || '语音识别未完成；可使用键盘麦克风语音输入或手动输入。', true);
      };
      recognition.onend = function () {
        finishVoice(recognition, receivedText ? '识别完成，请检查内容后确认保存。' : '没有识别到内容；可重试或使用键盘麦克风语音输入。', !receivedText);
      };
      state.speechTimer = window.setTimeout(function () {
        try { recognition.stop(); } catch (error) {
          try { recognition.abort(); } catch (abortError) { /* The recognition service may already have stopped. */ }
        }
        finishVoice(recognition, '语音识别等待超时；可重试或使用键盘麦克风语音输入。', true);
      }, 20000);
      recognition.start();
    } catch (error) {
      if (state.speech) finishVoice(state.speech, '当前环境无法启动语音识别；可使用键盘麦克风语音输入或手动输入。', true);
      else {
        $('#voice-start').disabled = false;
        $('#voice-hint').textContent = '当前环境无法启动语音识别；可使用键盘麦克风语音输入或手动输入。';
        $('#voice-text').focus();
      }
    }
  }

  function drawRoundRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + width - radius, y);
    context.quadraticCurveTo(x + width, y, x + width, y + radius);
    context.lineTo(x + width, y + height - radius);
    context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    context.lineTo(x + radius, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
    context.fill();
  }

  function createPromotionImage() {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new Error('当前环境无法生成笔记配图。'));

    context.fillStyle = '#F1EFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#E4E0FF';
    context.beginPath();
    context.arc(810, 108, 115, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#FFFFFF';
    drawRoundRect(context, 46, 46, 808, 1108, 44);

    function drawContent() {
      context.fillStyle = '#4037BD';
      context.font = '600 30px sans-serif';
      context.fillText('轻松记账 · 看清钱去哪了', 96, 292);
      context.font = '700 62px sans-serif';
      context.fillText('钱去哪里了？', 96, 390);
      context.fillText('记下来就知道了。', 96, 475);
      context.fillStyle = '#827C9A';
      context.font = '400 30px sans-serif';
      context.fillText('把日常收支记下来，慢慢看懂自己的消费。', 96, 540);

      const features = [
        ['01', '随手记录', '手动记下每天的收入和支出'],
        ['02', '清楚统计', '按月份和分类看看钱花在哪里'],
        ['03', '温柔计划', '设置预算和存钱目标']
      ];
      features.forEach(function (item, index) {
        const y = 620 + index * 142;
        context.fillStyle = '#F6F4FF';
        drawRoundRect(context, 92, y, 716, 112, 24);
        context.fillStyle = '#4037BD';
        context.font = '700 24px sans-serif';
        context.fillText(item[0], 118, y + 43);
        context.fillStyle = '#292443';
        context.font = '700 30px sans-serif';
        context.fillText(item[1], 180, y + 43);
        context.fillStyle = '#827C9A';
        context.font = '400 23px sans-serif';
        context.fillText(item[2], 180, y + 79);
      });
      context.fillStyle = '#4037BD';
      drawRoundRect(context, 92, 1060, 716, 58, 29);
      context.fillStyle = '#FFFFFF';
      context.font = '600 24px sans-serif';
      context.textAlign = 'center';
      context.fillText('不用绑卡，从今天的第一笔开始', 450, 1098);
      context.textAlign = 'left';
      return canvas.toDataURL('image/png');
    }

    return new Promise(function (resolve, reject) {
      const logo = new Image();
      let finished = false;
      let logoTimer = null;
      function finish(withLogo) {
        if (finished) return;
        finished = true;
        window.clearTimeout(logoTimer);
        try {
          if (withLogo) context.drawImage(logo, 96, 92, 118, 118);
          resolve(drawContent());
        } catch (error) {
          reject(new Error('产品介绍配图生成失败。'));
        }
      }
      logo.onload = function () {
        finish(true);
      };
      logo.onerror = function () { finish(false); };
      logoTimer = window.setTimeout(function () { finish(false); }, 3000);
      logo.src = './assets/brand/logo-mark.png';
    });
  }

  async function publishPromotionNote() {
    const button = $('#publish-note');
    const status = $('#publish-note-status');
    const miniTool = window.xhs && window.xhs.miniTool;
    if (!miniTool || typeof miniTool.postNote !== 'function') {
      status.textContent = '当前环境不支持发布笔记，请在小红书小工具容器中打开。';
      showToast('当前环境暂不支持发布笔记。');
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = '正在准备产品介绍配图…';
    try {
      const image = await createPromotionImage();
      const result = await miniTool.postNote({
        title: '钱去哪里了？记下来就知道了',
        content: '把每天的收支记下来，看看钱都花在了哪里。用「钱去哪里了」记录日常收入和支出，按月份与分类查看统计，也可以设置预算和存钱目标。不用绑定银行卡，从今天的第一笔开始，慢慢养成记账习惯。',
        pageType: 'photo_publish',
        mediaInfo: { image_resources: [{ url: image }] }
      });
      if (!result || result.errMsg !== 'postNote:ok') throw new Error(result && result.errMsg || '小红书没有确认已打开笔记编辑器。');
      status.textContent = '你已在小红书发布页点击发布。笔记的最终发布状态和审核结果，请在小红书查看。';
      showToast('发布操作已提交，请在小红书查看笔记状态。');
    } catch (error) {
      const detail = error && (error.errMsg || error.message);
      status.textContent = '发布流程未完成，或已由你取消。' + (detail ? ' 提示：' + detail : ' 如果你没有取消，请检查小红书容器后重试。');
      showToast('发布流程未完成或已取消。');
    } finally {
      button.disabled = false;
    }
  }

  async function initializeRewardFeature() {
    const card = $('#reward-card');
    if (document.documentElement.getAttribute('data-xhs-reward-enabled') !== 'true') return;

    const xhs = window.xhs;
    const miniTool = xhs && xhs.miniTool;
    if (!miniTool || typeof miniTool.rewardAuthor !== 'function') return;

    let launchOptions = xhs.launchOptions || null;
    let buildVersion = LedgerStorage.getBuildVersion(launchOptions && launchOptions.miniToolEnv && launchOptions.miniToolEnv.buildVersion);
    if (buildVersion === null && typeof miniTool.getLaunchOptions === 'function') {
      try {
        launchOptions = await miniTool.getLaunchOptions();
        buildVersion = LedgerStorage.getBuildVersion(launchOptions && launchOptions.miniToolEnv && launchOptions.miniToolEnv.buildVersion);
      } catch (error) {
        return;
      }
    }

    if (buildVersion === null || Math.floor(buildVersion / 1000) < 9533) return;
    card.hidden = false;
  }

  async function requestAuthorReward() {
    const button = $('#reward-author');
    const status = $('#reward-status');
    const miniTool = window.xhs && window.xhs.miniTool;
    if (!miniTool || typeof miniTool.rewardAuthor !== 'function') {
      status.textContent = '当前环境暂不支持赞赏，请在小红书 9.53.3 及以上客户端使用。';
      return;
    }
    if (button.disabled) return;

    button.disabled = true;
    status.textContent = '正在打开小红书赞赏流程…';
    try {
      const result = await miniTool.rewardAuthor();
      if (!result || result.errMsg !== 'rewardAuthor:ok') throw new Error(result && result.errMsg || '小红书未确认赞赏流程已打开。');
      status.textContent = '赞赏流程已返回。本工具不会收到赞赏金额或支付状态，请以小红书客户端显示为准。';
      showToast('赞赏流程已返回，请以小红书客户端显示为准。');
    } catch (error) {
      const detail = error && (error.errMsg || error.message);
      status.textContent = '赞赏流程未完成，或已由你取消。' + (detail ? ' 提示：' + detail : ' 如果你没有取消，请稍后重试。');
      showToast('赞赏流程未完成或已取消。');
    } finally {
      button.disabled = false;
    }
  }

  function bindEvents() {
    $$('[data-page]').forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        navigate(button.dataset.page);
      });
    });
    $$('[data-month-step]').forEach(function (button) {
      button.addEventListener('click', function () { state.currentMonth = shiftMonth(state.currentMonth, Number(button.dataset.monthStep)); render(); });
    });
    $$('[data-open-entry]').forEach(function (button) { button.addEventListener('click', function () { openEntry('expense'); }); });
    $$('[data-open-bills]').forEach(function (card) {
      function openBills() {
        state.filter = card.dataset.openBills;
        state.page = 'record';
        $$('[data-filter]').forEach(function (button) { button.classList.toggle('active', button.dataset.filter === state.filter); });
        render();
      }
      card.addEventListener('click', openBills);
      card.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBills(); } });
    });
    $$('[data-close-dialog]').forEach(function (button) { button.addEventListener('click', function () { closeDialog(button.closest('dialog')); }); });
    $$('[data-entry-type]').forEach(function (button) { button.addEventListener('click', function () { setEntryType(button.dataset.entryType); }); });
    $('#entry-form').addEventListener('submit', handleEntrySubmit);
    $('#budget-form').addEventListener('submit', saveBudgetForm);
    $('#category-budget-form').addEventListener('submit', saveCategoryBudget);
    $('#goal-form').addEventListener('submit', addGoal);
    $('#all-bills').addEventListener('click', function (event) {
      const button = event.target.closest('[data-bill-id]');
      if (button) showBillDetail(button.dataset.billId);
    });
    $('#home-bills').addEventListener('click', function (event) {
      const button = event.target.closest('[data-bill-id]');
      if (button) showBillDetail(button.dataset.billId);
    });
    $('#bill-edit').addEventListener('click', function () {
      const bill = state.bills.find(function (item) { return item.id === state.selectedBillId; });
      closeDialog($('#bill-dialog'));
      if (bill) openEntry(bill.type, bill);
    });
    $('#bill-delete').addEventListener('click', async function () {
      const bill = state.bills.find(function (item) { return item.id === state.selectedBillId; });
      if (!bill || !window.confirm('删除这笔账单吗？删除后无法撤销。')) return;
      try { await store.deleteBill(bill.id); await syncFromStore(); render(); closeDialog($('#bill-dialog')); showToast('账单已删除。'); }
      catch (error) { setStatus(error.message, true); showToast(error.message); }
    });
    $$('[data-filter]').forEach(function (button) { button.addEventListener('click', function () { state.filter = button.dataset.filter; $$('[data-filter]').forEach(function (item) { item.classList.toggle('active', item === button); }); renderRecord(); }); });
    $('#category-budget-list').addEventListener('click', function (event) { const button = event.target.closest('[data-remove-budget]'); if (button) removeCategoryBudget(button.dataset.removeBudget); });
    $('#goals-list').addEventListener('click', function (event) {
      const add = event.target.closest('[data-goal-add]');
      const del = event.target.closest('[data-goal-delete]');
      if (add) saveGoalContribution(add.dataset.goalAdd);
      if (del) {
        const goal = state.goals.find(function (item) { return item.id === del.dataset.goalDelete; });
        if (goal && window.confirm('删除存钱目标「' + goal.name + '」吗？')) store.saveGoal(goal, true).then(syncFromStore).then(render).catch(function (error) { setStatus(error.message, true); });
      }
    });
    $('#export-json').addEventListener('click', exportJSON);
    $('#export-csv').addEventListener('click', exportCSV);
    $('#restore-json').addEventListener('click', restoreJSON);
    $('#clear-ledger').addEventListener('click', clearLedger);
    $('#voice-start').addEventListener('click', startVoice);
    $('#publish-note').addEventListener('click', publishPromotionNote);
    $('#reward-author').addEventListener('click', requestAuthorReward);
    $('#voice-parse').addEventListener('click', parseVoice);
    $('#voice-fill').addEventListener('click', function () {
      const draft = state.voiceDraft;
      if (!draft) return;
      openEntry(draft.type || 'expense', {
        type: draft.type || 'expense', amount: draft.amount || 0, category: draft.category || (draft.type === 'income' ? '其他' : '其他'),
        date: draft.date || Core.todayISO(), note: draft.note || '', source: 'voice', originalText: draft.originalText
      }, 'voice', draft.originalText);
      if (!draft.amount) $('#entry-form').elements.amount.value = '';
    });
    $('#voice-cancel').addEventListener('click', function () { state.voiceDraft = null; $('#voice-result').hidden = true; $('#voice-text').value = ''; showToast('语音草稿已取消，未保存。'); });
  }

  async function boot() {
    bindEvents();
    initializeRewardFeature();
    updateCategoryOptions('expense', '餐饮');
    render();
    try {
      await store.initialize();
      await syncFromStore();
      setStatus('账单保存在小红书小工具本地，不会上传。', false);
    } catch (error) {
      state.loadError = error;
      setStatus(error.message + ' 浏览器预览不提供持久化。', true);
      $('#storage-usage').textContent = '当前环境尚未确认可用的本地存储';
    }
    render();
  }

  boot();
}());
