const STORAGE_KEY = "splitbill.pwa.state.v1";
const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v2";
const EPSILON = 0.005;
const HISTORY_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const CURRENCIES = [
  "CNY",
  "USD",
  "EUR",
  "GBP",
  "DKK",
  "SEK",
  "NOK",
  "ISK",
  "CZK",
  "HUF",
  "PLN",
  "RON",
  "HKD",
  "JPY",
  "SGD",
  "AUD",
  "CAD",
  "CHF",
  "KRW",
  "THB",
  "MYR"
];

const DEFAULT_STATE = {
  settings: {
    bookName: "旅行账本",
    baseCurrency: "CNY",
    settlementCurrency: "CNY",
    settlementCurrencies: {}
  },
  people: [],
  expenses: [],
  rateCache: {},
  manualRates: {},
  history: []
};

const $ = (selector) => document.querySelector(selector);
const todayISO = () => new Date().toISOString().slice(0, 10);
const formatMoney = (value, currency) =>
  `${currency} ${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
const formatRate = (value) => Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
const makeId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

let state = loadState();
let deferredInstallPrompt = null;
let editingExpenseId = null;
let expenseRateTimer = null;
let lastExpenseRateRequest = "";

function loadState() {
  try {
    if (typeof localStorage === "undefined") return clone(DEFAULT_STATE);
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULT_STATE);
    return normalizeState(JSON.parse(raw));
  } catch {
    return clone(DEFAULT_STATE);
  }
}

function normalizeState(input) {
  const next = clone(DEFAULT_STATE);
  const merged = {
    ...next,
    ...input,
    settings: { ...next.settings, ...(input?.settings || {}) },
    people: Array.isArray(input?.people) ? input.people : next.people,
    expenses: Array.isArray(input?.expenses) ? input.expenses : [],
    history: Array.isArray(input?.history) ? input.history : [],
    rateCache: input?.rateCache && typeof input.rateCache === "object" ? input.rateCache : {},
    manualRates: input?.manualRates && typeof input.manualRates === "object" ? input.manualRates : {}
  };

  if (!CURRENCIES.includes(merged.settings.baseCurrency)) merged.settings.baseCurrency = "CNY";
  if (!CURRENCIES.includes(merged.settings.settlementCurrency)) merged.settings.settlementCurrency = merged.settings.baseCurrency;
  if (!merged.settings.settlementCurrencies || typeof merged.settings.settlementCurrencies !== "object") {
    merged.settings.settlementCurrencies = {};
  }
  if (isLegacyDefaultPeopleOnly(merged)) {
    merged.people = [];
    merged.settings.settlementCurrencies = {};
  }
  merged.expenses = merged.expenses.map((expense) => ({
    ...expense,
    rateOverride: expense.rateOverride || null,
    rateDate: expense.rateDate || expense.date
  }));
  merged.history = pruneHistory(merged.history.map(normalizeHistoryEntry));
  return merged;
}

function normalizeHistoryEntry(entry) {
  return {
    id: entry.id || makeId("history"),
    bookName: entry.bookName || "历史账单",
    archivedAt: entry.archivedAt || new Date().toISOString(),
    expiresAt: entry.expiresAt || new Date(Date.now() + HISTORY_RETENTION_DAYS * DAY_MS).toISOString(),
    baseCurrency: CURRENCIES.includes(entry.baseCurrency) ? entry.baseCurrency : "CNY",
    total: Number(entry.total || 0),
    people: Array.isArray(entry.people) ? entry.people : [],
    expenses: Array.isArray(entry.expenses) ? entry.expenses : [],
    balances: entry.balances && typeof entry.balances === "object" ? entry.balances : {},
    transfers: Array.isArray(entry.transfers) ? entry.transfers : [],
    missingRates: Array.isArray(entry.missingRates) ? entry.missingRates : []
  };
}

function pruneHistory(history) {
  const now = Date.now();
  return history.filter((entry) => new Date(entry.expiresAt).getTime() > now);
}

function isLegacyDefaultPeopleOnly(currentState) {
  if (currentState.expenses.length > 0) return false;
  if (currentState.people.length !== 2) return false;
  const ids = currentState.people.map((person) => person.id).sort();
  return ids[0] === "person-alice" && ids[1] === "person-bob";
}

function saveState() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function rateKey(date, from, to) {
  return `${date}|${from}|${to}`;
}

function getManualRate(date, from, to) {
  if (from === to) return { rate: 1, date, source: "same" };
  const direct = state.manualRates[rateKey(date, from, to)];
  if (direct) return { ...direct, source: "manual" };
  const inverse = state.manualRates[rateKey(date, to, from)];
  if (inverse?.rate) return { rate: 1 / inverse.rate, date: inverse.date || date, source: "manual" };
  return null;
}

function getCachedRate(date, from, to) {
  return getCachedRateFromState(state, date, from, to);
}

function getCachedRateFromState(currentState, date, from, to) {
  if (from === to) return { rate: 1, date, source: "same" };
  const manual = getManualRateFromState(currentState, date, from, to);
  if (manual) return manual;
  const cached = currentState.rateCache[rateKey(date, from, to)];
  if (cached) return { ...cached, source: cached.source || "auto" };
  const inverse = currentState.rateCache[rateKey(date, to, from)];
  if (inverse?.rate) return { rate: 1 / inverse.rate, date: inverse.date || date, source: inverse.source || "auto" };
  return null;
}

function getExpenseRateFromState(currentState, expense) {
  if (expense.currency === currentState.settings.baseCurrency) {
    return { rate: 1, date: expense.date, source: "same" };
  }
  if (expense.rateOverride && Number(expense.rateOverride.rate) > 0) {
    return {
      rate: Number(expense.rateOverride.rate),
      date: expense.rateOverride.date || expense.date,
      source: expense.rateOverride.source || "manual"
    };
  }
  return getCachedRateFromState(currentState, expense.date, expense.currency, currentState.settings.baseCurrency);
}

function getManualRateFromState(currentState, date, from, to) {
  if (from === to) return { rate: 1, date, source: "same" };
  const direct = currentState.manualRates[rateKey(date, from, to)];
  if (direct) return { ...direct, source: "manual" };
  const inverse = currentState.manualRates[rateKey(date, to, from)];
  if (inverse?.rate) return { rate: 1 / inverse.rate, date: inverse.date || date, source: "manual" };
  return null;
}

async function fetchRate(date, from, to) {
  if (from === to) return { rate: 1, date, source: "same" };
  const manual = getManualRate(date, from, to);
  if (manual) return manual;

  const key = rateKey(date, from, to);
  if (state.rateCache[key]) return { ...state.rateCache[key], source: "auto" };

  const data = await fetchRateDataWithFallback(date, from, to);
  const rate = Number(data.rate ?? data.rates?.[to]);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("汇率数据不可用");

  const entry = { rate, date: data.date || date, source: "auto" };
  state.rateCache[key] = entry;
  saveState();
  return entry;
}

async function fetchRateDataWithFallback(date, from, to) {
  if (date === "latest") return requestRateData("latest", from, to);

  let cursor = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime())) throw new Error("日期不可用");

  let lastError = null;
  for (let offset = 0; offset <= 10; offset += 1) {
    const candidate = cursor.toISOString().slice(0, 10);
    try {
      return await requestRateData(candidate, from, to);
    } catch (error) {
      lastError = error;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }
  throw lastError || new Error("汇率获取失败");
}

async function requestRateData(date, from, to) {
  const pair = `${encodeURIComponent(from)}/${encodeURIComponent(to)}`;
  const query = date === "latest" ? "" : `?date=${encodeURIComponent(date)}`;
  const url = `${FRANKFURTER_BASE_URL}/rate/${pair}${query}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("汇率获取失败");
  return response.json();
}

