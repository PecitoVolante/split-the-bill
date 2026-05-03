# AGENTS.md

## Project Purpose

SplitBill is a mobile-first PWA for recording shared expenses and generating a simple settlement plan.

The app is designed for one person to manage a bill locally on their phone. Data is stored in the current browser on the current device. There is no backend, login, account system, or cross-device sync.

## Architecture

- Static frontend only: `index.html`, `styles.css`, `app.js`.
- PWA support: `manifest.webmanifest`, `service-worker.js`, `icons/icon.svg`.
- Deployment: GitHub Pages via `.github/workflows/pages.yml`.
- Storage: browser `localStorage` under `splitbill.pwa.state.v1`.
- Tests: core calculation tests in `tests/core.test.js`, run with `node tests/core.test.js`.
- No npm/pnpm dependency is required.

## Core Features

- Custom participants.
- Expense recording with date, description, amount, currency, payer, and split weights.
- Default equal split, with per-person weight adjustment.
- Expense-level exchange rate conversion into the ledger base currency.
- Automatic exchange-rate fetching through Frankfurter v2, with manual rate override when needed.
- Editable expense history for current ledger entries.
- Settlement calculation using net balances and a greedy minimum-transfer plan.
- Per-debtor settlement currency selection on the settlement screen.
- Ledger reset after settlement.
- Archive on settlement reset: current ledger is saved as a history entry before being cleared.
- Recent history view from the top-right `历` button.
- History entries include summary, expense overview, net balances, and settlement transfer summary.
- History entries are automatically pruned after 30 days and can also be manually deleted.

## Important Constraints

- All user data is local to the browser and device.
- Different browsers on the same phone do not share data.
- Other users opening the same GitHub Pages URL do not see the same ledger.
- Clearing browser site data can remove all current and archived ledger data.
- GitHub Pages deployment is public, but ledger data is not uploaded because it stays in `localStorage`.

## Development Notes

- Keep the app dependency-free unless there is a clear reason to add tooling.
- Prefer pure functions for financial calculations so they can be covered by `tests/core.test.js`.
- Be careful with destructive actions. Clear/reset actions should keep explicit confirmation.
- The `.deploy/` folder contains local deploy-key material and must remain ignored by Git.
