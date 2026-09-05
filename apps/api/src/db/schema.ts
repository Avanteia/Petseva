/**
 * Database schema (Drizzle ORM, PostgreSQL).
 * Conventions:
 *  - every business table carries outlet_id (and outlets carry brand_id) → multi-outlet from day one
 *  - all money columns are INTEGER paise; all percentages are INTEGER basis points
 *  - ids are UUIDs so the offline POS can mint them client-side and sync idempotently
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

const id = () => uuid('id').primaryKey().defaultRandom();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').defaultNow().notNull();

// ---------------------------------------------------------------- tenancy
export const brands = pgTable('brands', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const outlets = pgTable('outlets', {
  id: id(),
  brandId: uuid('brand_id').references(() => brands.id),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  addressLines: jsonb('address_lines').$type<string[]>().default([]).notNull(),
  phone: text('phone'),
  gstin: text('gstin'),
  fssai: text('fssai'),
  timezone: text('timezone').default('Asia/Kolkata').notNull(),
  /** OutletSettings from @rms/shared (tax inclusive, rounding, service charge, receipt, limits) */
  settings: jsonb('settings').$type<Record<string, unknown>>().default({}).notNull(),
  businessHours: jsonb('business_hours').$type<Record<string, unknown>>().default({}).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- users & roles