function convertWithCache(amount, date, from, to) {
  return convertWithCacheFromState(state, amount, date, from, to);
}

function convertWithCacheFromState(currentState, amount, date, from, to) {
  if (from === to) return { value: amount, rate: { rate: 1, date, source: "same" }, missing: false };
  const rate = getCachedRateFromState(currentState, date, from, to);
  if (!rate) return { value: 0, rate: null, missing: true };
  return { value: amount * rate.rate, rate, missing: false };
}

function convertExpenseAmount(currentState, expense) {
  const amount = Number(expense.amount);
  if (expense.currency === currentState.settings.baseCurrency) {
    return { value: amount, rate: { rate: 1, date: expense.date, source: "same" }, missing: false };
  }
  const rate = getExpenseRateFromState(currentState, expense);
  if (!rate) return { value: 0, rate: null, missing: true };
  return { value: amount * rate.rate, rate, missing: false };
}

function calculateBalances(currentState = state) {
  const balances = Object.fromEntries(currentState.people.map((person) => [person.id, 0]));
  const missingRates = [];
  let total = 0;

  currentState.expenses.forEach((expense) => {
    const converted = convertExpenseAmount(currentState, expense);

    if (converted.missing) {
      missingRates.push({ date: expense.date, from: expense.currency, to: currentState.settings.baseCurrency });
      return;
    }

    total += converted.value;
    balances[expense.payerId] = (balances[expense.payerId] || 0) + converted.value;

    const splits = expense.splits.filter((split) => split.included && Number(split.weight) > 0);
    const weightTotal = splits.reduce((sum, split) => sum + Number(split.weight), 0);
    if (weightTotal <= 0) return;

    splits.forEach((split) => {
      const share = converted.value * (Number(split.weight) / weightTotal);
      balances[split.personId] = (balances[split.personId] || 0) - share;
    });
  });

  return {
    balances,
    total,
    missingRates: dedupeRateRequests(missingRates)
  };
}

