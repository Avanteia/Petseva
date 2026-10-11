import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, asc, eq, inArray, max } from 'drizzle-orm';
import { Actor, CurrentUser, RequirePerms } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { DB } from '../common/db.module';
import { EventsService } from '../common/events.service';
import { Db } from '../db/client';
import { addonGroups, addons, itemAddonGroups, menuCategories, menuItems, taxSlabs, variations } from '../db/schema';

@Injectable()
export class MenuService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  /** Full menu snapshot for the POS (cached offline). */
  async full(outletId: string) {
    const [slabs, cats, items, vars, groups, adds, links, [ver]] = await Promise.all([
      this.db.select().from(taxSlabs).where(eq(taxSlabs.outletId, outletId)),
      this.db.select().from(menuCategories).where(and(eq(menuCategories.outletId, outletId), eq(menuCategories.active, true))).orderBy(asc(menuCategories.sortOrder)),
      this.db.select().from(menuItems).where(and(eq(menuItems.outletId, outletId), eq(menuItems.active, true))).orderBy(asc(menuItems.sortOrder), asc(menuItems.name)),
      this.db.select().from(variations).where(eq(variations.active, true)).orderBy(asc(variations.sortOrder)),
      this.db.select().from(addonGroups).where(and(eq(addonGroups.outletId, outletId), eq(addonGroups.active, true))),
      this.db.select().from(addons).where(eq(addons.active, true)).orderBy(asc(addons.sortOrder)),
      this.db.select().from(itemAddonGroups),
      this.db.select({ v: max(menuItems.updatedAt) }).from(menuItems).where(eq(menuItems.outletId, outletId)),
    ]);
    const itemIds = new Set(items.map((i) => i.id));
    const slabById = new Map(slabs.map((s) => [s.id, s]));
    return {
      version: ver?.v?.toISOString() ?? new Date(0).toISOString(),
      taxSlabs: slabs,
      addonGroups: groups.map((g) => ({ ...g, addons: adds.filter((a) => a.groupId === g.id) })),
      categories: cats.map((c) => ({
        ...c,
        items: items
          .filter((i) => i.categoryId === c.id)
          .map((i) => ({
            ...i,
            taxRateBps: i.taxSlabId ? slabById.get(i.taxSlabId)?.rateBps ?? 0 : 0,
            station: i.station ?? c.station,
            variations: vars.filter((v) => v.itemId === i.id),
            addonGroupIds: links.filter((l) => l.itemId === i.id && itemIds.has(l.itemId)).map((l) => l.groupId),
          })),
      })),
    };
  }

  // ---- categories
  async upsertCategory(actor: Actor, body: any) {
    const data = {
      outletId: actor.outletId,
      name: body.name,
      station: body.station ?? 'KITCHEN',
      sortOrder: body.sortOrder ?? 0,
      active: body.active ?? true,
      availability: body.availability ?? [],
    };
    const [row] = body.id
      ? await this.db.update(menuCategories).set(data).where(and(eq(menuCategories.id, body.id), eq(menuCategories.outletId, actor.outletId))).returning()
      : await this.db.insert(menuCategories).values(data).returning();
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return row;
  }

  // ---- items
  async upsertItem(actor: Actor, body: any) {
    if (!body.name || body.price === undefined || !body.categoryId) throw new BadRequestException('name, price, categoryId required');
    if (!Number.isInteger(body.price)) throw new BadRequestException('price must be integer paise');
    const data = {
      outletId: actor.outletId,
      categoryId: body.categoryId,
      name: body.name,
      shortCode: body.shortCode ?? null,
      description: body.description ?? null,
      foodType: body.foodType ?? 'VEG',
      price: body.price,
      onlinePrice: body.onlinePrice ?? null,
      taxSlabId: body.taxSlabId ?? null,
      packagingCharge: body.packagingCharge ?? 0,
      station: body.station ?? null,
      available: body.available ?? true,
      stockOut: body.stockOut ?? false,
      imageUrl: body.imageUrl ?? null,
      sortOrder: body.sortOrder ?? 0,
      active: body.active ?? true,
      updatedAt: new Date(),
    };
    let row;
    if (body.id) {
      const before = await this.db.query.menuItems.findFirst({ where: and(eq(menuItems.id, body.id), eq(menuItems.outletId, actor.outletId)) });
      if (!before) throw new NotFoundException('Item not found');
      [row] = await this.db.update(menuItems).set(data).where(eq(menuItems.id, body.id)).returning();
      if (before.price !== data.price) await this.audit.log(this.db, actor, 'PRICE_CHANGE', 'menu_item', row.id, { name: row.name, from: before.price, to: data.price });
    } else {
      [row] = await this.db.insert(menuItems).values(data).returning();
    }
    if (Array.isArray(body.variations)) {
      await this.db.delete(variations).where(eq(variations.itemId, row.id));
      if (body.variations.length)
        await this.db.insert(variations).values(
          body.variations.map((v: any, i: number) => ({ itemId: row.id, name: v.name, price: v.price, onlinePrice: v.onlinePrice ?? null, isDefault: v.isDefault ?? i === 0, sortOrder: i })),
        );
    }
    if (Array.isArray(body.addonGroupIds)) {
      await this.db.delete(itemAddonGroups).where(eq(itemAddonGroups.itemId, row.id));
      if (body.addonGroupIds.length) await this.db.insert(itemAddonGroups).values(body.addonGroupIds.map((g: string) => ({ itemId: row.id, groupId: g })));
    }
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return row;
  }

  async patchItemFlags(actor: Actor, id: string, patch: { available?: boolean; stockOut?: boolean }) {
    const [row] = await this.db
      .update(menuItems)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(menuItems.id, id), eq(menuItems.outletId, actor.outletId)))
      .returning();
    if (!row) throw new NotFoundException('Item not found');
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return row;
  }

  /** Sets the item's cost price (paise) for margin-aware pricing features. Null clears it back to "unknown margin". */
  async patchItemCostPrice(actor: Actor, id: string, costPrice: number | null) {
    if (costPrice !== null && (!Number.isInteger(costPrice) || costPrice < 0)) throw new BadRequestException('costPrice must be a non-negative integer (paise) or null');
    const [row] = await this.db.update(menuItems).set({ costPrice, updatedAt: new Date() }).where(and(eq(menuItems.id, id), eq(menuItems.outletId, actor.outletId))).returning();
    if (!row) throw new NotFoundException('Item not found');
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return row;
  }

  async deleteItem(actor: Actor, id: string) {
    await this.db.update(menuItems).set({ active: false, updatedAt: new Date() }).where(and(eq(menuItems.id, id), eq(menuItems.outletId, actor.outletId)));
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return { ok: true };
  }

  // ---- addon groups
  async upsertAddonGroup(actor: Actor, body: any) {
    const data = { outletId: actor.outletId, name: body.name, minSelect: body.minSelect ?? 0, maxSelect: body.maxSelect ?? 10, active: body.active ?? true };
    const [row] = body.id
      ? await this.db.update(addonGroups).set(data).where(and(eq(addonGroups.id, body.id), eq(addonGroups.outletId, actor.outletId))).returning()
      : await this.db.insert(addonGroups).values(data).returning();
    if (Array.isArray(body.addons)) {
      await this.db.delete(addons).where(eq(addons.groupId, row.id));
      if (body.addons.length)
        await this.db.insert(addons).values(body.addons.map((a: any, i: number) => ({ groupId: row.id, name: a.name, price: a.price ?? 0, foodType: a.foodType ?? 'VEG', sortOrder: i })));
    }
    this.events.publish({ type: 'menu.updated', outletId: actor.outletId });
    return row;
  }

  // ---- tax slabs
  async upsertTaxSlab(actor: Actor, body: any) {
    const data = { outletId: actor.outletId, name: body.name, rateBps: body.rateBps, active: body.active ?? true };
    const [row] = body.id
      ? await this.db.update(taxSlabs).set(data).where(and(eq(taxSlabs.id, body.id), eq(taxSlabs.outletId, actor.outletId))).returning()
      : await this.db.insert(taxSlabs).values(data).returning();
    return row;
  }

  // ---- CSV
  async exportCsv(outletId: string): Promise<string> {
    const m = await this.full(outletId);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['category', 'name', 'short_code', 'food_type', 'price_rupees', 'tax_rate_pct', 'packaging_rupees', 'available', 'variations'].join(',')];
    for (const c of m.categories)
      for (const i of c.items)
        rows.push(
          [c.name, i.name, i.shortCode, i.foodType, (i.price / 100).toFixed(2), i.taxRateBps / 100, (i.packagingCharge / 100).toFixed(2), i.available, i.variations.map((v) => `${v.name}:${(v.price / 100).toFixed(2)}`).join('|')]
            .map(esc)
            .join(','),
        );
    return rows.join('\n');
  }

  /** Import rows (same columns as export). Matches on category+name; creates missing categories/slabs. */
  async importCsv(actor: Actor, csv: string) {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim());
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idx = (k: string) => header.indexOf(k);
    const cats = await this.db.select().from(menuCategories).where(eq(menuCategories.outletId, actor.outletId));
    const slabs = await this.db.select().from(taxSlabs).where(eq(taxSlabs.outletId, actor.outletId));
    const existing = await this.db.select().from(menuItems).where(eq(menuItems.outletId, actor.outletId));
    let created = 0,
      updated = 0;
    for (const line of lines.slice(1)) {
      const c = parseCsvLine(line);
      const catName = c[idx('category')];
      let cat = cats.find((x) => x.name.toLowerCase() === catName.toLowerCase());
      if (!cat) {
        [cat] = await this.db.insert(menuCategories).values({ outletId: actor.outletId, name: catName, sortOrder: cats.length }).returning();
        cats.push(cat);
      }
      const ratePct = Number(c[idx('tax_rate_pct')] || 0);
      let slab = slabs.find((s) => s.rateBps === Math.round(ratePct * 100));
      if (!slab) {
        [slab] = await this.db.insert(taxSlabs).values({ outletId: actor.outletId, name: `GST ${ratePct}%`, rateBps: Math.round(ratePct * 100) }).returning();
        slabs.push(slab);
      }
      const name = c[idx('name')];
      const prev = existing.find((i) => i.categoryId === cat!.id && i.name.toLowerCase() === name.toLowerCase());
      const varsRaw = c[idx('variations')] || '';
      const vars = varsRaw
        ? varsRaw.split('|').map((p) => {
            const [n, pr] = p.split(':');
            return { name: n.trim(), price: Math.round(Number(pr) * 100) };
          })
        : undefined;
      await this.upsertItem(actor, {
        id: prev?.id,
        categoryId: cat.id,
        name,
        shortCode: c[idx('short_code')] || null,
        foodType: c[idx('food_type')] || 'VEG',
        price: Math.round(Number(c[idx('price_rupees')] || 0) * 100),
        taxSlabId: slab.id,
        packagingCharge: Math.round(Number(c[idx('packaging_rupees')] || 0) * 100),
        available: (c[idx('available')] ?? 'true').toLowerCase() !== 'false',
        variations: vars,
      });
      prev ? updated++ : created++;
    }
    return { created, updated };
  }

  async itemsByIds(outletId: string, ids: string[]) {
    if (!ids.length) return [];
    return this.db.select().from(menuItems).where(and(eq(menuItems.outletId, outletId), inArray(menuItems.id, ids)));
  }
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

