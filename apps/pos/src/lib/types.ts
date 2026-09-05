import type { BillResult, DiscountSpec, OrderStatus, OrderType, OutletSettings, PaymentMode, RoleName } from '@rms/shared';

export interface User {
  id: string;
  name: string;
  username: string;
  role: RoleName;
  outletId: string;
  permissions: string[];
}

export interface Outlet {
  id: string;
  name: string;
  code: string;
  addressLines: string[];
  phone?: string | null;
  gstin?: string | null;
  fssai?: string | null;
  timezone: string;
  settings: OutletSettings;
}

export interface Variation {
  id: string;
  name: string;
  price: number;
  isDefault: boolean;
}
export interface Addon {
  id: string;
  name: string;
  price: number;
  foodType: string;
}
export interface AddonGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  addons: Addon[];
}
export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  shortCode?: string | null;
  description?: string | null;
  foodType: 'VEG' | 'NON_VEG' | 'EGG';
  price: number;
  taxSlabId?: string | null;
  taxRateBps: number;
  packagingCharge: number;
  station: string;
  available: boolean;
  stockOut: boolean;
  variations: Variation[];
  addonGroupIds: string[];
}
export interface MenuCategory {
  id: string;
  name: string;
  station: string;
  sortOrder: number;
  availability: { days: number[]; from: string; to: string }[];
  items: MenuItem[];
}
export interface Menu {
  version: string;
  taxSlabs: { id: string; name: string; rateBps: number }[];
  addonGroups: AddonGroup[];
  categories: MenuCategory[];
}

export interface TableSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  covers: number;
  createdAt: string;
  itemCount: number;
  pendingKot: boolean;
  approxTotal: number;
}
export interface Table {
  id: string;
  areaId: string;
  name: string;
  capacity: number;
  status: 'FREE' | 'RUNNING' | 'BILLED' | 'RESERVED';
  currentOrderId: string | null;
  posX: number;
  posY: number;
  order?: TableSummary | null;
}
export interface Area {
  id: string;
  name: string;
  sortOrder: number;
  tables: Table[];
}

export interface OrderItem {
  id: string;
  orderId: string;
  seq: number;
  itemId: string | null;
  name: string;
  variationId: string | null;
  variationName: string | null;
  unitPrice: number;
  addons: { id: string; name: string; price: number }[];
  qty: number;
  note: string | null;
  status: 'PENDING' | 'SENT' | 'READY' | 'SERVED' | 'VOIDED';
  taxRateBps: number;
  taxInclusive: boolean;
  packagingCharge: number;
  station: string;
  discount: DiscountSpec | null;
  kotId: string | null;
  voidReason?: string | null;
}
export interface Kot {
  id: string;
  orderId: string;
  kotNumber: string;
  station: string;
  kind: 'NEW' | 'EDIT' | 'CANCEL';
  status: string;
  items: { orderItemId: string; name: string; variation?: string; qty: number; addons?: string[]; note?: string; cancelled?: boolean }[];
  createdAt: string;
}
export interface Payment {
  id: string;
  billId: string;
  mode: PaymentMode;
  amount: number;
  tendered?: number | null;
  reference?: string | null;
  voided: boolean;
  createdAt: string;
}
export interface Bill {
  id: string;
  orderId: string;
  billNumber: string;
  provisionalNumber?: string | null;
  status: 'UNPAID' | 'PAID' | 'VOID';
  computed: BillResult;
  grandTotal: number;
  paidTotal: number;
  createdAt: string;
  payments?: Payment[];
}
export interface Order {
  id: string;
  orderNumber: string;
  type: OrderType;
  status: OrderStatus;
  tableId: string | null;
  tableName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress?: string | null;
  covers: number;
  notes: string | null;
  discount: DiscountSpec | null;
  serviceChargeBps: number | null;
  deliveryCharge: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  items: OrderItem[];
  kots: Kot[];
  bills: Bill[];
  payments: Payment[];
  /** client-side flags */
  _local?: boolean;
}

export interface Printer {
  id: string;
  name: string;
  station: string;
  kind: string;
  host?: string | null;
  port: number;
  width: number;
}

export interface SyncOp {
  id: string;
  seq: number;
  type: string;
  payload: any;
  at: string;
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  error?: string;
  orderId?: string;
}
