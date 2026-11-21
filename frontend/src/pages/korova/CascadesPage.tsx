import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Input, Popconfirm, Select, Switch, Table } from 'antd';
import type { TableColumnsType } from 'antd';

import KorovaPage, { Row, Section, Status } from '@/components/korova/KorovaPage';
import { ClipboardManager } from '@/utils';
import { getMessage } from '@/utils/messageBus';
import {
  fmtDate,
  useCascades,
  useInboundOptions,
  useKorovaPost,
  useNodeInstallCommand,
  type Cascade,
  type ConnectNodeResult,
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

function ConnectServer() {
  const navigate = useNavigate();
  const { data: command } = useNodeInstallCommand();
  const connect = useKorovaPost<{ key: string; name: string; force: boolean }, ConnectNodeResult>('/nodes/connect');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [result, setResult] = useState<ConnectNodeResult | null>(null);
  const shownCommand =
    command || 'bash <(curl -fsSL https://github.com/ТВОЙ_НИК/korova/releases/download/korova-latest/korova.sh) install node';

  const run = (force: boolean) =>
    connect.mutate(
      { key, name, force },
      {
        onSuccess: (r) => {
          setResult(r);
          if (r.id > 0) {
            setKey('');
            setName('');
          }
        },
        onError: () => setResult(null),
      },
    );

  return (
    <Section title="Подключить сервер" sub="Установи Korova на новый сервер и вставь сюда ключ, который он выведет." flush>
      <Row label="1. Установка" hint="Выполни на новом сервере от root. Через минуту в конце появится ключ korova-node:…">
        <div className="k-copy">
          <span className="k-mono" title={shownCommand}>
            {shownCommand}
          </span>
          <Button
            size="small"
            onClick={async () => {
              await ClipboardManager.copyText(shownCommand);
              getMessage().success('Команда скопирована');
            }}
          >
            Копировать
          </Button>
        </div>
      </Row>
      <Row label="2. Ключ узла" hint="Потерял ключ — выполни на узле korova token, он выпустит новый.">
        <Input.TextArea
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setResult(null);
          }}
          placeholder="korova-node:eyJ2IjoxLC..."
          autoSize={{ minRows: 2, maxRows: 4 }}
          style={{ fontFamily: 'var(--k-mono)', fontSize: 12.5 }}
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название, например de-1 (необязательно)"
            style={{ maxWidth: 300 }}
          />
          <Button type="primary" disabled={!key.trim()} loading={connect.isPending} onClick={() => run(false)}>
            Подключить
          </Button>
        </div>
        {result?.needConfirm && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 14 }}
            title="Основной сервер не достучался до узла"
            description={
              <>
                <div className="k-small" style={{ marginBottom: 8 }}>
                  {result.probeError}. Обычно это файрвол в панели хостинга узла: открой там входящий TCP-порт панели узла
                  (обычно 2053) и 443. Можно сохранить узел сейчас — он станет «онлайн», когда связь появится.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button size="small" onClick={() => run(true)} loading={connect.isPending}>
                    Сохранить всё равно
                  </Button>
                  <Button size="small" type="text" onClick={() => setResult(null)}>
                    Отмена
                  </Button>
                </div>
              </>
            }
          />
        )}
        {result && result.id > 0 && (
          <Alert
            type="success"
            showIcon
            style={{ marginTop: 14 }}
            title={`Сервер ${result.name} подключён${result.reachable ? '' : ', ждёт связи'}`}
            description={
              <>
                <div className="k-small" style={{ marginBottom: 8 }}>
                  Дальше создай на нём подключение во «Входящих» (выбери узел {result.name}) и отметь его в «Бот и доступ».
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button size="small" onClick={() => navigate('/inbounds')}>
                    Входящие
                  </Button>
                  <Button size="small" onClick={() => navigate('/korova/bot')}>
                    Бот и доступ
                  </Button>
                </div>
              </>
            }
          />
        )}
      </Row>
    </Section>
  );
}

export default function CascadesPage() {
  const navigate = useNavigate();
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
    <KorovaPage
      title="Серверы и каскады"
      lead="Каскад прячет зарубежный сервер: человек подключается к российскому, а тот незаметно передаёт трафик дальше."
      actions={<Button onClick={() => navigate('/nodes')}>Узлы</Button>}
    >
      <div className="k-stack">
        <ConnectServer />

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
    </KorovaPage>
  );
}