function buildTransfers(balances) {
  const debtors = [];
  const creditors = [];

  Object.entries(balances).forEach(([personId, amount]) => {
    if (amount < -EPSILON) debtors.push({ personId, amount: -amount });
    if (amount > EPSILON) creditors.push({ personId, amount });
  });

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > EPSILON) {
      transfers.push({ from: debtor.personId, to: creditor.personId, amount });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount <= EPSILON) debtorIndex += 1;
    if (creditor.amount <= EPSILON) creditorIndex += 1;
  }

  return transfers;
}

function dedupeRateRequests(requests) {
  const seen = new Set();
  return requests.filter((request) => {
    const key = rateKey(request.date, request.from, request.to);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function ensureRequiredRates(extraRequests = []) {
  const requests = [];
  state.expenses.forEach((expense) => {
    requests.push({ date: expense.date, from: expense.currency, to: state.settings.baseCurrency });
  });
  extraRequests.forEach((request) => requests.push(request));

  const unique = dedupeRateRequests(requests).filter((request) => !getCachedRate(request.date, request.from, request.to));
  const failures = [];

  await Promise.all(
    unique.map(async (request) => {
      try {
        await fetchRate(request.date, request.from, request.to);
      } catch {
        failures.push(request);
      }
    })
  );

  return failures;
}

async function ensureExpenseRate(date, from, to) {
  if (from === to) return { rate: 1, date, source: "same" };
  return fetchRate(date, from, to);
}

async function ensureSettlementRates(transfers) {
  const settleDate = $("#settleDate")?.value || todayISO();
  const requests = transfers.map((transfer) => ({
    date: settleDate,
    from: state.settings.baseCurrency,
    to: settlementCurrencyForPerson(transfer.from)
  }));
  return ensureRequiredRates(requests);
}

function personName(id) {
  return state.people.find((person) => person.id === id)?.name || "未知成员";
}

function renderCurrencyOptions(select, selected) {
  select.innerHTML = CURRENCIES.map((currency) => {
    const isSelected = currency === selected ? "selected" : "";
    return `<option value="${currency}" ${isSelected}>${currency}</option>`;
  }).join("");
}

function renderPeopleOptions() {
  const payerSelect = $("#payerSelect");
  payerSelect.innerHTML = state.people.length
    ? state.people.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")
    : `<option value="">请先添加成员</option>`;
}

function renderSplitList(existingSplits = null) {
  const container = $("#splitList");
  container.innerHTML = "";

  if (state.people.length === 0) {
    container.appendChild(emptyNode());
    return;
  }

  state.people.forEach((person) => {
    const split = existingSplits?.find((item) => item.personId === person.id);
    const included = split ? split.included : true;
    const weight = split ? split.weight : 1;
    const item = document.createElement("div");
    item.className = "split-item";
    const checkboxId = `split-${person.id}`;
    item.innerHTML = `
      <input id="${checkboxId}" type="checkbox" data-split-person="${person.id}" ${included ? "checked" : ""}>
      <label for="${checkboxId}">${escapeHtml(person.name)}</label>
      <input type="number" data-split-weight="${person.id}" min="0" step="0.1" value="${weight}" inputmode="decimal" aria-label="${escapeHtml(person.name)} 分摊权重">
    `;
    container.appendChild(item);
  });
}

function renderExpenseRatePanel(expense = null) {
  const date = $("#expenseDate").value || todayISO();
  const amount = Number($("#expenseAmount").value || 0);
  const currency = $("#expenseCurrency").value || state.settings.baseCurrency;
  const baseCurrency = state.settings.baseCurrency;
  const rateInput = $("#expenseRateInput");
  const convertedInput = $("#expenseConvertedAmount");
  const rateLabel = $("#expenseRateLabel");
  const status = $("#expenseRateStatus");
  const message = $("#expenseRateMessage");

  rateLabel.textContent = `1 ${currency} =`;
  convertedInput.value = formatMoney(0, baseCurrency);

  if (currency === baseCurrency) {
    rateInput.value = "1";
    rateInput.disabled = true;
    status.textContent = "无需换算";
    message.textContent = `消费币种和账本记账货币都是 ${baseCurrency}。`;
    convertedInput.value = formatMoney(amount, baseCurrency);
    return;
  }

  rateInput.disabled = false;
  const formRate = Number(rateInput.value);
  const rate =
    Number.isFinite(formRate) && formRate > 0
      ? { rate: formRate, date, source: "manual" }
      : expense
        ? getExpenseRateFromState(state, expense)
        : getCachedRate(date, currency, baseCurrency);

  if (rate?.rate) {
    if (!rateInput.value || expense?.rateOverride?.rate) rateInput.value = formatRate(rate.rate);
    convertedInput.value = Number.isFinite(amount) ? formatMoney(amount * rate.rate, baseCurrency) : formatMoney(0, baseCurrency);
    status.textContent = rate.source === "manual" ? "手动汇率" : "已获取汇率";
    message.textContent = `实际汇率日 ${rate.date} · 1 ${currency} = ${formatRate(rate.rate)} ${baseCurrency}`;
  } else {
    status.textContent = "等待自动获取";
    message.textContent = "输入或修改金额后会自动获取；抓取不到时请在这里手动输入。";
  }
}

function getExpenseFormDraft() {
  const date = $("#expenseDate").value || todayISO();
  const currency = $("#expenseCurrency").value || state.settings.baseCurrency;
  return {
    id: editingExpenseId || "draft",
    date,
    title: $("#expenseTitle").value.trim() || "未命名消费",
    amount: Number($("#expenseAmount").value || 0),
    currency,
    payerId: $("#payerSelect").value,
    splits: collectSplits(),
    rateOverride: currentExpenseRateOverride(date, currency)
  };
}

function currentExpenseRateOverride(date, currency) {
  if (currency === state.settings.baseCurrency) return null;
  const rate = Number($("#expenseRateInput").value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const cached = getCachedRate(date, currency, state.settings.baseCurrency);
  const source = cached && Math.abs(cached.rate - rate) < 0.0000001 ? cached.source : "manual";
  return { rate, date: cached?.date || date, source };
}

function resetExpenseForm() {
  editingExpenseId = null;
  $("#expenseFormEyebrow").textContent = "新增消费";
  $("#expenseFormTitle").textContent = "记一笔";
  $("#saveExpenseButton").textContent = "保存消费";
  $("#cancelEditButton").hidden = true;
  $("#expenseDate").value = todayISO();
  $("#expenseTitle").value = "";
  $("#expenseAmount").value = "";
  $("#expenseCurrency").value = state.settings.baseCurrency;
  renderPeopleOptions();
  renderSplitList();
  $("#expenseRateInput").value = "";
  renderExpenseRatePanel();
}

function loadExpenseIntoForm(expenseId) {
  const expense = state.expenses.find((item) => item.id === expenseId);
  if (!expense) return;
  editingExpenseId = expenseId;
  $("#expenseFormEyebrow").textContent = "历史消费";
  $("#expenseFormTitle").textContent = "编辑消费";
  $("#saveExpenseButton").textContent = "保存修改";
  $("#cancelEditButton").hidden = false;
  $("#expenseDate").value = expense.date;
  $("#expenseTitle").value = expense.title;
  $("#expenseAmount").value = expense.amount;
  $("#expenseCurrency").value = expense.currency;
  renderPeopleOptions();
  $("#payerSelect").value = expense.payerId;
  renderSplitList(expense.splits);
  $("#expenseRateInput").value = expense.rateOverride?.rate ? formatRate(expense.rateOverride.rate) : "";
  renderExpenseRatePanel(expense);
  activateView("expenseView");
}

function renderMembers() {
  const list = $("#memberList");
  list.innerHTML = "";

  if (state.people.length === 0) {
    list.appendChild(emptyNode());
    return;
  }

  state.people.forEach((person) => {
    const used = state.expenses.some((expense) =>
      expense.payerId === person.id || expense.splits.some((split) => split.personId === person.id)
    );
    const item = document.createElement("div");
    item.className = "member-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(person.name)}</strong>
        <span>${used ? "已有消费记录，不能删除" : "可删除"}</span>
      </div>
      <button class="text-button" type="button" data-delete-person="${person.id}" ${used ? "disabled" : ""}>删除</button>
    `;
    list.appendChild(item);
  });
}

function renderExpenseList() {
  const list = $("#expenseList");
  list.innerHTML = "";

  if (state.expenses.length === 0) {
    list.appendChild(emptyNode());
    return;
  }

  [...state.expenses].sort((a, b) => b.date.localeCompare(a.date)).forEach((expense) => {
    const splits = expense.splits.filter((split) => split.included && Number(split.weight) > 0);
    const splitNames = splits.map((split) => `${personName(split.personId)}:${split.weight}`).join(" / ");
    const converted = convertExpenseAmount(state, expense);
    const item = document.createElement("div");
    item.className = "expense-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(expense.title)}</strong>
        <span>${expense.date} · ${personName(expense.payerId)} 付款 · 分摊 ${escapeHtml(splitNames || "无")}</span>
        <span>${converted.missing ? "缺少汇率" : `折合 ${formatMoney(converted.value, state.settings.baseCurrency)} · 汇率日 ${converted.rate.date}`}</span>
      </div>
      <div class="item-actions">
        <div class="amount-pill">${formatMoney(expense.amount, expense.currency)}</div>
        <button class="secondary-button small-button" type="button" data-edit-expense="${expense.id}">编辑</button>
        <button class="text-button" type="button" data-delete-expense="${expense.id}">删除</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderSettlement() {
  const result = calculateBalances();
  const balances = result.balances;
  const transfers = buildTransfers(balances);
  const balanceList = $("#balanceList");
  const transferList = $("#transferList");
  const settlementCurrencyList = $("#settlementCurrencyList");
  balanceList.innerHTML = "";
  transferList.innerHTML = "";
  if (settlementCurrencyList) settlementCurrencyList.innerHTML = "";

  state.people.forEach((person) => {
    const amount = balances[person.id] || 0;
    const item = document.createElement("div");
    item.className = "balance-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(person.name)}</strong>
        <span>${amount >= 0 ? "应收" : "应付"}</span>
      </div>
      <div class="amount-pill ${amount >= 0 ? "positive" : "negative"}">${formatMoney(Math.abs(amount), state.settings.baseCurrency)}</div>
    `;
    balanceList.appendChild(item);
  });

  if (result.missingRates.length > 0) {
    const missing = document.createElement("div");
    missing.className = "empty-state";
    missing.innerHTML = `
      <strong>缺少消费汇率</strong>
      <span>${escapeHtml(result.missingRates.map((rate) => `${rate.date} ${rate.from}→${rate.to}`).join("，"))}</span>
    `;
    transferList.appendChild(missing);
    return;
  }

  if (transfers.length === 0) {
    const done = emptyNode();
    done.querySelector("strong").textContent = "已经平账";
    done.querySelector("span").textContent = "当前没有需要转账的金额。";
    transferList.appendChild(done);
    return;
  }

  renderSettlementCurrencyList(transfers);

  transfers.forEach((transfer) => {
    const settleDate = $("#settleDate").value || todayISO();
    const transferCurrency = settlementCurrencyForPerson(transfer.from);
    const settlementRate = getCachedRate(settleDate, state.settings.baseCurrency, transferCurrency);
    const converted = convertWithCache(transfer.amount, settleDate, state.settings.baseCurrency, transferCurrency);
    const item = document.createElement("div");
    item.className = "transfer-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${personName(transfer.from)} → ${personName(transfer.to)}</strong>
        <span>基准金额 ${formatMoney(transfer.amount, state.settings.baseCurrency)}</span>
        <span>${converted.missing ? "缺少结算日汇率，请点重新计算或更换付款币种" : `转账币汇率日 ${settlementRate?.date || settleDate}`}</span>
      </div>
      <div class="amount-pill">${converted.missing ? "待补汇率" : formatMoney(converted.value, transferCurrency)}</div>
    `;
    transferList.appendChild(item);
  });
}

function renderSettlementCurrencyList(transfers = buildTransfers(calculateBalances().balances)) {
  const container = $("#settlementCurrencyList");
  if (!container) return;
  container.innerHTML = "";

  const debtorIds = [...new Set(transfers.map((transfer) => transfer.from))];
  if (debtorIds.length === 0) {
    const empty = emptyNode();
    empty.querySelector("strong").textContent = "暂无付款人";
    empty.querySelector("span").textContent = "有需要转账的人时，这里会显示每个人的付款币种。";
    container.appendChild(empty);
    return;
  }

  const settleDate = $("#settleDate").value || todayISO();
  debtorIds.forEach((personId) => {
    const currency = settlementCurrencyForPerson(personId);
    const rate = getCachedRate(settleDate, state.settings.baseCurrency, currency);
    const item = document.createElement("div");
    item.className = "settlement-rate-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${personName(personId)}</strong>
        <span>${currency === state.settings.baseCurrency ? "使用账本记账货币" : rate ? `汇率日 ${rate.date} · 1 ${state.settings.baseCurrency} = ${formatRate(rate.rate)} ${currency}` : "缺少结算汇率，点重新计算或改币种"}</span>
      </div>
      <select data-settlement-currency="${personId}" aria-label="${escapeHtml(personName(personId))} 付款币种"></select>
    `;
    const select = item.querySelector("select");
    renderCurrencyOptions(select, currency);
    container.appendChild(item);
  });
}

function settlementCurrencyForPerson(personId) {
  return state.settings.settlementCurrencies?.[personId] || state.settings.settlementCurrency || state.settings.baseCurrency;
}

function buildHistoryEntry(currentState = state, archivedAt = new Date()) {
  const result = calculateBalances(currentState);
  const transfers = result.missingRates.length ? [] : buildTransfers(result.balances);
  return {
    id: makeId("history"),
    bookName: currentState.settings.bookName || "历史账单",
    archivedAt: archivedAt.toISOString(),
    expiresAt: new Date(archivedAt.getTime() + HISTORY_RETENTION_DAYS * DAY_MS).toISOString(),
    baseCurrency: currentState.settings.baseCurrency,
    total: result.total,
    people: clone(currentState.people),
    expenses: clone(currentState.expenses),
    balances: clone(result.balances),
    transfers: clone(transfers),
    missingRates: clone(result.missingRates)
  };
}

function shouldArchiveCurrentBook() {
  return state.people.length > 0 || state.expenses.length > 0;
}

function archiveCurrentBook() {
  if (!shouldArchiveCurrentBook()) return null;
  const entry = buildHistoryEntry(state);
  state.history = pruneHistory([entry, ...(state.history || [])]);
  return entry;
}

function renderSummary() {
  const result = calculateBalances();
  $("#bookName").textContent = state.settings.bookName;
  $("#peopleCount").textContent = String(state.people.length);
  $("#expenseCount").textContent = String(state.expenses.length);
  $("#totalAmount").textContent = formatMoney(result.total, state.settings.baseCurrency);
}

function renderAll() {
  $("#settingsBookName").value = state.settings.bookName;
  renderCurrencyOptions($("#baseCurrencySelect"), state.settings.baseCurrency);
  const currentExpenseCurrency = $("#expenseCurrency").value || state.settings.baseCurrency;
  renderCurrencyOptions($("#expenseCurrency"), currentExpenseCurrency);
  renderPeopleOptions();
  if (!editingExpenseId) renderSplitList();
  renderMembers();
  renderExpenseList();
  renderSettlement();
  renderHistoryList();
  renderSummary();
  $("#expenseForm .primary-button").disabled = state.people.length === 0;
  renderExpenseRatePanel(editingExpenseId ? state.expenses.find((expense) => expense.id === editingExpenseId) : null);
}

function renderHistoryList() {
  const list = $("#historyList");
  if (!list) return;
  state.history = pruneHistory(state.history || []);
  list.innerHTML = "";

  if (state.history.length === 0) {
    const empty = emptyNode();
    empty.querySelector("strong").textContent = "暂无历史账单";
    empty.querySelector("span").textContent = "点击“账已平，初始化账本”后会自动归档。";
    list.appendChild(empty);
    return;
  }

  state.history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(entry.bookName)}</strong>
        <span>${formatDateTime(entry.archivedAt)} · ${entry.people.length} 人 · ${entry.expenses.length} 笔消费</span>
        <span>总额 ${formatMoney(entry.total, entry.baseCurrency)} · ${daysUntil(entry.expiresAt)} 天后自动删除</span>
      </div>
      <div class="item-actions">
        <button class="secondary-button small-button" type="button" data-open-history="${entry.id}">查看</button>
        <button class="text-button" type="button" data-delete-history="${entry.id}">删除</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderHistoryDetail(entryId) {
  const entry = state.history.find((item) => item.id === entryId);
  const panel = $("#historyDetailPanel");
  const detail = $("#historyDetail");
  if (!entry || !panel || !detail) return;

  $("#historyDetailTitle").textContent = entry.bookName;
  detail.innerHTML = "";
  panel.hidden = false;

  const summary = document.createElement("div");
  summary.className = "history-summary";
  summary.innerHTML = `
    <div><span>归档时间</span><strong>${formatDateTime(entry.archivedAt)}</strong></div>
    <div><span>参与人</span><strong>${entry.people.length}</strong></div>
    <div><span>消费笔数</span><strong>${entry.expenses.length}</strong></div>
    <div><span>总额</span><strong>${formatMoney(entry.total, entry.baseCurrency)}</strong></div>
  `;
  detail.appendChild(summary);

  const expenses = document.createElement("div");
  expenses.className = "history-section";
  expenses.innerHTML = `<h4>消费摘要</h4>`;
  if (entry.expenses.length === 0) {
    expenses.appendChild(historyMutedLine("无消费明细"));
  } else {
    entry.expenses.slice(0, 8).forEach((expense) => {
      expenses.appendChild(historyLine(
        expense.title,
        `${expense.date} · ${historyPersonName(entry, expense.payerId)} 付款 · ${formatMoney(expense.amount, expense.currency)}`
      ));
    });
    if (entry.expenses.length > 8) {
      expenses.appendChild(historyMutedLine(`还有 ${entry.expenses.length - 8} 笔未展开显示`));
    }
  }
  detail.appendChild(expenses);

  const balances = document.createElement("div");
  balances.className = "history-section";
  balances.innerHTML = `<h4>净额摘要</h4>`;
  entry.people.forEach((person) => {
    const amount = Number(entry.balances[person.id] || 0);
    balances.appendChild(historyLine(person.name, `${amount >= 0 ? "应收" : "应付"} ${formatMoney(Math.abs(amount), entry.baseCurrency)}`));
  });
  detail.appendChild(balances);

  const transfers = document.createElement("div");
  transfers.className = "history-section";
  transfers.innerHTML = `<h4>平账方式</h4>`;
  if (entry.missingRates.length > 0) {
    transfers.appendChild(historyMutedLine("归档时仍有缺少汇率的消费，未生成完整平账方案。"));
  } else if (entry.transfers.length === 0) {
    transfers.appendChild(historyMutedLine("归档时已经平账，无需转账。"));
  } else {
    entry.transfers.forEach((transfer) => {
      transfers.appendChild(historyLine(
        `${historyPersonName(entry, transfer.from)} → ${historyPersonName(entry, transfer.to)}`,
        formatMoney(transfer.amount, entry.baseCurrency)
      ));
    });
  }
  detail.appendChild(transfers);
}

function historyLine(title, body) {
  const row = document.createElement("div");
  row.className = "history-line";
  row.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
  return row;
}

function historyMutedLine(body) {
  const row = document.createElement("p");
  row.className = "muted-line";
  row.textContent = body;
  return row;
}

function historyPersonName(entry, id) {
  return entry.people.find((person) => person.id === id)?.name || "未知成员";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function daysUntil(value) {
  const diff = new Date(value).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / DAY_MS));
}

function emptyNode() {
  return $("#emptyTemplate").content.firstElementChild.cloneNode(true);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function collectSplits() {
  return state.people.map((person) => {
    const included = document.querySelector(`[data-split-person="${person.id}"]`)?.checked || false;
    const weight = Number(document.querySelector(`[data-split-weight="${person.id}"]`)?.value || 0);
    return { personId: person.id, included, weight: Number.isFinite(weight) ? weight : 0 };
  });
}

function showMessage(elementId, message) {
  const element = $(elementId);
  element.textContent = message;
  if (!message) return;
  window.setTimeout(() => {
    if (element.textContent === message) element.textContent = "";
  }, 3000);
}

function activateView(viewId) {
  document.querySelectorAll(".tab-button").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === viewId);
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === viewId);
  });
}

