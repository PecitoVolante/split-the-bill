const assert = require("node:assert/strict");
const {
  calculateBalances,
  buildTransfers,
  buildHistoryEntry,
  buildReportText,
  normalizeState,
  pruneHistory,
  rateKey
} = require("../app.js");

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.001, `${message}: expected ${expected}, got ${actual}`);
}

const people = [
  { id: "a", name: "A" },
  { id: "b", name: "B" },
  { id: "c", name: "C" }
];

{
  const state = normalizeState({
    settings: { bookName: "Test", baseCurrency: "CNY", settlementCurrency: "CNY" },
    people: people.slice(0, 2),
    expenses: [
      {
        id: "e1",
        date: "2026-05-01",
        title: "Dinner",
        amount: 100,
        currency: "CNY",
        payerId: "a",
        splits: [
          { personId: "a", included: true, weight: 1 },
          { personId: "b", included: true, weight: 1 }
        ]
      }
    ],
    rateCache: {},
    manualRates: {}
  });

  const { balances } = calculateBalances(state);
  closeTo(balances.a, 50, "payer should receive half");
  closeTo(balances.b, -50, "other person should pay half");
}

{
  const state = normalizeState({
    settings: { bookName: "Test", baseCurrency: "CNY", settlementCurrency: "CNY" },
    people,
    expenses: [
      {
        id: "e1",
        date: "2026-05-01",
        title: "Hotel",
        amount: 400,
        currency: "CNY",
        payerId: "b",
        splits: [
          { personId: "a", included: true, weight: 2 },
          { personId: "b", included: true, weight: 1 },
          { personId: "c", included: true, weight: 1 }
        ]
      }
    ],
    rateCache: {},
    manualRates: {}
  });

  const { balances } = calculateBalances(state);
  closeTo(balances.a, -200, "weight 2 should pay 50 percent");
  closeTo(balances.b, 300, "payer should receive after own share");
  closeTo(balances.c, -100, "weight 1 should pay 25 percent");
}

{
  const state = normalizeState({
    settings: { bookName: "Test", baseCurrency: "CNY", settlementCurrency: "USD" },
    people,
    expenses: [
      {
        id: "e1",
        date: "2026-05-01",
        title: "Tickets",
        amount: 10,
        currency: "USD",
        payerId: "c",
        splits: [
          { personId: "a", included: true, weight: 1 },
          { personId: "b", included: true, weight: 1 },
          { personId: "c", included: true, weight: 1 }
        ]
      }
    ],
    rateCache: {},
    manualRates: {
      [rateKey("2026-05-01", "USD", "CNY")]: { rate: 7.2, date: "2026-05-01", source: "manual" }
    }
  });

  const { balances, missingRates } = calculateBalances(state);
  assert.equal(missingRates.length, 0);
  closeTo(balances.a, -24, "USD expense should convert to CNY");
  closeTo(balances.b, -24, "USD expense should convert to CNY");
  closeTo(balances.c, 48, "payer should receive remaining converted amount");
}

{
  const state = normalizeState({
    settings: { bookName: "Test", baseCurrency: "CNY", settlementCurrency: "USD" },
    people: people.slice(0, 2),
    expenses: [
      {
        id: "e1",
        date: "2026-05-01",
        title: "Manual rate bill",
        amount: 10,
        currency: "USD",
        payerId: "a",
        rateOverride: { rate: 7, date: "2026-05-01", source: "manual" },
        splits: [
          { personId: "a", included: true, weight: 1 },
          { personId: "b", included: true, weight: 1 }
        ]
      }
    ],
    rateCache: {
      [rateKey("2026-05-01", "USD", "CNY")]: { rate: 8, date: "2026-05-01", source: "auto" }
    },
    manualRates: {}
  });

  const { balances } = calculateBalances(state);
  closeTo(balances.a, 35, "expense-level manual rate should override cache");
  closeTo(balances.b, -35, "expense-level manual rate should override cache for shares");
}

{
  const balances = { a: -50, b: -25, c: 75 };
  const transfers = buildTransfers(balances);
  assert.deepEqual(transfers, [
    { from: "a", to: "c", amount: 50 },
    { from: "b", to: "c", amount: 25 }
  ]);
  assert.ok(transfers.length <= 2, "three-person settlement should use at most people minus one transfers");
}

{
  const archivedAt = new Date("2026-05-03T10:00:00Z");
  const state = normalizeState({
    settings: { bookName: "Archive Test", baseCurrency: "CNY", settlementCurrency: "CNY" },
    people: people.slice(0, 2),
    expenses: [
      {
        id: "e1",
        date: "2026-05-03",
        title: "Dinner",
        amount: 100,
        currency: "CNY",
        payerId: "a",
        splits: [
          { personId: "a", included: true, weight: 1 },
          { personId: "b", included: true, weight: 1 }
        ]
      }
    ],
    rateCache: {},
    manualRates: {},
    history: []
  });

  const entry = buildHistoryEntry(state, archivedAt);
  assert.equal(entry.bookName, "Archive Test");
  assert.equal(entry.expenses.length, 1);
  assert.equal(entry.people.length, 2);
  closeTo(entry.total, 100, "history should capture total");
  closeTo(entry.balances.a, 50, "history should capture payer balance");
  closeTo(entry.balances.b, -50, "history should capture debtor balance");
  assert.deepEqual(entry.transfers, [{ from: "b", to: "a", amount: 50 }]);
  assert.equal(entry.expiresAt, "2026-06-02T10:00:00.000Z");
}

{
  const history = [
    { id: "old", expiresAt: "2026-05-02T00:00:00.000Z" },
    { id: "fresh", expiresAt: "2099-05-02T00:00:00.000Z" }
  ].map((entry) => ({ ...entry, archivedAt: "2026-05-01T00:00:00.000Z" }));
  const pruned = pruneHistory(history);
  assert.deepEqual(pruned.map((entry) => entry.id), ["fresh"]);
}

{
  const text = buildReportText({
    type: "history",
    title: "Export Test",
    label: "历史账单",
    generatedAt: "2026-05-03T10:00:00Z",
    baseCurrency: "CNY",
    total: 100,
    people: people.slice(0, 2),
    expenses: [
      {
        id: "e1",
        date: "2026-05-03",
        title: "Dinner",
        amount: 100,
        currency: "CNY",
        payerId: "a",
        splits: [
          { personId: "a", included: true, weight: 1 },
          { personId: "b", included: true, weight: 1 }
        ]
      }
    ],
    balances: { a: 50, b: -50 },
    transfers: [
      { from: "b", to: "a", amount: 50, currency: "CNY", settlementAmount: 50, settlementMissing: false }
    ],
    missingRates: []
  });

  assert.match(text, /【总览】/);
  assert.match(text, /Dinner/);
  assert.match(text, /B → A：CNY 50.00/);
}

console.log("core tests passed");
