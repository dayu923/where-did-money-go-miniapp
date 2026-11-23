'use strict';

const assert = require('node:assert/strict');
const Core = require('../core.js');
const { createStorage } = require('../storage.js');

function createMock(initial) {
  const values = new Map(Object.entries(initial || {}));
  let failNextSet = false;
  const api = {
    async getStorage({ key }) {
      return { errMsg: 'getStorage:ok', data: values.has(key) ? values.get(key) : null };
    },
    async setStorage({ key, data }) {
      if (failNextSet) { failNextSet = false; throw new Error('mock write failure'); }
      values.set(key, data);
      return { errMsg: 'setStorage:ok' };
    },
    async removeStorage({ key }) {
      values.delete(key);
      return { errMsg: 'removeStorage:ok' };
    },
    async getStorageInfo() {
      let usedBytes = 0;
      values.forEach((value, key) => { usedBytes += Buffer.byteLength(key) + Buffer.byteLength(value); });
      return { errMsg: 'getStorageInfo:ok', keys: Array.from(values.keys()), usedBytes, limitBytes: 10 * 1024 * 1024 };
    }
  };
  return {
    values,
    api,
    failNextWrite() { failNextSet = true; }
  };
}

function bill(id, day) {
  return { id, type: 'expense', amount: 3500, category: '餐饮', date: '2026-11-' + String(day).padStart(2, '0'), note: '午餐', source: 'manual', createdAt: 1, updatedAt: 1, schemaVersion: Core.SCHEMA_VERSION };
}

function create(mock) {
  return createStorage({ launchOptions: { miniToolEnv: { buildVersion: 9460000 } }, miniTool: mock.api }, Core);
}

(async function () {
  const mock = createMock();
  const store = create(mock);
  await store.initialize();
  await Promise.all([store.saveBill(bill('bill_a', 1)), store.saveBill(bill('bill_b', 2)), store.saveBill(bill('bill_c', 3))]);
  assert.equal(store.snapshot().bills.length, 3, 'concurrent writes must preserve all bills');

  const reopened = create(mock);
  await reopened.initialize();
  assert.equal(reopened.snapshot().bills.length, 3, 'bills must persist across store instances');
  await reopened.saveBill(Object.assign({}, bill('bill_a', 5), { note: '编辑后' }), 'bill_a');
  assert.equal(reopened.snapshot().bills.find((row) => row.id === 'bill_a').date, '2026-11-05');
  await reopened.deleteBill('bill_b');
  assert.deepEqual(reopened.snapshot().bills.map((row) => row.id).sort(), ['bill_a', 'bill_c']);

  const manyMock = createMock();
  const many = create(manyMock);
  await many.initialize();
  const bills = Array.from({ length: 205 }, (_, index) => bill('bill_' + index, index % 28 + 1));
  await many.replaceAll({ app: Core.APP_ID, schemaVersion: Core.SCHEMA_VERSION, bills, budgets: [], goals: [] });
  assert.equal(many.snapshot().bills.length, 205, 'restore must split a large month into storage shards');
  const shards = Array.from(manyMock.values.keys()).filter((key) => key.indexOf('wwl:v2:bill:') === 0);
  assert.equal(shards.length, 3);

  const legacyMock = createMock({
    'wwl:v2:active': JSON.stringify({ schemaVersion: 1, revision: 'legacy' }),
    'wwl:v2:manifest:legacy': JSON.stringify({ schemaVersion: 1, revision: 'legacy', billShards: [{ key: 'wwl:v2:bill:legacy', month: '2026-11', count: 1 }], budgets: [{ key: 'wwl:v2:budget:legacy', month: '2026-11' }], goals: [{ key: 'wwl:v2:goal:legacy', id: 'goal_legacy' }] }),
    'wwl:v2:bill:legacy': JSON.stringify({ schemaVersion: 1, month: '2026-11', bills: [bill('old_bill', 19)] }),
    'wwl:v2:budget:legacy': JSON.stringify({ month: '2026-11', totalBudget: 50000, categoryBudgets: { 餐饮: 20000 } }),
    'wwl:v2:goal:legacy': JSON.stringify({ id: 'goal_legacy', name: '旧目标', targetAmount: 100000, savedAmount: 0 })
  });
  const migrated = create(legacyMock);
  await migrated.initialize();
  assert.equal(migrated.snapshot().bills[0].schemaVersion, Core.SCHEMA_VERSION, 'v1 data must migrate');
  assert.equal(migrated.snapshot().budgets[0].schemaVersion, Core.SCHEMA_VERSION, 'v1 budgets must migrate');
  assert.equal(migrated.snapshot().goals[0].schemaVersion, Core.SCHEMA_VERSION, 'v1 goals must migrate');
  assert.equal(JSON.parse(legacyMock.values.get('wwl:v2:active')).schemaVersion, Core.SCHEMA_VERSION);

  const errorMock = createMock();
  const errorStore = create(errorMock);
  await errorStore.initialize();
  errorMock.failNextWrite();
  await assert.rejects(errorStore.saveBill(bill('bill_fail', 8)), /写入本地账本失败|保存结果未确认/);
  assert.equal(errorStore.snapshot().bills.length, 0, 'failed write must not change the in-memory ledger');

  const initMock = createMock();
  initMock.failNextWrite();
  const initStore = create(initMock);
  await assert.rejects(initStore.initialize(), /写入本地账本失败/);
  await initStore.initialize();
  assert.equal(initStore.isReady, true, 'failed empty-ledger initialization must be retryable');

  await assert.rejects(createStorage(null, Core).initialize(), /小红书小工具环境/);
  console.log('storage checks passed');
}()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
