You are a senior full-stack engineer. Build a cloud-based Restaurant Management System (RMS) whose core is a fast, reliable Point of Sale (POS), surrounded by modules for menu, inventory, online orders, reporting, and customers. It must work for a single outlet first, but the data model must support multi-outlet chains from day one. Prioritize billing speed and offline resilience — a cashier should be able to punch an order and print a bill in ~3 clicks, even if the internet drops.
Suggested stack (change if you like)

* Frontend: React + TypeScript, Tailwind, a component lib (shadcn/ui). PWA-capable for offline billing.
* Backend: Node.js (NestJS or Express) + REST/GraphQL API.
* DB: PostgreSQL (transactional data) + Redis (sessions, live order queue).
* Realtime: WebSockets (order/KDS updates).
* Auth: JWT + role-based access control.
* Print: ESC/POS thermal-printer support (bill + KOT).

Core Modules
1. POS / Billing (highest priority)

* Table & floor management: define areas (AC, non-AC, garden), tables per area, live status (free / running / billed / reserved). Visual floor plan.
* Order types: Dine-in, Takeaway, Delivery.
* Fast order entry: search/tap menu items, quantity, variations (half/full, size), add-ons/modifiers, item-level notes ("no onion").
* KOT (Kitchen Order Ticket): auto-generate and route KOTs to the correct kitchen/section printer or KDS. Support KOT edits, cancellations (with reason), and reprints.
* Billing actions: apply discounts (% or flat, item or bill level), coupons, service charge, and taxes (GST: CGST/SGST split, configurable slabs per item).
* Split & merge: split a bill by item or by amount; merge tables; transfer items between tables.
* Payments: multiple modes (cash, card, UPI, wallet), part payments, and settlement on a single screen. Round-off handling.
* Bill output: print/preview thermal receipt; email/SMS bill option.
* Offline mode: queue orders and bills locally, sync to server when connection returns; no lost transactions.

2. Menu Management

* Categories → items → variations → add-on groups.
* Per-item: price(s), tax slab, food type (veg/non-veg/egg), packaging charge, availability toggle, stock-out toggle.
* Time-based menus (breakfast/lunch), outlet-specific pricing, and separate online menu pricing.
* Bulk import/export (CSV).

3. Inventory & Recipe Management

* Raw material master with units and reorder levels.
* Recipe mapping: link menu items to raw-material quantities so stock auto-deducts on each sale.
* Low-stock alerts, wastage/spoilage entry, stock transfers between outlets.
* Day-end inventory report and variance (expected vs. actual).

4. Purchase Management

* Vendor master, purchase orders, goods-received notes, purchase bills.
* Auto-update inventory on receipt; track vendor-wise spend and payables.

5. Online Order Aggregation

* Unified screen to receive and manage orders from delivery aggregators (e.g., Swiggy, Zomato) and the restaurant's own online channel.
* Accept/reject, mark food-ready, track rider/pickup, and reconcile payouts.
* Menu sync so online and in-store menus stay consistent.
* Design the integration layer as pluggable adapters (each aggregator behind a common interface) so real APIs can be added later; ship with a mock adapter for development.

6. Reports & Analytics

* Real-time dashboard: today's sales, order count, average order value, top items.
* Reports: day-end sales, item-wise, category-wise, time-slot-wise, order-type, payment-mode, tax summary, discount summary, cancelled/void orders, staff performance, inventory consumption.
* Date-range filters, outlet filter, CSV/PDF export.

7. CRM & Loyalty

* Customer profiles auto-created from phone number at billing; order history and spend.
* Loyalty points / wallet, feedback capture, and basic SMS/WhatsApp campaign triggers (behind a pluggable messaging adapter + mock).

8. Add-on surfaces (build after core is stable)

* Kitchen Display System (KDS): live ticket board for kitchen; bump/recall tickets; per-station views; prep timers.
* Captain Ordering App: waiter takes orders tableside on a phone/tablet; pushes straight to KOT/POS.
* Scan & Order (QR): customer scans a table QR, browses menu, orders, and optionally pays; order lands in POS.

9. Admin, Users & Settings

* Roles: Owner, Manager, Cashier, Captain, Kitchen — each with granular permissions (e.g., cashier can't give discounts above X%, can't void without manager PIN).
* Outlet settings: taxes, charges, printers, receipt template, business hours.
* Audit log of sensitive actions (voids, discounts, price changes, refunds).

