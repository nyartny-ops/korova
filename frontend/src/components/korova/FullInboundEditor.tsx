import { lazy, Suspense, useState } from 'react';
import { Button } from 'antd';
import { useQueryClient } from '@tanstack/react-query';

import { HttpUtil } from '@/utils';
import { parseMsg } from '@/utils/zodValidate';
import { getMessage } from '@/utils/messageBus';
import { DBInbound } from '@/models/dbinbound';
import { InboundDetailSchema } from '@/schemas/inbound';
import { useNodesQuery } from '@/api/queries/useNodesQuery';

const InboundFormModal = lazy(() => import('@/pages/inbounds/form/InboundFormModal'));

/**
 * Opens the original 3x-ui connection editor (all tabs: protocol, transport,
 * Reality, sniffing, raw JSON) for one inbound Korova manages.
 */
export default function FullInboundEditor({
  inboundId,
  label,
  size,
}: {
  inboundId: number;
  label: string;
  size?: 'small' | 'middle';
}) {
  const qc = useQueryClient();
  const { nodes, fetched } = useNodesQuery();
  const [inbound, setInbound] = useState<DBInbound | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);
    try {
      const msg = await HttpUtil.get(`/panel/api/inbounds/get/${inboundId}`);
      if (!msg?.success || !msg.obj) throw new Error(msg?.msg || 'не загрузилось');
      const validated = parseMsg(msg, InboundDetailSchema, `inbounds/get/${inboundId}`);
      if (!validated.obj) throw new Error('не разобралось');
      setInbound(new DBInbound(validated.obj) as DBInbound);
    } catch (e) {
      getMessage().error(`Не удалось открыть подключение: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={open} loading={loading} disabled={!inboundId} size={size}>
        {label}
      </Button>
      {inbound && (
        <Suspense fallback={null}>
          <InboundFormModal
            open
            mode="edit"
            dbInbound={inbound}
            dbInbounds={[inbound]}
            availableNodes={nodes}
            availableNodesFetched={fetched}
            onClose={() => setInbound(null)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ['korova'] });
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * Opens the original editor in add mode on a given server: any protocol
 * (Hysteria, TUIC, Trojan, Shadowsocks…). onCreated gets the new inbound id.
 */
export function NewInboundButton({
  nodeId,
  remark,
  onCreated,
}: {
  nodeId: number;
  remark: string;
  onCreated: (id: number) => void;
}) {
  const { nodes, fetched } = useNodesQuery();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Добавить протокол</Button>
      {open && (
        <Suspense fallback={null}>
          <InboundFormModal
            open
            mode="add"
            dbInbound={null}
            dbInbounds={[]}
            availableNodes={nodes}
            availableNodesFetched={fetched}
            defaultNodeId={nodeId || null}
            defaultRemark={remark}
            onClose={() => setOpen(false)}
            onSaved={(id) => {
              if (id) onCreated(id);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
