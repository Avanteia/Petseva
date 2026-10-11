import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export type DomainEvent =
  | { type: 'order.updated'; outletId: string; orderId: string; order?: unknown }
  | { type: 'order.deleted'; outletId: string; orderId: string }
  | { type: 'table.updated'; outletId: string; tableId: string; status: string; currentOrderId: string | null }
  | { type: 'kot.created'; outletId: string; kot: unknown }
  | { type: 'kot.updated'; outletId: string; kot: unknown }
  | { type: 'bill.created'; outletId: string; billId: string; orderId: string }
  | { type: 'bill.paid'; outletId: string; billId: string; orderId: string }
  | { type: 'menu.updated'; outletId: string }
  | { type: 'floor.updated'; outletId: string }
  | { type: 'stock.low'; outletId: string; rawMaterialId: string; name: string; currentStock: number; reorderLevel: number };

/**
 * In-process event bus. When REDIS_URL is configured, a Redis pub/sub bridge can be plugged in here
 * so multiple API instances fan out realtime events (kept out of Phase 1 to stay dependency-free).
 */
@Injectable()
export class EventsService {
  private readonly log = new Logger('Events');
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
    if (process.env.REDIS_URL) this.log.warn('REDIS_URL set but Redis fan-out is not enabled in Phase 1 — using in-process bus');
  }

  publish(evt: DomainEvent): void {
    // Emitting after the current tick lets DB transactions commit first.
    setImmediate(() => this.emitter.emit('event', evt));
  }

  subscribe(handler: (evt: DomainEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }
}