function scheduleExpenseRateFetch() {
  window.clearTimeout(expenseRateTimer);
  renderExpenseRatePanel(editingExpenseId ? state.expenses.find((expense) => expense.id === editingExpenseId) : null);
  expenseRateTimer = window.setTimeout(() => {
    fetchExpenseRateForForm();
  }, 550);
}

async function fetchExpenseRateForForm() {
  const date = $("#expenseDate").value || todayISO();
  const currency = $("#expenseCurrency").value || state.settings.baseCurrency;
  const amount = Number($("#expenseAmount").value || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    renderExpenseRatePanel();
    return;
  }

  if (currency === state.settings.baseCurrency) {
    renderExpenseRatePanel();
    return;
  }

  const requestId = `${date}|${currency}|${state.settings.baseCurrency}|${amount}`;
  lastExpenseRateRequest = requestId;
  $("#expenseRateStatus").textContent = "正在获取汇率";
  $("#expenseRateMessage").textContent = "自动获取该笔消费到记账货币的中间价。";

  try {
    const rate = await ensureExpenseRate(date, currency, state.settings.baseCurrency);
    if (lastExpenseRateRequest !== requestId) return;
    $("#expenseRateInput").value = formatRate(rate.rate);
    renderExpenseRatePanel();
  } catch {
    if (lastExpenseRateRequest !== requestId) return;
    $("#expenseRateStatus").textContent = "需要手动输入";
    $("#expenseRateMessage").textContent = `未能获取 ${date} 的 ${currency}→${state.settings.baseCurrency} 汇率，请手动输入。`;
  }
}

