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
export default function FullInboundEditor({ inboundId, label }: { inboundId: number; label: string }) {
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
      <Button onClick={open} loading={loading} disabled={!inboundId}>
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
