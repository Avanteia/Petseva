import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { DEFAULT_OUTLET_SETTINGS } from '@rms/shared';
import { createDb, createPool, Db } from './client';
import * as s from './schema';

/** Demo credentials (also listed in README). */
export const DEMO_USERS = [
  { name: 'Imran (Owner)', username: 'owner', password: 'owner123', pin: '1234', role: 'OWNER' },
  { name: 'Meera (Manager)', username: 'manager', password: 'manager123', pin: '1111', role: 'MANAGER' },
  { name: 'Asha (Cashier)', username: 'cashier', password: 'cashier123', pin: null, role: 'CASHIER' },
  { name: 'Rahul (Captain)', username: 'captain', password: 'captain123', pin: null, role: 'CAPTAIN' },
  { name: 'Kitchen', username: 'kitchen', password: 'kitchen123', pin: null, role: 'KITCHEN' },
] as const;

const R = (rupees: number) => Math.round(rupees * 100);

export async function seed(db: Db) {
  const existing = await db.query.outlets.findFirst({ where: eq(s.outlets.code, 'DEMO') });
  if (existing) {
    console.log('[seed] demo outlet already exists — skipping (run db:reset to recreate)');
    return;
  }
  console.log('[seed] creating demo brand + outlet');
  const [brand] = await db.insert(s.brands).values({ name: 'Demo Hospitality' }).returning();
  const [outlet] = await db
    .insert(s.outlets)
    .values({
      brandId: brand.id,
      name: 'Demo Cafe Goa',
      code: 'DEMO',
      addressLines: ['Shop 4, Miramar Beach Road', 'Panaji, Goa 403001'],
      phone: '+91 98765 43210',
      gstin: '30ABCDE1234F1Z5',
      fssai: '11223344556677',
      settings: {
        ...DEFAULT_OUTLET_SETTINGS,
        receiptFooter: 'Thank you for dining with us! Follow @democafegoa',
        serviceChargeBps: 0,
      },
      businessHours: { open: '08:00', close: '23:30' },
    })
    .returning();
  const o = outlet.id;

  // users
  for (const u of DEMO_USERS) {
    await db.insert(s.users).values({
      outletId: o,
      name: u.name,
      username: u.username,
      passwordHash: await bcrypt.hash(u.password, 8),
      pinHash: u.pin ? await bcrypt.hash(u.pin, 8) : null,
      role: u.role,
    });
  }

  // floor
  const areaDefs: [string, string[], number][] = [
    ['AC Hall', ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'], 4],
    ['Non-AC', ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'], 4],
    ['Garden', ['G1', 'G2', 'G3', 'G4'], 6],
  ];
  let ai = 0;
  for (const [name, tbls, cap] of areaDefs) {
    const [area] = await db.insert(s.areas).values({ outletId: o, name, sortOrder: ai++ }).returning();
    await db.insert(s.tables).values(
      tbls.map((t, i) => ({
        outletId: o,
        areaId: area.id,
        name: t,
        capacity: cap,
        posX: i % 4,
        posY: Math.floor(i / 4),
        sortOrder: i,
      })),
    );
  }

  // tax slabs
  const slabRows = await db
    .insert(s.taxSlabs)
    .values([
      { outletId: o, name: 'GST 0%', rateBps: 0 },
      { outletId: o, name: 'GST 5%', rateBps: 500 },
      { outletId: o, name: 'GST 12%', rateBps: 1200 },
      { outletId: o, name: 'GST 18%', rateBps: 1800 },
    ])
    .returning();
  const slab = (bps: number) => slabRows.find((x) => x.rateBps === bps)!.id;

  // addon groups
  const [gToppings] = await db.insert(s.addonGroups).values({ outletId: o, name: 'Extras', maxSelect: 5 }).returning();
  await db.insert(s.addons).values([
    { groupId: gToppings.id, name: 'Extra Cheese', price: R(40) },
    { groupId: gToppings.id, name: 'Extra Gravy', price: R(30) },
    { groupId: gToppings.id, name: 'Extra Paneer', price: R(60), sortOrder: 2 },
    { groupId: gToppings.id, name: 'Extra Chicken', price: R(80), foodType: 'NON_VEG', sortOrder: 3 },
  ]);
  const [gSpice] = await db.insert(s.addonGroups).values({ outletId: o, name: 'Spice level', minSelect: 0, maxSelect: 1 }).returning();
  await db.insert(s.addons).values([
    { groupId: gSpice.id, name: 'Mild', price: 0 },
    { groupId: gSpice.id, name: 'Medium', price: 0, sortOrder: 1 },
    { groupId: gSpice.id, name: 'Extra Spicy', price: 0, sortOrder: 2 },
  ]);
  const [gBev] = await db.insert(s.addonGroups).values({ outletId: o, name: 'Beverage add-ons', maxSelect: 3 }).returning();
  await db.insert(s.addons).values([
    { groupId: gBev.id, name: 'Extra Shot', price: R(30) },
    { groupId: gBev.id, name: 'Whipped Cream', price: R(20), sortOrder: 1 },
    { groupId: gBev.id, name: 'Oat Milk', price: R(40), sortOrder: 2 },
  ]);

  // menu
  type ItemDef = {
    name: string;
    code?: string;
    price: number;
    food?: 'VEG' | 'NON_VEG' | 'EGG';
    tax?: number;
    pack?: number;
    variations?: [string, number][];
    addons?: string[];
    station?: string;
    desc?: string;
  };
  const categories: { name: string; station?: string; items: ItemDef[]; availability?: { days: number[]; from: string; to: string }[] }[] = [
    {
      name: 'Breakfast',
      availability: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '07:00', to: '11:30' }],
      items: [
        { name: 'Poha', code: 'POH', price: 80, tax: 500 },
        { name: 'Masala Omelette', code: 'OML', price: 120, food: 'EGG', tax: 500, addons: ['spice'] },
        { name: 'Goan Bhaji Pao', code: 'BHP', price: 90, tax: 500 },
      ],
    },
    {
      name: 'Starters',
      items: [
        { name: 'Paneer Tikka', code: 'PT', price: 250, tax: 500, pack: 10, addons: ['extras', 'spice'], variations: [['Half', 250], ['Full', 420]] },
        { name: 'Chicken Tikka', code: 'CT', price: 320, food: 'NON_VEG', tax: 500, pack: 10, addons: ['spice'], variations: [['Half', 320], ['Full', 540]] },
        { name: 'Veg Spring Roll', code: 'VSR', price: 180, tax: 500, pack: 10 },
        { name: 'Chilli Chicken', code: 'CC', price: 290, food: 'NON_VEG', tax: 500, pack: 10, addons: ['spice'] },
        { name: 'Prawn Rava Fry', code: 'PRF', price: 380, food: 'NON_VEG', tax: 500, pack: 10 },
      ],
    },
    {
      name: 'Goan Specials',
      items: [
        { name: 'Goan Fish Curry Rice', code: 'FCR', price: 320, food: 'NON_VEG', tax: 500, pack: 15, desc: 'Kingfish curry with steamed rice' },
        { name: 'Chicken Xacuti', code: 'CX', price: 340, food: 'NON_VEG', tax: 500, pack: 15, addons: ['spice'] },
        { name: 'Pork Vindaloo', code: 'PV', price: 360, food: 'NON_VEG', tax: 500, pack: 15, addons: ['spice'] },
        { name: 'Veg Caldine', code: 'VC', price: 240, tax: 500, pack: 15 },
        { name: 'Prawn Balchao', code: 'PB', price: 390, food: 'NON_VEG', tax: 500, pack: 15 },
      ],
    },
    {
      name: 'Main Course',
      items: [
        { name: 'Paneer Butter Masala', code: 'PBM', price: 280, tax: 500, pack: 15, addons: ['extras', 'spice'], variations: [['Half', 280], ['Full', 450]] },
        { name: 'Dal Tadka', code: 'DT', price: 180, tax: 500, pack: 15, variations: [['Half', 180], ['Full', 290]] },
        { name: 'Butter Chicken', code: 'BC', price: 340, food: 'NON_VEG', tax: 500, pack: 15, addons: ['extras', 'spice'], variations: [['Half', 340], ['Full', 560]] },
        { name: 'Mutton Rogan Josh', code: 'MRJ', price: 420, food: 'NON_VEG', tax: 500, pack: 15, addons: ['spice'] },
        { name: 'Mix Veg', code: 'MV', price: 210, tax: 500, pack: 15 },
      ],
    },
    {
      name: 'Breads & Rice',
      station: 'TANDOOR',
      items: [
        { name: 'Butter Naan', code: 'BN', price: 50, tax: 500, pack: 3 },
        { name: 'Garlic Naan', code: 'GN', price: 60, tax: 500, pack: 3 },
        { name: 'Tandoori Roti', code: 'TR', price: 30, tax: 500, pack: 3 },
        { name: 'Jeera Rice', code: 'JR', price: 160, tax: 500, pack: 10 },
        { name: 'Chicken Biryani', code: 'CB', price: 320, food: 'NON_VEG', tax: 500, pack: 15, addons: ['spice'], variations: [['Regular', 320], ['Family', 850]] },
        { name: 'Veg Biryani', code: 'VB', price: 240, tax: 500, pack: 15, addons: ['spice'] },
      ],
    },
    {
      name: 'Beverages',
      station: 'BAR',
      items: [
        { name: 'Masala Chai', code: 'MC', price: 40, tax: 500 },
        { name: 'Cappuccino', code: 'CAP', price: 150, tax: 500, addons: ['bev'], variations: [['Regular', 150], ['Large', 190]] },
        { name: 'Cold Coffee', code: 'CCF', price: 170, tax: 500, addons: ['bev'] },
        { name: 'Fresh Lime Soda', code: 'FLS', price: 90, tax: 500, variations: [['Sweet', 90], ['Salted', 90], ['Mixed', 90]] },
        { name: 'Mineral Water 1L', code: 'MW', price: 40, tax: 1800 },
        { name: 'Kokum Sherbet', code: 'KS', price: 110, tax: 500 },
      ],
    },
    {
      name: 'Desserts',
      items: [
        { name: 'Bebinca', code: 'BEB', price: 150, tax: 500, pack: 5, desc: 'Traditional Goan layered pudding' },
        { name: 'Gulab Jamun', code: 'GJ', price: 110, tax: 500, pack: 5 },
        { name: 'Brownie with Ice Cream', code: 'BIC', price: 220, food: 'EGG', tax: 1800, pack: 5 },
      ],
    },
  ];
  const groupIds: Record<string, string> = { extras: gToppings.id, spice: gSpice.id, bev: gBev.id };
  let ci = 0;
  for (const c of categories) {
    const [cat] = await db
      .insert(s.menuCategories)
      .values({ outletId: o, name: c.name, station: c.station ?? 'KITCHEN', sortOrder: ci++, availability: c.availability ?? [] })
      .returning();
    let ii = 0;
    for (const it of c.items) {
      const [row] = await db
        .insert(s.menuItems)
        .values({
          outletId: o,
          categoryId: cat.id,
          name: it.name,
          shortCode: it.code,
          description: it.desc,
          foodType: it.food ?? 'VEG',
          price: R(it.price),
          taxSlabId: slab(it.tax ?? 500),
          packagingCharge: R(it.pack ?? 0),
          station: it.station ?? null,
          sortOrder: ii++,
        })
        .returning();
      if (it.variations) {
        await db.insert(s.variations).values(
          it.variations.map(([name, price], i) => ({ itemId: row.id, name, price: R(price), isDefault: i === 0, sortOrder: i })),
        );
      }
      if (it.addons) {
        await db.insert(s.itemAddonGroups).values(it.addons.map((g) => ({ itemId: row.id, groupId: groupIds[g] })));
      }
    }
  }

  // printers (dry-run by default; set host to a real IP to print over the network)
  await db.insert(s.printers).values([
    { outletId: o, name: 'Counter printer', station: 'BILL', kind: 'NETWORK', host: '192.168.1.50', port: 9100, width: 42 },
    { outletId: o, name: 'Kitchen printer', station: 'KITCHEN', kind: 'NETWORK', host: '192.168.1.51', port: 9100, width: 42 },
    { outletId: o, name: 'Tandoor printer', station: 'TANDOOR', kind: 'NETWORK', host: '192.168.1.51', port: 9100, width: 42 },
    { outletId: o, name: 'Bar printer', station: 'BAR', kind: 'NETWORK', host: '192.168.1.52', port: 9100, width: 42 },
  ]);

  // a couple of customers
  await db.insert(s.customers).values([
    { outletId: o, phone: '9876500001', name: 'Priya Naik', visits: 3, totalSpend: R(2140) },
    { outletId: o, phone: '9876500002', name: 'Joseph D’Souza', visits: 1, totalSpend: R(860) },
  ]);

  console.log('[seed] done. Demo logins:');
  for (const u of DEMO_USERS) console.log(`   ${u.role.padEnd(8)} ${u.username} / ${u.password}${u.pin ? `  (PIN ${u.pin})` : ''}`);
}

if (require.main === module) {
  const pool = createPool();
  seed(createDb(pool))
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
