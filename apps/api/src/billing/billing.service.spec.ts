import { computeBill, DEFAULT_OUTLET_SETTINGS } from '@rms/shared';
import { billInputFor } from './billing.service';

const item = (over: Partial<any> = {}) => ({
  id: 'i1',
  outletId: 'o',
  orderId: 'ord',
  seq: 1,
  itemId: 'm1',
  name: 'Paneer Tikka',
  variationId: null,
  variationName: 'Full',
  unitPrice: 42000,
  addons: [{ id: 'a', name: 'Extra Cheese', price: 4000 }],
  qty: 2,
  note: null,
  status: 'SENT',
  taxRateBps: 500,
  taxInclusive: false,
  packagingCharge: 1000,
  station: 'KITCHEN',
  discount: null,
  kotId: null,
  voidReason: null,
  voidedBy: null,
  voidedAt: null,
  createdAt: new Date(),
  ...over,
});

describe('billInputFor → computeBill (server billing pipeline)', () => {
  const settings = { ...DEFAULT_OUTLET_SETTINGS, roundingMode: 'NONE' as const };

  it('dine-in: no packaging, addons included, variation named', () => {
    const r = computeBill(billInputFor({ type: 'DINE_IN', discount: null, serviceChargeBps: null, deliveryCharge: 0 }, [item()], settings));
    expect(r.lines[0].name).toBe('Paneer Tikka (Full)');
    expect(r.subtotal).toBe((42000 + 4000) * 2);
    expect(r.grandTotal).toBe(92000 + 4600);
  });

  it('takeaway: packaging charged per unit; delivery charge only for delivery', () => {
    const t = computeBill(billInputFor({ type: 'TAKEAWAY', discount: null, serviceChargeBps: null, deliveryCharge: 3000 }, [item()], settings));
    expect(t.subtotal).toBe((42000 + 4000 + 1000) * 2);
    expect(t.deliveryCharge).toBe(0);
    const d = computeBill(billInputFor({ type: 'DELIVERY', discount: null, serviceChargeBps: null, deliveryCharge: 3000 }, [item()], settings));
    expect(d.deliveryCharge).toBe(3000);
  });

  it('voided lines are excluded, order discount + outlet service charge applied', () => {
    const r = computeBill(
      billInputFor(
        { type: 'DINE_IN', discount: { type: 'PERCENT', value: 1000 }, serviceChargeBps: null, deliveryCharge: 0 },
        [item(), item({ id: 'i2', status: 'VOIDED' })],
        { ...settings, serviceChargeBps: 500 },
      ),
    );
    expect(r.lines).toHaveLength(1);
    expect(r.billDiscountTotal).toBe(9200);
    expect(r.taxableTotal).toBe(82800);
    expect(r.serviceCharge).toBe(4140);
  });

  it('order-level service charge overrides outlet default; inclusive pricing extracts tax', () => {
    const r = computeBill(
      billInputFor({ type: 'DINE_IN', discount: null, serviceChargeBps: 0, deliveryCharge: 0 }, [item({ taxInclusive: true, addons: [], qty: 1, unitPrice: 10500 })], { ...settings, serviceChargeBps: 1000 }),
    );
    expect(r.serviceCharge).toBe(0);
    expect(r.lines[0].taxable).toBe(10000);
    expect(r.grandTotal).toBe(10500);
  });
});