function resetWholeBook(options = {}) {
  const { archive = false } = options;
  const history = pruneHistory(state.history || []);
  const archived = archive ? archiveCurrentBook() : null;
  const nextHistory = archived ? state.history : history;
  state = clone(DEFAULT_STATE);
  state.history = nextHistory;
  saveState();
  resetExpenseForm();
  $("#settleDate").value = todayISO();
  renderAll();
  return archived;
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      activateView(button.dataset.view);
    });
  });

  $("#historyButton").addEventListener("click", () => {
    activateView("historyView");
    renderHistoryList();
  });

  $("#fillTodayButton").addEventListener("click", () => {
    $("#expenseDate").value = todayISO();
  });

  $("#equalSplitButton").addEventListener("click", () => {
    renderSplitList();
  });

  ["#expenseDate", "#expenseAmount", "#expenseCurrency"].forEach((selector) => {
    $(selector).addEventListener("input", scheduleExpenseRateFetch);
    $(selector).addEventListener("change", scheduleExpenseRateFetch);
  });

  $("#expenseRateInput").addEventListener("input", () => {
    renderExpenseRatePanel(editingExpenseId ? state.expenses.find((expense) => expense.id === editingExpenseId) : null);
  });

  $("#expenseRateRefreshButton").addEventListener("click", async () => {
    $("#expenseRateInput").value = "";
    await fetchExpenseRateForForm();
  });

  $("#cancelEditButton").addEventListener("click", () => {
    resetExpenseForm();
  });

  $("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.settings.bookName = $("#settingsBookName").value.trim() || "旅行账本";
    state.settings.baseCurrency = $("#baseCurrencySelect").value;
    if (!state.settings.settlementCurrency) state.settings.settlementCurrency = state.settings.baseCurrency;
    saveState();
    await refreshSettlementRateAndRender();
  });

  $("#personForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#personName").value.trim();
    if (!name) return;
    state.people.push({ id: makeId("person"), name });
    $("#personName").value = "";
    saveState();
    renderAll();
  });

  $("#resetBookButton").addEventListener("click", () => {
    const ok = window.confirm("确定清空本机账本吗？这会删除成员、消费和汇率缓存。");
    if (!ok) return;
    resetWholeBook();
  });

  $("#memberList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-person]");
    if (!button) return;
    const id = button.dataset.deletePerson;
    state.people = state.people.filter((person) => person.id !== id);
    saveState();
    renderAll();
  });

  $("#expenseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.people.length === 0) {
      showMessage("#expenseMessage", "请先添加至少一位成员。");
      return;
    }

    const splits = collectSplits();
    const selectedSplits = splits.filter((split) => split.included && split.weight > 0);
    if (selectedSplits.length === 0) {
      showMessage("#expenseMessage", "请至少选择一位分摊成员，并填写大于 0 的权重。");
      return;
    }

    const amount = Number($("#expenseAmount").value);
    if (!Number.isFinite(amount) || amount <= 0) {
      showMessage("#expenseMessage", "请输入有效金额。");
      return;
    }

    const date = $("#expenseDate").value || todayISO();
    const currency = $("#expenseCurrency").value;
    const expense = {
      id: editingExpenseId || makeId("expense"),
      date: $("#expenseDate").value || todayISO(),
      title: $("#expenseTitle").value.trim() || "未命名消费",
      amount,
      currency,
      payerId: $("#payerSelect").value,
      splits,
      rateOverride: currentExpenseRateOverride(date, currency)
    };

    const wasEditing = Boolean(editingExpenseId);
    if (wasEditing) {
      state.expenses = state.expenses.map((item) => (item.id === editingExpenseId ? expense : item));
    } else {
      state.expenses.push(expense);
    }
    saveState();
    resetExpenseForm();
    await refreshSettlementRateAndRender();
    showMessage("#expenseMessage", wasEditing ? "已更新。" : "已保存。");
  });

  $("#expenseList").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-expense]");
    if (editButton) {
      loadExpenseIntoForm(editButton.dataset.editExpense);
      return;
    }

    const button = event.target.closest("[data-delete-expense]");
    if (!button) return;
    state.expenses = state.expenses.filter((expense) => expense.id !== button.dataset.deleteExpense);
    saveState();
    renderAll();
  });

  $("#clearExpensesButton").addEventListener("click", () => {
    if (!state.expenses.length) return;
    const ok = window.confirm("确定清空所有消费吗？成员和汇率会保留。");
    if (!ok) return;
    state.expenses = [];
    saveState();
    renderAll();
  });

  $("#settleDate").addEventListener("change", async () => {
    await refreshSettlementRateAndRender();
  });

  $("#settlementCurrencyList").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-settlement-currency]");
    if (!select) return;
    const personId = select.dataset.settlementCurrency;
    state.settings.settlementCurrencies[personId] = select.value;
    state.settings.settlementCurrency = select.value;
    saveState();
    await refreshSettlementRateAndRender();
  });

  $("#recalculateButton").addEventListener("click", async () => {
    await refreshSettlementRateAndRender();
  });

  $("#closeBookButton").addEventListener("click", () => {
    const ok = window.confirm("确认所有转账都完成，并把当前账本归档为历史后初始化吗？历史账单会保留 30 天。");
    if (!ok) return;
    const archived = resetWholeBook({ archive: true });
    if (archived) {
      activateView("historyView");
      renderHistoryDetail(archived.id);
    }
  });

  $("#historyList").addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-open-history]");
    if (openButton) {
      renderHistoryDetail(openButton.dataset.openHistory);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-history]");
    if (!deleteButton) return;
    const ok = window.confirm("确定删除这条历史账单吗？");
    if (!ok) return;
    state.history = state.history.filter((entry) => entry.id !== deleteButton.dataset.deleteHistory);
    saveState();
    $("#historyDetailPanel").hidden = true;
    renderHistoryList();
  });

  $("#closeHistoryDetailButton").addEventListener("click", () => {
    $("#historyDetailPanel").hidden = true;
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installButton").hidden = false;
  });

  $("#installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installButton").hidden = true;
  });
}

async function refreshSettlementRateAndRender() {
  const result = calculateBalances();
  const transfers = result.missingRates.length ? [] : buildTransfers(result.balances);
  await ensureSettlementRates(transfers);
  renderAll();
}

async function init() {
  $("#expenseDate").value = todayISO();
  $("#settleDate").value = todayISO();
  bindEvents();
  renderAll();
  await refreshSettlementRateAndRender();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

if (typeof window !== "undefined") {
  window.SplitBillCore = {
    calculateBalances,
    buildTransfers,
    buildHistoryEntry,
    convertWithCache,
    convertWithCacheFromState,
    pruneHistory,
    rateKey
  };

  init();
}

if (typeof module !== "undefined") {
  module.exports = {
    calculateBalances,
    buildTransfers,
    buildHistoryEntry,
    convertWithCacheFromState,
    pruneHistory,
    rateKey,
    normalizeState
  };
}