Data Model (starter entities)
`Outlet`, `User`/`Role`/`Permission`, `Table`/`Area`, `MenuCategory`, `MenuItem`, `Variation`, `AddonGroup`/`Addon`, `TaxSlab`, `RawMaterial`, `Recipe`/`RecipeItem`, `Vendor`, `PurchaseOrder`, `Order`, `OrderItem`, `KOT`, `Bill`, `Payment`, `Discount`, `Customer`, `LoyaltyTransaction`, `OnlineOrder`, `StockMovement`, `AuditLog`.
Every business record carries an `outlet_id` (and optionally `brand_id`) for multi-outlet scaling.
Non-functional requirements

* Billing screen interactions must feel instant (optimistic UI, keyboard shortcuts).
* Offline-first for the POS terminal; conflict-free sync on reconnect.
* Money handled in integer minor units; never floats. Rounding rules configurable.
* Tax logic isolated and unit-tested (GST inclusive/exclusive, item vs. bill level).
* Concurrency-safe: two waiters editing the same table must not corrupt an order.
* Seed data + a demo mode so the app is explorable without setup.

Build order (phased)

1. Phase 1 — POS core: outlets, users/roles, menu, table management, order entry, KOT, billing, payments, thermal print, offline sync.
2. Phase 2 — Back office: inventory + recipes + auto-deduct, purchase, reports/analytics dashboard.
3. Phase 3 — Growth: online-order aggregation (mock adapters), CRM + loyalty, KDS.
4. Phase 4 — Extras: captain app, scan-&-order QR, campaigns, multi-outlet consolidation reports.

Deliverables

* Runnable monorepo (frontend + backend + DB migrations + seed script).
* README with setup, env vars, and demo login.
* API docs (OpenAPI/Swagger).
* Basic test coverage on tax, billing, and inventory-deduction logic.

Start with Phase 1 only. Scaffold the repo, set up the schema and migrations, then build the POS billing flow end-to-end (menu → table → order → KOT → bill → payment → print) before moving on. Ask me before assuming any aggregator or payment-gateway credentials.
# RMS — Restaurant Management System (Phase 1: POS core)

Cloud-based RMS whose core is a fast, **offline-first Point of Sale**. Phase 1 ships the complete billing
flow — menu → table → order → KOT → bill → payment → thermal print — with multi-outlet data model,
role-based access, manager-PIN overrides, audit log and an idempotent offline sync engine.

```
rms/
├─ apps/api        NestJS 11 + Drizzle ORM + PostgreSQL  (REST + Socket.IO, Swagger at /api/docs)
├─ apps/pos        React 19 + TypeScript + Tailwind v4 PWA (Vite, Dexie/IndexedDB offline mirror)
├─ packages/shared money / GST / billing engine, ESC-POS builder, receipt + KOT templates, RBAC map
└─ docker-compose.yml   optional Postgres + Redis (embedded Postgres is the default, no Docker needed)
```

## Quick start (no Docker required)

```bash
npm run setup      # installs deps, creates apps/api/.env, boots embedded PostgreSQL, migrates, seeds demo data
npm run dev        # API on http://localhost:4000  •  POS on http://localhost:5173
```

> First run downloads a PostgreSQL 17 binary (~30 MB) into `apps/api/.pgdata` via `embedded-postgres`.
> Prefer your own Postgres / Docker? `docker compose up -d`, then set `DB_EMBEDDED=false` and
> `DATABASE_URL=postgresql://rms:rms@localhost:5432/rms` in `apps/api/.env`.

Open the POS, click **Cashier** on the login screen, tap a table, tap items, press **F8** (KOT) or **F10** (Pay).

### Demo logins

| Role     | Username  | Password     | PIN  | Notes                                                   |
|----------|-----------|--------------|------|---------------------------------------------------------|
| Owner    | `owner`   | `owner123`   | 1234 | everything                                              |
| Manager  | `manager` | `manager123` | 1111 | everything except user management; PIN approves overrides |
| Cashier  | `cashier` | `cashier123` | —    | billing; discounts capped at 10%; can't void sent items |
| Captain  | `captain` | `captain123` | —    | order entry + KOT only                                  |
| Kitchen  | `kitchen` | `kitchen123` | —    | KDS view (Phase 3)                                      |