@ApiTags('menu')
@ApiBearerAuth()
@Controller('menu')
export class MenuController {
  constructor(private readonly svc: MenuService) {}

  @Get() @ApiOperation({ summary: 'Full nested menu snapshot for POS' }) full(@CurrentUser() u: Actor) {
    return this.svc.full(u.outletId);
  }
  @Post('categories') @RequirePerms('menu.write') cat(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertCategory(u, b);
  }
  @Post('items') @RequirePerms('menu.write') item(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertItem(u, b);
  }
  @Patch('items/:id/flags') @RequirePerms('menu.write') flags(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: any) {
    return this.svc.patchItemFlags(u, id, { available: b.available, stockOut: b.stockOut });
  }
  @Patch('items/:id/cost-price') @RequirePerms('menu.write') costPrice(@CurrentUser() u: Actor, @Param('id') id: string, @Body() b: { costPrice: number | null }) {
    return this.svc.patchItemCostPrice(u, id, b.costPrice);
  }
  @Delete('items/:id') @RequirePerms('menu.write') del(@CurrentUser() u: Actor, @Param('id') id: string) {
    return this.svc.deleteItem(u, id);
  }
  @Post('addon-groups') @RequirePerms('menu.write') group(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertAddonGroup(u, b);
  }
  @Post('tax-slabs') @RequirePerms('settings.write') slab(@CurrentUser() u: Actor, @Body() b: any) {
    return this.svc.upsertTaxSlab(u, b);
  }
  @Get('export.csv') @RequirePerms('menu.read') @Header('Content-Type', 'text/csv') exportCsv(@CurrentUser() u: Actor) {
    return this.svc.exportCsv(u.outletId);
  }
  @Post('import') @RequirePerms('menu.write') @ApiOperation({ summary: 'Import items from CSV text body {csv: string}' }) importCsv(@CurrentUser() u: Actor, @Body() b: { csv: string }) {
    return this.svc.importCsv(u, b.csv);
  }
}

@Module({ controllers: [MenuController], providers: [MenuService], exports: [MenuService] })
export class MenuModule {}
