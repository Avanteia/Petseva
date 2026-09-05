import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import net from 'net';
import { buildKot, buildReceipt, bytesToBase64, escposToText, KotData, OrderType, ReceiptData } from '@rms/shared';
import { DB } from '../common/db.module';
import { Db } from '../db/client';
import { printers } from '../db/schema';

export interface PrintResult {
  ok: boolean;
  dryRun: boolean;
  station: string;
  printer?: { name: string; kind: string; host?: string | null };
  /** base64 ESC/POS bytes — the POS can forward these to a local/USB printer agent */
  escpos: string;
  /** plain text preview (also what the browser-print fallback renders) */
  text: string;
  error?: string;
}

/**
 * Print routing: resolve the outlet printer for a station and push raw ESC/POS over TCP:9100.
 * With PRINT_DRY_RUN=true (default in dev) nothing is sent — the bytes + text preview are returned
 * so the POS can show/browser-print them. This is also the fallback when a printer is unreachable.
 */
@Injectable()
export class PrintService {
  private readonly log = new Logger('Print');
  constructor(@Inject(DB) private readonly db: Db) {}

  private get dryRun() {
    return (process.env.PRINT_DRY_RUN ?? 'true') !== 'false';
  }

  async printerFor(outletId: string, station: string) {
    const rows = await this.db.select().from(printers).where(and(eq(printers.outletId, outletId), eq(printers.active, true)));
    return rows.find((p) => p.station === station) ?? rows.find((p) => p.station === 'KITCHEN' && station !== 'BILL') ?? null;
  }

  async send(outletId: string, station: string, bytes: Uint8Array): Promise<PrintResult> {
    const printer = await this.printerFor(outletId, station);
    const base: PrintResult = {
      ok: true,
      dryRun: true,
      station,
      printer: printer ? { name: printer.name, kind: printer.kind, host: printer.host } : undefined,
      escpos: bytesToBase64(bytes),
      text: escposToText(bytes),
    };
    if (this.dryRun || !printer || printer.kind !== 'NETWORK' || !printer.host) return base;
    try {
      await this.tcpSend(printer.host, printer.port, bytes);
      return { ...base, dryRun: false };
    } catch (e: any) {
      this.log.warn(`Printer ${printer.name} (${printer.host}:${printer.port}) failed: ${e.message}`);
      return { ...base, ok: false, dryRun: false, error: e.message };
    }
  }

  private tcpSend(host: string, port: number, bytes: Uint8Array, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error('printer connection timed out'));
      }, timeoutMs);
      sock.once('connect', () => sock.end(Buffer.from(bytes), () => { clearTimeout(t); resolve(); }));
      sock.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  async printKot(outletId: string, order: any, kot: any, reprint = false): Promise<PrintResult> {
    const printer = await this.printerFor(outletId, kot.station);
    const data: KotData = {
      outletName: '',
      kotNumber: kot.kotNumber,
      orderNumber: order.orderNumber,
      orderType: order.type as OrderType,
      tableName: order.tableName ?? undefined,
      station: kot.station,
      createdAt: kot.createdAt,
      items: kot.items,
      reprint,
      isEdit: kot.kind === 'EDIT',
    };
    if (kot.kind === 'CANCEL') data.items = kot.items.map((i: any) => ({ ...i, cancelled: true }));
    const bytes = buildKot(data, printer?.width ?? 42).build();
    return this.send(outletId, kot.station, bytes);
  }

  async printReceipt(outletId: string, data: ReceiptData): Promise<PrintResult> {
    const printer = await this.printerFor(outletId, 'BILL');
    const bytes = buildReceipt(data, printer?.width ?? 42).build();
    const res = await this.send(outletId, 'BILL', bytes);
    return res;
  }

  renderReceipt(data: ReceiptData, width = 42) {
    const bytes = buildReceipt(data, width).build();
    return { escpos: bytesToBase64(bytes), text: escposToText(bytes) };
  }
}