Demo outlet **"Demo Cafe Goa"** — 3 areas / 18 tables, 7 categories (incl. a time-boxed Breakfast menu),
variations (Half/Full), add-on groups, 3 kitchen stations (KITCHEN / TANDOOR / BAR), 4 GST slabs.

## Scripts

| Command                | What it does                                                                  |
|------------------------|-------------------------------------------------------------------------------|
| `npm run setup`        | one-shot install + env + migrate + seed                                       |
| `npm run dev`          | API (watch) + POS (Vite HMR) together                                         |
| `npm run dev:api` / `dev:pos` | run one side                                                            |
| `npm run build`        | production build of shared, API (`apps/api/dist`) and POS (`apps/pos/dist`)   |
| `npm test`             | unit tests: tax/billing engine (vitest) + server billing pipeline (jest)       |
| `npm run smoke`        | end-to-end HTTP smoke test against a running API (48 assertions, see below)   |
| `npm run db:migrate`   | apply SQL migrations in `apps/api/drizzle/`                                   |
| `npm run db:seed`      | seed demo outlet (idempotent)                                                 |
| `npm run db:reset`     | drop everything, migrate, seed                                                |
| `npm run db:start`     | just hold the embedded Postgres up (e.g. for `psql` / Drizzle Studio)         |
| `npm run db:generate -w @rms/api` | generate a new migration after editing `src/db/schema.ts`          |

## Environment (`apps/api/.env`)

| Var              | Default                                        | Meaning                                                    |
|------------------|------------------------------------------------|------------------------------------------------------------|
| `DB_EMBEDDED`    | `true`                                         | boot embedded PostgreSQL in `apps/api/.pgdata`             |
| `DATABASE_URL`   | `postgresql://postgres:postgres@localhost:5433/rms` | connection string (port 5433 avoids clashing with a local PG) |
| `REDIS_URL`      | *(empty)*                                      | optional; Phase 1 uses an in-process event bus             |
| `JWT_SECRET`     | change-me                                      | **change in production**                                   |
| `JWT_EXPIRES_IN` | `12h`                                          | POS session length                                         |
| `PORT`           | `4000`                                         |                                                            |
| `CORS_ORIGIN`    | `http://localhost:5173`                        | comma-separated                                            |
| `PRINT_DRY_RUN`  | `true`                                         | `false` → send ESC/POS to the network printers in Settings |

POS: optional `VITE_API_URL` (defaults to same-origin; the Vite dev server proxies `/api` and `/ws`).

## How the POS works

**3 clicks to a bill.** Tap table → tap items → **F10 / Pay** (bill is generated, KOT auto-sent, receipt printed).
Shortcuts: `F2` or `/` search, `Enter` adds the first match (short codes like `PT`, `BN`, `MC`),
`F8` KOT, `F9` bill, `F10` settle, `Esc` back.

**Offline-first.** Every mutation is (1) applied to the IndexedDB mirror, (2) appended to an op queue,
(3) flushed to `POST /api/sync/push`. Online this completes in the same tick so the cashier sees the server's
invoice number; offline the queue waits and the cashier keeps working with the cached menu, floor and
provisional numbers (`L-3` orders, `OFF-<device>-7` bills). Ops carry client UUIDs and are recorded in
`sync_ops`, so retries after a dropped request never double-apply. Rejected ops (e.g. table was taken by
another terminal) are surfaced on the **Sync** page with retry/discard. Socket.IO pushes other terminals'
changes live; local unsynced edits are never clobbered.

**Concurrency.** Order rows carry a `version`; mutations lock the row (`SELECT … FOR UPDATE`) and clients
may pass `expectedVersion` → `409 VERSION_CONFLICT`. Two waiters on one table cannot corrupt an order.

**Money & tax.** Integer paise everywhere, percentages in basis points. `packages/shared/src/billing.ts`
is a pure function: item discounts → bill discount (largest-remainder allocation across lines) → per-line
GST (CGST/SGST rounded independently, inclusive or exclusive) → service charge (optionally taxed) →
configurable round-off. Same code runs on the server (authoritative) and in the POS (instant preview /
offline bills). 21 unit tests cover it.

