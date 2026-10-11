import type { RoundingMode } from './money';

/** Shared domain constants & string-union types (kept as strings so they serialize cleanly and work in IndexedDB + Postgres). */

export const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['OPEN', 'BILLED', 'SETTLED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ['PENDING', 'SENT', 'READY', 'SERVED', 'VOIDED'] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const TABLE_STATUSES = ['FREE', 'RUNNING', 'BILLED', 'RESERVED'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const KOT_STATUSES = ['NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;
export type KotStatus = (typeof KOT_STATUSES)[number];

export const PAYMENT_MODES = ['CASH', 'CARD', 'UPI', 'WALLET', 'CREDIT', 'OTHER'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const FOOD_TYPES = ['VEG', 'NON_VEG', 'EGG'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export const ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'CAPTAIN', 'KITCHEN'] as const;
export type RoleName = (typeof ROLES)[number];

/** Granular permission keys. Roles are bundles of these; users may get overrides later. */
export const PERMISSIONS = [
  'pos.order.create',
  'pos.order.edit',
  'pos.order.void_item',
  'pos.order.cancel',
  'pos.kot.send',
  'pos.kot.reprint',
  'pos.bill.generate',
  'pos.bill.discount',
  'pos.bill.discount.unlimited',
  'pos.bill.reprint',
  'pos.payment.settle',
  'pos.payment.refund',
  'pos.table.transfer',
  'pos.table.merge',
  'menu.read',
  'menu.write',
  'tables.write',
  'settings.write',
  'users.manage',
  'reports.read',
  'audit.read',
  'kds.view',
  'insights.read',
  'inventory.read',
  'inventory.write',
  'purchase.read',
  'purchase.write',
  'pricing.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  OWNER: [...PERMISSIONS],
  MANAGER: PERMISSIONS.filter((p) => p !== 'users.manage'),
  CASHIER: [
    'pos.order.create',
    'pos.order.edit',
    'pos.kot.send',
    'pos.kot.reprint',
    'pos.bill.generate',
    'pos.bill.discount',
    'pos.bill.reprint',
    'pos.payment.settle',
    'pos.table.transfer',
    'pos.table.merge',
    'menu.read',
  ],
  CAPTAIN: ['pos.order.create', 'pos.order.edit', 'pos.kot.send', 'pos.table.transfer', 'menu.read'],
  KITCHEN: ['kds.view', 'menu.read'],
};

export const DEFAULT_OUTLET_SETTINGS = {
  currency: 'INR',
  taxInclusive: false,
  roundingMode: 'NEAREST_RUPEE' as RoundingMode,
  serviceChargeBps: 0,
  serviceChargeTaxable: false,
  serviceChargeTaxRateBps: 1800,
  /** Max discount a CASHIER may give without manager PIN (bps) */
  cashierMaxDiscountBps: 1000,
  receiptHeader: '',
  receiptFooter: 'Thank you! Visit again.',
  printerWidth: 42 as 32 | 42 | 48,
  gstin: '',
  fssai: '',
  billPrefix: 'INV',
  kotPrefix: 'KOT',
};
export type OutletSettings = typeof DEFAULT_OUTLET_SETTINGS;

/** Void / cancel reasons (kept as data so outlets can extend them later). */
export const VOID_REASONS = [
  'Customer changed mind',
  'Wrong item punched',
  'Item not available',
  'Quality issue',
  'Long wait time',
  'Duplicate entry',
  'Other',
] as const;
