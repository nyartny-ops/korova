import { useMemo, useState } from 'react';
import { Button, Input, Popconfirm, Select, Switch, Table } from 'antd';
import type { TableColumnsType } from 'antd';

import { Row, Section, Status } from '@/components/korova/KorovaPage';
import {
  fmtDate,
  useCascades,
  useInboundOptions,
  useKorovaPost,
  type Cascade,
  type InboundOption,
} from '@/components/korova/api';

interface CascadeBody {
  name: string;
  entryInboundId: number;
  exitInboundId: number;
  exitAddress: string;
  directRu: boolean;
}

const EXIT_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'];
const serverName = (ib?: InboundOption) => (ib ? ib.nodeName || 'Основной сервер' : '');
const optionLabel = (ib: InboundOption) => `${serverName(ib)} — ${ib.remark || ib.tag} · ${ib.protocol}:${ib.port}`;

export function ManualCascades() {
  const { data: inbounds = [] } = useInboundOptions();
  const { data: cascades = [], isLoading } = useCascades();
  const create = useKorovaPost<CascadeBody, Cascade>('/cascades');
  const del = useKorovaPost<{ id: number }>((b) => `/cascades/${b.id}/del`);
  const [entry, setEntry] = useState<number>();
  const [exit, setExit] = useState<number>();
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [directRu, setDirectRu] = useState(true);

  const byId = useMemo(() => new Map(inbounds.map((ib) => [ib.id, ib])), [inbounds]);
  const entryIb = entry ? byId.get(entry) : undefined;
  const exitIb = exit ? byId.get(exit) : undefined;
  const needsAddress = !!exitIb && exitIb.nodeId === 0;
  const canCreate = !!entryIb && !!exitIb && (!needsAddress || address.trim() !== '');

  const exitOptions = inbounds
    .filter((ib) => EXIT_PROTOCOLS.includes(ib.protocol) && (!entryIb || ib.nodeId !== entryIb.nodeId))
    .map((ib) => ({ value: ib.id, label: optionLabel(ib) }));

  const reset = () => {
    setEntry(undefined);
    setExit(undefined);
    setName('');
    setAddress('');
  };

  const columns: TableColumnsType<Cascade> = [
    {
      title: 'Каскад',
      dataIndex: 'name',
      render: (n: string, c) => (
        <span>
          <b>{n}</b>
          <div className="k-muted k-small">
            {serverName(byId.get(c.entryInboundId)) || '?'} → {serverName(byId.get(c.exitInboundId)) || '?'}
            {c.directRu && ' · РФ напрямую'}
          </div>
        </span>
      ),
    },
    {
      title: 'Состояние',
      dataIndex: 'status',
      render: (s: string, c) =>
        s === 'active' ? (
          <Status tone="good">работает</Status>
        ) : (
          <div style={{ maxWidth: 380 }}>
            <Status tone="bad">ошибка</Status>
            <div className="k-muted k-small" style={{ marginTop: 4 }}>
              {c.lastError}
            </div>
          </div>
        ),
    },
    { title: 'Создан', dataIndex: 'createdAt', render: (ms: number) => <span className="k-num">{fmtDate(ms)}</span> },
    {
      title: '',
      key: 'a',
      align: 'right',
      render: (_, c) => (
        <Popconfirm
          title="Удалить каскад?"
          description="Входной сервер снова будет выпускать трафик сам."
          okText="Удалить"
          cancelText="Отмена"
          onConfirm={() => del.mutate({ id: c.id })}
        >
          <Button size="small" type="text" danger>
            Удалить
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <>
      <div className="k-stack">
        <Section title="Новый каскад" sub="Панель сама настроит исходящее подключение и маршрутизацию на входе." flush>
          <div style={{ padding: '20px 20px 0' }}>
            <div className="k-route" aria-hidden>
              <span className="k-route-node">Пользователь</span>
              <span className="k-route-line" />
              <span className={`k-route-node${entryIb ? ' is-set' : ''}`}>{serverName(entryIb) || 'Вход в РФ'}</span>
              <span className="k-route-line" />
              <span className={`k-route-node${exitIb ? ' is-set' : ''}`}>{serverName(exitIb) || 'Выход за границей'}</span>
              <span className="k-route-line" />
              <span className="k-route-node">Интернет</span>
            </div>
          </div>
          <Row label="Вход" hint="Подключение, которое получают подписчики. Обычно VLESS + Reality на 443.">
            <Select
              style={{ width: '100%' }}
              placeholder="Выбери подключение на входном сервере"
              value={entry}
              onChange={(v) => {
                setEntry(v);
                setExit(undefined);
              }}
              options={inbounds.map((ib) => ({ value: ib.id, label: optionLabel(ib) }))}
              showSearch
              optionFilterProp="label"
              notFoundContent="Подключений пока нет"
            />
          </Row>
          <Row label="Выход" hint="Зарубежное подключение. Для каскада на нём создастся служебный клиент.">
            <Select
              style={{ width: '100%' }}
              placeholder={entry ? 'Подключение на другом сервере' : 'Сначала выбери вход'}
              value={exit}
              onChange={setExit}
              options={exitOptions}
              disabled={!entry}
              showSearch
              optionFilterProp="label"
              notFoundContent="Нужен VLESS, VMess, Trojan или Shadowsocks на другом сервере"
            />
            {needsAddress && (
              <div style={{ marginTop: 10 }}>
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Публичный IP или домен основного сервера"
                />
              </div>
            )}
          </Row>
          <Row label="Российские сайты" hint="Открываются напрямую с входа, как будто VPN выключен. Банки и госуслуги видят российский адрес.">
            <label style={{ display: 'inline-flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
              <Switch checked={directRu} onChange={setDirectRu} />
              Напрямую
            </label>
          </Row>
          <Row label="Название" hint="Необязательно.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Москва → Германия" />
          </Row>
          <div style={{ padding: '4px 20px 20px', display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              type="primary"
              disabled={!canCreate}
              loading={create.isPending}
              onClick={() =>
                create.mutate(
                  { name, entryInboundId: entry!, exitInboundId: exit!, exitAddress: address, directRu },
                  { onSuccess: reset },
                )
              }
            >
              Создать каскад
            </Button>
          </div>
        </Section>

        <Section title="Каскады" flush>
          <Table<Cascade>
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={cascades}
            pagination={false}
            scroll={{ x: 640 }}
            locale={{ emptyText: <div className="k-empty">Каскадов пока нет.</div> }}
          />
        </Section>

      </div>
    </>
  );
}