export const users = pgTable(
  'users',
  {
    id: id(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    name: text('name').notNull(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** 4–6 digit PIN hash, used for manager overrides on the POS */
    pinHash: text('pin_hash'),
    role: text('role').notNull(), // RoleName
    /** extra permissions granted / revoked beyond the role bundle */
    permissionOverrides: jsonb('permission_overrides').$type<{ grant?: string[]; revoke?: string[] }>().default({}).notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('users_username_idx').on(t.username)],
);

// ---------------------------------------------------------------- floor
export const areas = pgTable('areas', {
  id: id(),
  outletId: uuid('outlet_id')
    .references(() => outlets.id)
    .notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
});

export const tables = pgTable(
  'tables',
  {
    id: id(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    areaId: uuid('area_id')
      .references(() => areas.id)
      .notNull(),
    name: text('name').notNull(),
    capacity: integer('capacity').default(4).notNull(),
    status: text('status').default('FREE').notNull(), // TableStatus
    currentOrderId: uuid('current_order_id'),
    /** grid position for the visual floor plan */
    posX: integer('pos_x').default(0).notNull(),
    posY: integer('pos_y').default(0).notNull(),
    shape: text('shape').default('square').notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    active: boolean('active').default(true).notNull(),
  },
  (t) => [index('tables_outlet_idx').on(t.outletId)],
);

// ---------------------------------------------------------------- menu
export const taxSlabs = pgTable('tax_slabs', {
  id: id(),
  outletId: uuid('outlet_id')
    .references(() => outlets.id)
    .notNull(),
  name: text('name').notNull(),
  rateBps: integer('rate_bps').notNull(),
  active: boolean('active').default(true).notNull(),
});

export const menuCategories = pgTable('menu_categories', {
  id: id(),
  outletId: uuid('outlet_id')
    .references(() => outlets.id)
    .notNull(),
  name: text('name').notNull(),
  /** default kitchen station for KOT routing; items may override */
  station: text('station').default('KITCHEN').notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
  /** time-based menus: [{days:[1..7], from:"07:00", to:"11:00"}] – empty = always */
  availability: jsonb('availability').$type<{ days: number[]; from: string; to: string }[]>().default([]).notNull(),
});

export const menuItems = pgTable(
  'menu_items',
  {
    id: id(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    categoryId: uuid('category_id')
      .references(() => menuCategories.id)
      .notNull(),
    name: text('name').notNull(),
    shortCode: text('short_code'),
    description: text('description'),
    foodType: text('food_type').default('VEG').notNull(), // FoodType
    /** base price in paise (used when the item has no variations) */
    price: integer('price').notNull(),
    /** separate online-channel price; null = same as price */
    onlinePrice: integer('online_price'),
    taxSlabId: uuid('tax_slab_id').references(() => taxSlabs.id),
    packagingCharge: integer('packaging_charge').default(0).notNull(),
    station: text('station'),
    available: boolean('available').default(true).notNull(),
    stockOut: boolean('stock_out').default(false).notNull(),
    imageUrl: text('image_url'),
    sortOrder: integer('sort_order').default(0).notNull(),
    active: boolean('active').default(true).notNull(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
  },
  (t) => [index('menu_items_outlet_idx').on(t.outletId), index('menu_items_cat_idx').on(t.categoryId)],
);

export const variations = pgTable('variations', {
  id: id(),
  itemId: uuid('item_id')
    .references(() => menuItems.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  price: integer('price').notNull(),
  onlinePrice: integer('online_price'),
  isDefault: boolean('is_default').default(false).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
});

export const addonGroups = pgTable('addon_groups', {
  id: id(),
  outletId: uuid('outlet_id')
    .references(() => outlets.id)
    .notNull(),
  name: text('name').notNull(),
  minSelect: integer('min_select').default(0).notNull(),
  maxSelect: integer('max_select').default(10).notNull(),
  active: boolean('active').default(true).notNull(),
});

export const addons = pgTable('addons', {
  id: id(),
  groupId: uuid('group_id')
    .references(() => addonGroups.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  price: integer('price').default(0).notNull(),
  foodType: text('food_type').default('VEG').notNull(),
  active: boolean('active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
});

export const itemAddonGroups = pgTable(
  'item_addon_groups',
  {
    itemId: uuid('item_id')
      .references(() => menuItems.id, { onDelete: 'cascade' })
      .notNull(),
    groupId: uuid('group_id')
      .references(() => addonGroups.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.groupId] })],
);

// ---------------------------------------------------------------- customers
export const customers = pgTable(
  'customers',
  {
    id: id(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    phone: text('phone').notNull(),
    name: text('name'),
    email: text('email'),
    address: text('address'),
    visits: integer('visits').default(0).notNull(),
    totalSpend: integer('total_spend').default(0).notNull(),
    loyaltyPoints: integer('loyalty_points').default(0).notNull(),
    createdAt: createdAt(),
    lastVisitAt: ts('last_visit_at'),
  },
  (t) => [uniqueIndex('customers_outlet_phone_idx').on(t.outletId, t.phone)],
);

// ---------------------------------------------------------------- orders
export type AddonSnapshot = { id: string; name: string; price: number };
export type DiscountJson = { type: 'PERCENT' | 'FLAT'; value: number; reason?: string; code?: string; byUserId?: string };

export const orders = pgTable(
  'orders',
  {
    /** client-mintable UUID (offline POS) */
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    orderNumber: text('order_number').notNull(),
    type: text('type').notNull(), // OrderType
    status: text('status').default('OPEN').notNull(), // OrderStatus
    tableId: uuid('table_id').references(() => tables.id),
    tableName: text('table_name'),
    customerId: uuid('customer_id').references(() => customers.id),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    deliveryAddress: text('delivery_address'),
    covers: integer('covers').default(1).notNull(),
    notes: text('notes'),
    discount: jsonb('discount').$type<DiscountJson | null>(),
    serviceChargeBps: integer('service_charge_bps'),
    deliveryCharge: integer('delivery_charge').default(0).notNull(),
    /** optimistic concurrency token – every mutation bumps it; clients send expectedVersion */
    version: integer('version').default(1).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    deviceId: text('device_id'),
    /** when the order was created on the POS (may pre-date server insert if it was offline) */
    createdAt: createdAt(),
    updatedAt: ts('updated_at').defaultNow().notNull(),
    billedAt: ts('billed_at'),
    settledAt: ts('settled_at'),
    cancelledAt: ts('cancelled_at'),
    cancelReason: text('cancel_reason'),
    /** merged-into pointer when tables are merged */
    mergedIntoOrderId: uuid('merged_into_order_id'),
  },
  (t) => [
    index('orders_outlet_status_idx').on(t.outletId, t.status),
    uniqueIndex('orders_outlet_number_idx').on(t.outletId, t.orderNumber),
    index('orders_created_idx').on(t.createdAt),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    orderId: uuid('order_id')
      .references(() => orders.id, { onDelete: 'cascade' })
      .notNull(),
    seq: integer('seq').notNull(),
    itemId: uuid('item_id').references(() => menuItems.id),
    name: text('name').notNull(),
    variationId: uuid('variation_id'),
    variationName: text('variation_name'),
    unitPrice: integer('unit_price').notNull(),
    addons: jsonb('addons').$type<AddonSnapshot[]>().default([]).notNull(),
    qty: integer('qty').notNull(),
    note: text('note'),
    status: text('status').default('PENDING').notNull(), // OrderItemStatus
    taxRateBps: integer('tax_rate_bps').default(0).notNull(),
    taxInclusive: boolean('tax_inclusive').default(false).notNull(),
    packagingCharge: integer('packaging_charge').default(0).notNull(),
    station: text('station').default('KITCHEN').notNull(),
    discount: jsonb('discount').$type<DiscountJson | null>(),
    kotId: uuid('kot_id'),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by'),
    voidedAt: ts('voided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export type KotItemSnapshot = {
  orderItemId: string;
  name: string;
  variation?: string;
  qty: number;
  addons?: string[];
  note?: string;
  cancelled?: boolean;
};

export const kots = pgTable(
  'kots',
  {
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    orderId: uuid('order_id')
      .references(() => orders.id, { onDelete: 'cascade' })
      .notNull(),
    kotNumber: text('kot_number').notNull(),
    station: text('station').default('KITCHEN').notNull(),
    kind: text('kind').default('NEW').notNull(), // NEW | EDIT | CANCEL
    status: text('status').default('NEW').notNull(), // KotStatus
    items: jsonb('items').$type<KotItemSnapshot[]>().default([]).notNull(),
    printCount: integer('print_count').default(0).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    bumpedAt: ts('bumped_at'),
  },
  (t) => [index('kots_order_idx').on(t.orderId), index('kots_outlet_status_idx').on(t.outletId, t.status)],
);

export const bills = pgTable(
  'bills',
  {
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    orderId: uuid('order_id')
      .references(() => orders.id)
      .notNull(),
    billNumber: text('bill_number').notNull(),
    /** number shown on a bill printed while offline, before the server assigned billNumber */
    provisionalNumber: text('provisional_number'),
    status: text('status').default('UNPAID').notNull(), // UNPAID | PAID | VOID
    /** full BillResult from @rms/shared — the authoritative computed breakdown */
    computed: jsonb('computed').$type<Record<string, unknown>>().notNull(),
    subtotal: integer('subtotal').notNull(),
    discountTotal: integer('discount_total').notNull(),
    serviceCharge: integer('service_charge').notNull(),
    taxTotal: integer('tax_total').notNull(),
    cgstTotal: integer('cgst_total').notNull(),
    sgstTotal: integer('sgst_total').notNull(),
    roundOff: integer('round_off').notNull(),
    grandTotal: integer('grand_total').notNull(),
    paidTotal: integer('paid_total').default(0).notNull(),
    printCount: integer('print_count').default(0).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    paidAt: ts('paid_at'),
    voidedAt: ts('voided_at'),
    voidReason: text('void_reason'),
  },
  (t) => [uniqueIndex('bills_outlet_number_idx').on(t.outletId, t.billNumber), index('bills_order_idx').on(t.orderId)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id')
      .references(() => outlets.id)
      .notNull(),
    billId: uuid('bill_id')
      .references(() => bills.id)
      .notNull(),
    orderId: uuid('order_id')
      .references(() => orders.id)
      .notNull(),
    mode: text('mode').notNull(), // PaymentMode
    amount: integer('amount').notNull(),
    /** tendered cash (for change calc) or UPI/card reference */
    tendered: integer('tendered'),
    reference: text('reference'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    voided: boolean('voided').default(false).notNull(),
  },
  (t) => [index('payments_bill_idx').on(t.billId), index('payments_created_idx').on(t.outletId, t.createdAt)],
);

// ---------------------------------------------------------------- infra
export const printers = pgTable('printers', {
  id: id(),
  outletId: uuid('outlet_id')
    .references(() => outlets.id)
    .notNull(),
  name: text('name').notNull(),
  /** which tickets go here: BILL, or a kitchen station name (KITCHEN, BAR, TANDOOR…) */
  station: text('station').notNull(),
  kind: text('kind').default('NETWORK').notNull(), // NETWORK (ESC/POS over TCP 9100) | BROWSER | NONE
  host: text('host'),
  port: integer('port').default(9100).notNull(),
  width: integer('width').default(42).notNull(),
  active: boolean('active').default(true).notNull(),
});

/** Atomic per-outlet counters (order/KOT/bill numbers). key e.g. "order:2026-09-04", "bill:FY26" */
export const counters = pgTable(
  'counters',
  {
    outletId: uuid('outlet_id').notNull(),
    key: text('key').notNull(),
    value: integer('value').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.outletId, t.key] })],
);

/** Idempotency ledger for offline sync — one row per client operation id. */
export const syncOps = pgTable(
  'sync_ops',
  {
    id: uuid('id').primaryKey(),
    outletId: uuid('outlet_id').notNull(),
    deviceId: text('device_id').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(), // APPLIED | REJECTED
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('sync_ops_device_idx').on(t.deviceId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    outletId: uuid('outlet_id').notNull(),
    userId: uuid('user_id'),
    userName: text('user_name'),
    action: text('action').notNull(), // ORDER_CANCEL, ITEM_VOID, DISCOUNT, PRICE_CHANGE, REFUND, BILL_REPRINT, ...
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    details: jsonb('details').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_outlet_created_idx').on(t.outletId, t.createdAt)],
);

// ---------------------------------------------------------------- relations (for db.query.*)
export const outletsRelations = relations(outlets, ({ many }) => ({
  users: many(users),
  tables: many(tables),
  areas: many(areas),
}));
export const areasRelations = relations(areas, ({ many, one }) => ({
  tables: many(tables),
  outlet: one(outlets, { fields: [areas.outletId], references: [outlets.id] }),
}));
export const tablesRelations = relations(tables, ({ one }) => ({
  area: one(areas, { fields: [tables.areaId], references: [areas.id] }),
}));
export const menuCategoriesRelations = relations(menuCategories, ({ many }) => ({ items: many(menuItems) }));
export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  category: one(menuCategories, { fields: [menuItems.categoryId], references: [menuCategories.id] }),
  taxSlab: one(taxSlabs, { fields: [menuItems.taxSlabId], references: [taxSlabs.id] }),
  variations: many(variations),
  addonGroups: many(itemAddonGroups),
}));
export const variationsRelations = relations(variations, ({ one }) => ({
  item: one(menuItems, { fields: [variations.itemId], references: [menuItems.id] }),
}));
export const addonGroupsRelations = relations(addonGroups, ({ many }) => ({ addons: many(addons), items: many(itemAddonGroups) }));
export const addonsRelations = relations(addons, ({ one }) => ({
  group: one(addonGroups, { fields: [addons.groupId], references: [addonGroups.id] }),
}));
export const itemAddonGroupsRelations = relations(itemAddonGroups, ({ one }) => ({
  item: one(menuItems, { fields: [itemAddonGroups.itemId], references: [menuItems.id] }),
  group: one(addonGroups, { fields: [itemAddonGroups.groupId], references: [addonGroups.id] }),
}));
export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  kots: many(kots),
  bills: many(bills),
  payments: many(payments),
  table: one(tables, { fields: [orders.tableId], references: [tables.id] }),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
}));
export const kotsRelations = relations(kots, ({ one }) => ({
  order: one(orders, { fields: [kots.orderId], references: [orders.id] }),
}));
export const billsRelations = relations(bills, ({ one, many }) => ({
  order: one(orders, { fields: [bills.orderId], references: [orders.id] }),
  payments: many(payments),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({
  bill: one(bills, { fields: [payments.billId], references: [bills.id] }),
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
}));

export const schema = {
  brands,
  outlets,
  users,
  areas,
  tables,
  taxSlabs,
  menuCategories,
  menuItems,
  variations,
  addonGroups,
  addons,
  itemAddonGroups,
  customers,
  orders,
  orderItems,
  kots,
  bills,
  payments,
  printers,
  counters,
  syncOps,
  auditLogs,
  outletsRelations,
  areasRelations,
  tablesRelations,
  menuCategoriesRelations,
  menuItemsRelations,
  variationsRelations,
  addonGroupsRelations,
  addonsRelations,
  itemAddonGroupsRelations,
  ordersRelations,
  orderItemsRelations,
  kotsRelations,
  billsRelations,
  paymentsRelations,
};
// keep sql import referenced for future raw defaults
void sql;
