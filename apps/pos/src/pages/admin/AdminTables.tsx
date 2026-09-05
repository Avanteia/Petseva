import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { Button, Input, Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { cache } from '../../lib/db';
import { refreshFloor } from '../../lib/sync';
import type { Area, Table } from '../../lib/types';
import { toast } from '../../store/toast';

export default function AdminTables() {
  const floor = useLiveQuery(() => cache.floor(), []) as Area[] | undefined;
  const [edit, setEdit] = useState<Partial<Table> | null>(null);
  const [areaName, setAreaName] = useState('');
  if (!floor) return null;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await refreshFloor();
      toast(msg, 'ok');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  };
  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      <div className="mb-4 flex items-center gap-2">
        <h1 className="font-semibold">Floor & tables</h1>
        <Input value={areaName} onChange={(e) => setAreaName(e.target.value)} placeholder="New area name" className="ml-auto w-48" />
        <Button onClick={() => areaName && run(() => api('POST', '/floor/areas', { name: areaName, sortOrder: floor.length }).then(() => setAreaName('')), 'Area added')}>+ Area</Button>
      </div>
      {floor.map((a) => (
        <div key={a.id} className="mb-4 rounded-xl border border-slate-800">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
            <span className="font-semibold">{a.name}</span>
            <Button size="sm" onClick={() => setEdit({ areaId: a.id, capacity: 4, name: '' })}>+ Table</Button>
          </div>
          <div className="flex flex-wrap gap-2 p-3">
            {a.tables.map((t) => (
              <button key={t.id} onClick={() => setEdit(t)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-slate-500">
                {t.name} <span className="text-xs text-slate-500">· {t.capacity}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {edit && (
        <Modal
          open
          onClose={() => setEdit(null)}
          title={edit.id ? `Table ${edit.name}` : 'New table'}
          width="max-w-sm"
          footer={
            <>
              {edit.id && <Button variant="danger" className="mr-auto" onClick={() => run(() => api('DELETE', `/floor/tables/${edit.id}`).then(() => setEdit(null)), 'Table removed')}>Remove</Button>}
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => run(() => api('POST', '/floor/tables', { id: edit.id, areaId: edit.areaId, name: edit.name, capacity: edit.capacity }).then(() => setEdit(null)), 'Saved')}>Save</Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <label>Name<Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></label>
            <label>Capacity<Input type="number" value={edit.capacity ?? 4} onChange={(e) => setEdit({ ...edit, capacity: Number(e.target.value) })} /></label>
            {edit.id && <Button variant="outline" onClick={() => run(() => api('POST', `/floor/tables/${edit.id}/reserve`, { reserved: edit.status !== 'RESERVED' }).then(() => setEdit(null)), 'Updated')}>{edit.status === 'RESERVED' ? 'Clear reservation' : 'Mark reserved'}</Button>}
          </div>
        </Modal>
      )}
    </div>
  );
}