**Permissions.** Roles are bundles of granular permissions (`packages/shared/src/types.ts`). Sensitive
actions (void a sent item, discount above the cashier cap, cancel an order with sent items, void/refund a
bill) return `403 OVERRIDE_REQUIRED`; the POS prompts for a manager PIN, gets a 5-minute override token
(`POST /api/auth/override`) and retries with `X-Override-Token`. Everything sensitive lands in `audit_logs`
with who/what/why.

**Printing.** `@rms/shared` builds raw ESC/POS for bills and KOTs (42/48-col). The server routes each
ticket to the outlet printer for its station (BILL / KITCHEN / TANDOOR / BAR…) over TCP 9100; with
`PRINT_DRY_RUN=true` it returns the bytes + a text preview instead. The POS always shows the preview and
offers browser printing (80 mm print CSS) as a fallback; KOTs generated offline are queued and pushed to the
network printer on reconnect.

## API

Swagger UI: **http://localhost:4000/api/docs** (OpenAPI JSON at `/api/docs-json`). Main resources:

```
POST /api/auth/login  /auth/override  GET /auth/me
GET  /api/outlets/me  PATCH /outlets/me/settings  GET/POST/DELETE /outlets/me/printers
GET  /api/menu  POST /menu/items  PATCH /menu/items/:id/flags  POST /menu/categories|addon-groups|tax-slabs  GET /menu/export.csv  POST /menu/import
GET  /api/floor  POST /floor/areas  POST /floor/tables  POST /floor/tables/:id/reserve
POST /api/orders  GET /orders  GET /orders/:id  POST /orders/:id/items  PATCH /orders/:id/items/:itemId
POST /api/orders/:id/items/:itemId/void  /orders/:id/kot  /orders/:id/discount  /orders/:id/cancel
POST /api/orders/:id/transfer  /orders/:id/merge-into/:targetId  /orders/:id/split
GET  /api/orders/:id/bill/preview  POST /orders/:id/bill  GET /bills  GET /bills/:id  GET /bills/:id/receipt
POST /api/bills/:id/payments  /bills/:id/print  /bills/:id/void  /bills/:id/send
GET  /api/kots  POST /kots/:id/status  /kots/:id/reprint
POST /api/sync/push  GET /sync/bootstrap
GET  /api/customers?q=  GET /customers/by-phone/:phone  POST /customers
GET  /api/reports/summary  GET /audit
WS   /ws  (Socket.IO, auth: { token })  → 'event' { type: order.updated | table.updated | kot.created | bill.paid | menu.updated … }
```

## Tests

```bash
npm test          # 25 shared engine tests + 4 server pipeline tests
npm run smoke     # with `npm run dev:api` running: login → menu → order → 409 conflict → KOT → PIN override
                  # → discount cap → bill → split payment → offline sync replay → transfer/merge/cancel → audit
```

## Data model

Every business table carries `outlet_id` (outlets carry `brand_id`) so a chain is a query filter, not a
migration. Entities: `brands, outlets, users, areas, tables, tax_slabs, menu_categories, menu_items,
variations, addon_groups, addons, item_addon_groups, customers, orders, order_items, kots, bills, payments,
printers, counters (atomic order/KOT/bill sequences), sync_ops (idempotency ledger), audit_logs`.
Schema: `apps/api/src/db/schema.ts`; migration SQL: `apps/api/drizzle/0000_init.sql`.

## Roadmap

- **Phase 2 — Back office:** raw materials, recipes + auto-deduct on sale, wastage, stock transfers,
  vendors / PO / GRN / purchase bills, full reports (item, category, time-slot, payment mode, tax, discount,
  void, staff, consumption) with date range, outlet filter, CSV/PDF export.
- **Phase 3 — Growth:** aggregator adapters (Swiggy / Zomato behind a common interface, mock adapter first),
  own online channel, CRM + loyalty wallet, campaigns via messaging adapter, Kitchen Display System.
- **Phase 4 — Extras:** captain tablet app, QR scan-&-order, multi-outlet consolidated reports.

## Why Drizzle instead of Prisma

Prisma's CLI needs to download platform engine binaries at install time, which fails in locked-down networks
(and did in the environment this was built in). Drizzle is pure TypeScript — plain SQL migrations, no
binaries — and keeps the schema in code with typed queries. Swapping back to Prisma later only touches
`apps/api/src/db/*` and the service query calls.
