(function (root) {
  'use strict';

  const PREFIX = 'wwl:v2:';
  const ACTIVE_KEY = PREFIX + 'active';
  const MAX_BILLS_PER_SHARD = 100;
  const MAX_KEY_BYTES = 900 * 1024;

  function failure(message, code) {
    const error = new Error(message);
    error.code = code || 'STORAGE_ERROR';
    return error;
  }

  function parseJSON(text, label) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw failure(label + ' 数据损坏；已保留原数据，请先导出或联系支持。', 'CORRUPT_DATA');
    }
  }

  function byteLength(text) {
    return new Blob([text]).size;
  }

  function getBuildVersion(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d{6,}$/.test(String(value))) return null;
    const version = Number(value);
    return Number.isSafeInteger(version) ? version : null;
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function createStorage(xhs, core) {
    let miniTool = null;
    let revision = '';
    let manifest = null;
    let bills = [];
    let budgets = [];
    let goals = [];
    let locations = {};
    let statusInfo = null;
    let ready = false;
    let mutationQueue = Promise.resolve();
    let cleanupWarning = '';

    function serializeMutation(action) {
      const result = mutationQueue.then(action, action);
      mutationQueue = result.then(function () {}, function () {});
      return result;
    }

    function requireResult(result, api) {
      if (!result || result.errMsg !== api + ':ok') throw failure('小红书本地存储调用失败（' + api + '），账本未确认保存。');
      return result;
    }

    async function getRaw(key) {
      let result;
      try {
        result = await miniTool.getStorage({ key, encrypt: true });
      } catch (error) {
        throw failure('读取本地账本失败；没有覆盖或清空现有数据。', 'READ_FAILED');
      }
      requireResult(result, 'getStorage');
      if (result.data === null || typeof result.data === 'undefined') return null;
      if (typeof result.data !== 'string') throw failure('本地账本格式无法识别，已停止读取。', 'CORRUPT_DATA');
      if (result.data === '') {
        // Some containers return an empty string for a missing key; confirm with the key inventory before treating it as absent.
        const info = await getInfo();
        if (info.keys.indexOf(key) < 0) return null;
      }
      return parseJSON(result.data, '账本');
    }

    async function setRaw(key, value) {
      const text = JSON.stringify(value);
      if (typeof text !== 'string' || byteLength(text) > MAX_KEY_BYTES) throw failure('单个账本分片过大，未保存；请先导出数据。', 'KEY_TOO_LARGE');
      let info = await getInfo();
      const extra = byteLength(key) + byteLength(text) + 64;
      if (info.limitBytes && info.usedBytes + extra > info.limitBytes) throw failure('小工具本地空间不足，账单未保存。请先导出备份并清理不需要的数据。', 'CAPACITY');
      let result;
      try {
        result = await miniTool.setStorage({ key, data: text, encrypt: true });
      } catch (error) {
        throw failure('写入本地账本失败；请检查空间后重试。', 'WRITE_FAILED');
      }
      requireResult(result, 'setStorage');
    }

    async function removeRaw(key) {
      let result;
      try {
        result = await miniTool.removeStorage({ key });
      } catch (error) {
        throw failure('清理旧账本分片失败；原有数据仍保留。', 'REMOVE_FAILED');
      }
      requireResult(result, 'removeStorage');
    }

    async function getInfo() {
      let result;
      try {
        result = await miniTool.getStorageInfo();
      } catch (error) {
        throw failure('无法读取小工具本地空间信息，暂不能安全保存。', 'INFO_FAILED');
      }
      requireResult(result, 'getStorageInfo');
      if (!Array.isArray(result.keys) || !Number.isFinite(Number(result.usedBytes)) || !Number.isFinite(Number(result.limitBytes))) {
        throw failure('小工具返回的本地空间信息无效。', 'INFO_INVALID');
      }
      statusInfo = { keys: result.keys.slice(), usedBytes: Number(result.usedBytes), limitBytes: Number(result.limitBytes) };
      return statusInfo;
    }

    function manifestKey(rev) { return PREFIX + 'manifest:' + rev; }

    function manifestReferences(value) {
      return value.billShards.map(function (item) { return item.key; })
        .concat(value.budgets.map(function (item) { return item.key; }))
        .concat(value.goals.map(function (item) { return item.key; }));
    }

    function stage(writes, type, payload) {
      const token = '@pending:' + writes.length;
      writes.push({ token, type, payload });
      return token;
    }

    function resolvePending(value, keys) {
      if (typeof value === 'string' && keys[value]) return keys[value];
      if (Array.isArray(value)) return value.map(function (item) { return resolvePending(item, keys); });
      if (value && typeof value === 'object') {
        const result = {};
        Object.keys(value).forEach(function (key) { result[key] = resolvePending(value[key], keys); });
        return result;
      }
      return value;
    }

    async function commit(nextManifest, writes, obsoleteKeys) {
      const oldRevision = revision;
      const oldManifest = manifest;
      const nextRevision = makeId();
      const keys = {};
      const stagedKeys = [];
      nextManifest.schemaVersion = core.SCHEMA_VERSION;
      nextManifest.revision = nextRevision;
      writes.forEach(function (item) {
        keys[item.token] = PREFIX + item.type + ':' + nextRevision + ':' + makeId();
      });
      const resolvedManifest = resolvePending(nextManifest, keys);
      const nextManifestKey = manifestKey(nextRevision);

      try {
        for (let i = 0; i < writes.length; i += 1) {
          const item = writes[i];
          const key = keys[item.token];
          await setRaw(key, item.payload);
          stagedKeys.push(key);
        }
        await setRaw(nextManifestKey, resolvedManifest);
        stagedKeys.push(nextManifestKey);
        try {
          await setRaw(ACTIVE_KEY, { schemaVersion: core.SCHEMA_VERSION, revision: nextRevision });
        } catch (pointerError) {
          const active = await getRaw(ACTIVE_KEY).catch(function () { return null; });
          if (!active || active.revision !== nextRevision) throw failure('保存结果未确认。请重新打开账本查看，暂不要重复提交。', 'WRITE_UNCERTAIN');
        }
      } catch (error) {
        const active = await getRaw(ACTIVE_KEY).catch(function () { return null; });
        if (!active || active.revision !== nextRevision) {
          if (error.code !== 'WRITE_UNCERTAIN') {
            const cleanupErrors = [];
            for (let i = stagedKeys.length - 1; i >= 0; i -= 1) {
              try { await removeRaw(stagedKeys[i]); } catch (cleanupError) { cleanupErrors.push(cleanupError.message); }
            }
            if (cleanupErrors.length) error.message += ' 临时分片清理失败：' + cleanupErrors.join(' ');
          }
          throw error;
        }
      }

      revision = nextRevision;
      manifest = resolvedManifest;
      const keep = manifestReferences(manifest).concat([manifestKey(revision), ACTIVE_KEY]);
      const old = (oldManifest ? manifestReferences(oldManifest).concat([manifestKey(oldRevision)]) : []).concat(obsoleteKeys || []);
      const toRemove = old.filter(function (key, index) { return keep.indexOf(key) < 0 && old.indexOf(key) === index; });
      const warnings = [];
      for (let i = 0; i < toRemove.length; i += 1) {
        try { await removeRaw(toRemove[i]); } catch (error) { warnings.push(error.message); }
      }
      cleanupWarning = warnings.join(' ');
      await loadData();
      return warnings;
    }

    async function loadData() {
      const nextBills = [];
      const nextLocations = {};
      const migratedShards = [];
      const migratedBudgets = [];
      const migratedGoals = [];
      for (let i = 0; i < manifest.billShards.length; i += 1) {
        const descriptor = manifest.billShards[i];
        const raw = await getRaw(descriptor.key);
        if (!raw || !Array.isArray(raw.bills) || raw.month !== descriptor.month) throw failure('账单分片缺失或格式异常；已保留原数据。', 'CORRUPT_DATA');
        const version = Number(raw.schemaVersion);
        if (version !== 1 && version !== core.SCHEMA_VERSION) throw failure('发现不支持的账单版本，未覆盖原数据。', 'SCHEMA_UNSUPPORTED');
        const shardBills = raw.bills.map(function (bill) { return core.migrateBill(bill, version); });
        shardBills.forEach(function (bill) {
          if (nextLocations[bill.id]) throw failure('账本中存在重复账单编号，已停止写入。', 'DUPLICATE_ID');
          nextLocations[bill.id] = descriptor.key;
          nextBills.push(bill);
        });
        if (version !== core.SCHEMA_VERSION) migratedShards.push({ descriptor, bills: shardBills });
      }
      const nextBudgets = [];
      for (let b = 0; b < manifest.budgets.length; b += 1) {
        const descriptor = manifest.budgets[b];
        const rawBudget = await getRaw(descriptor.key);
        if (!rawBudget) throw failure('预算数据缺失；已保留原数据。', 'CORRUPT_DATA');
        const version = Number(rawBudget.schemaVersion || manifest.schemaVersion);
        const budget = core.validateBudget(rawBudget, descriptor.month, version);
        nextBudgets.push(budget);
        if (version !== core.SCHEMA_VERSION) migratedBudgets.push({ descriptor, budget });
      }
      const nextGoals = [];
      for (let g = 0; g < manifest.goals.length; g += 1) {
        const rawGoal = await getRaw(manifest.goals[g].key);
        if (!rawGoal) throw failure('存钱目标数据缺失；已保留原数据。', 'CORRUPT_DATA');
        const version = Number(rawGoal.schemaVersion || manifest.schemaVersion);
        const goal = core.validateGoal(rawGoal, version);
        nextGoals.push(goal);
        if (version !== core.SCHEMA_VERSION) migratedGoals.push({ descriptor: manifest.goals[g], goal });
      }
      bills = nextBills;
      budgets = nextBudgets;
      goals = nextGoals;
      locations = nextLocations;

      if (Number(manifest.schemaVersion) !== core.SCHEMA_VERSION || migratedShards.length || migratedBudgets.length || migratedGoals.length) {
        const next = clone(manifest);
        const writes = [];
        const obsolete = [];
        migratedShards.forEach(function (item) {
          const token = stage(writes, 'bill', { schemaVersion: core.SCHEMA_VERSION, month: item.descriptor.month, bills: item.bills });
          const index = next.billShards.findIndex(function (part) { return part.key === item.descriptor.key; });
          obsolete.push(item.descriptor.key);
          next.billShards[index] = { key: token, month: item.descriptor.month, count: item.bills.length };
        });
        migratedBudgets.forEach(function (item) {
          const token = stage(writes, 'budget', item.budget);
          const index = next.budgets.findIndex(function (descriptor) { return descriptor.key === item.descriptor.key; });
          obsolete.push(item.descriptor.key);
          next.budgets[index] = { month: item.budget.month, key: token };
        });
        migratedGoals.forEach(function (item) {
          const token = stage(writes, 'goal', item.goal);
          const index = next.goals.findIndex(function (descriptor) { return descriptor.key === item.descriptor.key; });
          obsolete.push(item.descriptor.key);
          next.goals[index] = { id: item.goal.id, key: token };
        });
        await commit(next, writes, obsolete);
      }
    }

    async function initialize() {
      if (ready) return;
      if (!xhs || !xhs.miniTool) throw failure('请在支持 Storage 的小红书小工具环境中使用；当前环境不会把账单写入浏览器存储。', 'ENV_UNSUPPORTED');
      miniTool = xhs.miniTool;
      let launch = xhs.launchOptions || null;
      let build = getBuildVersion(launch && launch.miniToolEnv && launch.miniToolEnv.buildVersion);
      if (build === null && typeof miniTool.getLaunchOptions === 'function') {
        try {
          launch = await miniTool.getLaunchOptions();
          build = getBuildVersion(launch && launch.miniToolEnv && launch.miniToolEnv.buildVersion);
        } catch (error) {
          throw failure('无法确认小红书客户端版本，未启用账本写入。', 'VERSION_UNKNOWN');
        }
      }
      if (build === null) throw failure('无法确认小红书客户端版本，未启用账本写入。', 'VERSION_UNKNOWN');
      if (Math.floor(build / 1000) < 9460) throw failure('本地 Storage 需要小红书客户端 9.46.0 或更新版本。', 'VERSION_OLD');
      ['getStorage', 'setStorage', 'removeStorage', 'getStorageInfo'].forEach(function (name) {
        if (typeof miniTool[name] !== 'function') throw failure('当前小红书客户端缺少 ' + name + '，账本不会改用浏览器存储。', 'METHOD_MISSING');
      });

      const active = await getRaw(ACTIVE_KEY);
      if (!active) {
        const info = await getInfo();
        const existing = info.keys.filter(function (key) { return key.indexOf(PREFIX) === 0; });
        if (existing.length) throw failure('发现未完成或旧版本账本数据，已停止初始化以防覆盖。', 'ORPHANED_DATA');
        const initialRevision = makeId();
        const initialManifest = { schemaVersion: core.SCHEMA_VERSION, revision: initialRevision, billShards: [], budgets: [], goals: [] };
        try {
          await setRaw(manifestKey(initialRevision), initialManifest);
        } catch (error) {
          let activeAfterFailure;
          try { activeAfterFailure = await getRaw(ACTIVE_KEY); } catch (readError) { throw failure(error.message + ' 当前状态无法确认，请重新打开账本检查。', 'INIT_UNCERTAIN'); }
          if (!activeAfterFailure) {
            try { await removeRaw(manifestKey(initialRevision)); } catch (cleanupError) { error.message += ' 初始化临时索引清理失败，请重新打开后重试。'; }
          }
          throw error;
        }
        try {
          await setRaw(ACTIVE_KEY, { schemaVersion: core.SCHEMA_VERSION, revision: initialRevision });
        } catch (error) {
          let activeAfterFailure;
          try { activeAfterFailure = await getRaw(ACTIVE_KEY); } catch (readError) { throw failure('初始化结果无法确认。请重新打开后检查账本；未开始记录数据。', 'INIT_UNCERTAIN'); }
          if (activeAfterFailure && activeAfterFailure.revision === initialRevision) {
            revision = initialRevision;
            manifest = initialManifest;
            await loadData();
            ready = true;
            return;
          }
          if (!activeAfterFailure) {
            try { await removeRaw(manifestKey(initialRevision)); } catch (cleanupError) { throw failure('初始化失败，且临时索引未能清理。请重新打开后重试。', 'INIT_CLEANUP_FAILED'); }
          }
          throw failure('初始化本地账本未完成。请重新打开后重试；未开始记录数据。', 'INIT_UNCERTAIN');
        }
        revision = initialRevision;
        manifest = initialManifest;
      } else {
        if (Number(active.schemaVersion) !== 1 && Number(active.schemaVersion) !== core.SCHEMA_VERSION) throw failure('账本索引版本不支持，未覆盖原数据。', 'SCHEMA_UNSUPPORTED');
        revision = String(active.revision || '');
        if (!revision) throw failure('账本索引缺少版本标识，已保留数据。', 'CORRUPT_DATA');
        manifest = await getRaw(manifestKey(revision));
        if (!manifest || !Array.isArray(manifest.billShards) || !Array.isArray(manifest.budgets) || !Array.isArray(manifest.goals)) {
          throw failure('账本索引损坏，已停止写入以保护现有数据。', 'CORRUPT_DATA');
        }
        if (Number(manifest.schemaVersion) !== 1 && Number(manifest.schemaVersion) !== core.SCHEMA_VERSION) throw failure('账本索引版本不支持，未覆盖原数据。', 'SCHEMA_UNSUPPORTED');
      }
      await loadData();
      ready = true;
    }

    function snapshot() {
      return { bills: bills.slice(), budgets: budgets.slice(), goals: goals.slice() };
    }

    async function saveBillNow(input, originalId) {
      await initialize();
      const now = Date.now();
      const prior = originalId ? bills.find(function (bill) { return bill.id === originalId; }) : null;
      const targetMonth = core.monthOf(input.date);
      const bill = core.validateBill(Object.assign({}, input, {
        id: prior ? prior.id : input.id || 'bill_' + makeId(),
        createdAt: prior ? prior.createdAt : now,
        updatedAt: now,
        schemaVersion: core.SCHEMA_VERSION
      }));
      const next = clone(manifest);
      const writes = [];
      const obsolete = [];
      let targetShard = null;

      if (prior) {
        const sourceKey = locations[prior.id];
        const sourceIndex = next.billShards.findIndex(function (item) { return item.key === sourceKey; });
        if (sourceIndex < 0) throw failure('找不到要修改的账单分片；请重新打开账本。', 'BILL_NOT_FOUND');
        const sourceRaw = await getRaw(sourceKey);
        if (!sourceRaw || !Array.isArray(sourceRaw.bills)) throw failure('账单分片损坏，未修改原数据。', 'CORRUPT_DATA');
        const sourceBills = sourceRaw.bills.filter(function (item) { return item.id !== prior.id; });
        obsolete.push(sourceKey);
        if (sourceRaw.month === targetMonth && sourceBills.length) {
          targetShard = { month: sourceRaw.month, bills: sourceBills, descriptorIndex: sourceIndex };
        } else if (sourceBills.length) {
          const token = stage(writes, 'bill', { schemaVersion: core.SCHEMA_VERSION, month: sourceRaw.month, bills: sourceBills });
          next.billShards[sourceIndex] = { key: token, month: sourceRaw.month, count: sourceBills.length };
        } else {
          next.billShards.splice(sourceIndex, 1);
        }
      }

      if (!targetShard || targetShard.month !== targetMonth) {
        const candidates = next.billShards.map(function (descriptor, index) { return { descriptor, index }; }).filter(function (row) {
          return row.descriptor.month === targetMonth && row.descriptor.count < MAX_BILLS_PER_SHARD;
        });
        const last = candidates[candidates.length - 1];
        if (last) {
          const rawShard = await getRaw(last.descriptor.key);
          if (!rawShard || !Array.isArray(rawShard.bills)) throw failure('账单分片损坏，未保存新账单。', 'CORRUPT_DATA');
          targetShard = { month: targetMonth, bills: rawShard.bills, descriptorIndex: last.index, oldKey: last.descriptor.key };
        } else targetShard = { month: targetMonth, bills: [], descriptorIndex: -1, oldKey: '' };
      }
      targetShard.bills = targetShard.bills.filter(function (item) { return item.id !== bill.id; });
      targetShard.bills.push(bill);
      const token = stage(writes, 'bill', { schemaVersion: core.SCHEMA_VERSION, month: targetMonth, bills: targetShard.bills });
      if (targetShard.descriptorIndex >= 0) {
        const previous = next.billShards[targetShard.descriptorIndex];
        if (previous && previous.key.indexOf('@pending:') !== 0) obsolete.push(previous.key);
        next.billShards[targetShard.descriptorIndex] = { key: token, month: targetMonth, count: targetShard.bills.length };
      } else next.billShards.push({ key: token, month: targetMonth, count: targetShard.bills.length });
      await commit(next, writes, obsolete);
      return bill;
    }

    function saveBill(input, originalId) {
      return serializeMutation(function () { return saveBillNow(input, originalId); });
    }

    async function deleteBillNow(id) {
      await initialize();
      const key = locations[id];
      if (!key) throw failure('找不到这笔账单，请刷新后重试。', 'BILL_NOT_FOUND');
      const raw = await getRaw(key);
      if (!raw || !Array.isArray(raw.bills)) throw failure('账单分片损坏，未删除数据。', 'CORRUPT_DATA');
      const remaining = raw.bills.filter(function (bill) { return bill.id !== id; });
      const next = clone(manifest);
      const index = next.billShards.findIndex(function (item) { return item.key === key; });
      if (index < 0) throw failure('找不到账单索引，未删除数据。', 'CORRUPT_DATA');
      const writes = [];
      if (remaining.length) {
        const token = stage(writes, 'bill', { schemaVersion: core.SCHEMA_VERSION, month: raw.month, bills: remaining });
        next.billShards[index] = { key: token, month: raw.month, count: remaining.length };
      } else next.billShards.splice(index, 1);
      await commit(next, writes, [key]);
    }

    function deleteBill(id) {
      return serializeMutation(function () { return deleteBillNow(id); });
    }

    async function saveBudgetNow(input) {
      await initialize();
      const budget = core.validateBudget(input, input.month);
      const next = clone(manifest);
      const index = next.budgets.findIndex(function (item) { return item.month === budget.month; });
      const oldKey = index >= 0 ? next.budgets[index].key : '';
      const token = stage([], 'budget', budget);
      const writes = [{ token, type: 'budget', payload: budget }];
      if (index >= 0) next.budgets[index] = { month: budget.month, key: token };
      else next.budgets.push({ month: budget.month, key: token });
      await commit(next, writes, oldKey ? [oldKey] : []);
    }

    function saveBudget(input) {
      return serializeMutation(function () { return saveBudgetNow(input); });
    }

    async function saveGoalNow(input, remove) {
      await initialize();
      const goal = core.validateGoal(input);
      const next = clone(manifest);
      const index = next.goals.findIndex(function (item) { return item.id === goal.id; });
      if (remove) {
        if (index < 0) return;
        const oldKey = next.goals[index].key;
        next.goals.splice(index, 1);
        await commit(next, [], [oldKey]);
        return;
      }
      const oldKey = index >= 0 ? next.goals[index].key : '';
      const writes = [];
      const token = stage(writes, 'goal', goal);
      if (index >= 0) next.goals[index] = { id: goal.id, key: token };
      else next.goals.push({ id: goal.id, key: token });
      await commit(next, writes, oldKey ? [oldKey] : []);
    }

    function saveGoal(input, remove) {
      return serializeMutation(function () { return saveGoalNow(input, remove); });
    }

    async function replaceAllNow(input) {
      await initialize();
      const data = core.validateBackup(input);
      const next = { schemaVersion: core.SCHEMA_VERSION, revision: '', billShards: [], budgets: [], goals: [] };
      const writes = [];
      const byMonth = {};
      data.bills.forEach(function (bill) {
        const month = core.monthOf(bill.date);
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push(bill);
      });
      Object.keys(byMonth).sort().forEach(function (month) {
        const rows = byMonth[month];
        for (let i = 0; i < rows.length; i += MAX_BILLS_PER_SHARD) {
          const shard = rows.slice(i, i + MAX_BILLS_PER_SHARD);
          const token = stage(writes, 'bill', { schemaVersion: core.SCHEMA_VERSION, month, bills: shard });
          next.billShards.push({ key: token, month, count: shard.length });
        }
      });
      data.budgets.forEach(function (budget) {
        const token = stage(writes, 'budget', budget);
        next.budgets.push({ month: budget.month, key: token });
      });
      data.goals.forEach(function (goal) {
        const token = stage(writes, 'goal', goal);
        next.goals.push({ id: goal.id, key: token });
      });
      const old = manifestReferences(manifest);
      await commit(next, writes, old);
    }

    function replaceAll(input) {
      return serializeMutation(function () { return replaceAllNow(input); });
    }

    async function exportData() {
      await initialize();
      return { app: core.APP_ID, schemaVersion: core.SCHEMA_VERSION, exportedAt: new Date().toISOString(), bills: bills.slice(), budgets: budgets.slice(), goals: goals.slice() };
    }

    async function storageInfo() {
      await initialize();
      const info = await getInfo();
      return Object.assign({}, info, { warning: cleanupWarning });
    }

    return {
      initialize,
      snapshot,
      saveBill,
      deleteBill,
      saveBudget,
      saveGoal,
      replaceAll,
      exportData,
      storageInfo,
      get isReady() { return ready; }
    };
  }

  const api = { createStorage, getBuildVersion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LedgerStorage = api;
}(typeof window !== 'undefined' ? window : null));
