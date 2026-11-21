import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Collapse,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Skeleton,
  Switch,
} from 'antd';

import KorovaPage, { Section, Status } from '@/components/korova/KorovaPage';
import HappPreview from '@/components/korova/HappPreview';
import FullInboundEditor from '@/components/korova/FullInboundEditor';
import { ManualCascades } from '@/pages/korova/CascadesPage';
import { ClipboardManager } from '@/utils';
import { getMessage } from '@/utils/messageBus';
import {
  COUNTRIES,
  SNI_SUGGESTIONS,
  TRANSPORTS,
  flagOf,
  useKorovaPost,
  useKorovaSettings,
  useNodeInstallCommand,
  useOverview,
  useServers,
  type ConnectNodeResult,
  type InboundLook,
  type KorovaSettings,
  type ServerPatch,
  type ServerRow,
  type Transport,
} from '@/components/korova/api';

const transportTitle = (t: Transport) => TRANSPORTS.find((x) => x.value === t)?.title ?? t;

function TransportPicker({ value, onChange }: { value: Transport; onChange: (t: Transport) => void }) {
  return (
    <div className="k-choice k-choice-3" role="radiogroup" aria-label="Транспорт">
      {TRANSPORTS.map((t) => (
        <button
          key={t.value}
          type="button"
          className="k-choice-item"
          aria-pressed={value === t.value}
          onClick={() => onChange(t.value)}
        >
          <b>{t.title}</b>
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}

function CountrySelect({ value, onChange }: { value?: string; onChange: (c: string) => void }) {
  return (
    <Select
      showSearch
      allowClear
      value={value || undefined}
      onChange={(v) => onChange(v ?? '')}
      placeholder="Определим по IP сами"
      optionFilterProp="label"
      style={{ width: '100%' }}
      options={COUNTRIES.map((c) => ({ value: c.code, label: `${flagOf(c.code)} ${c.name}` }))}
    />
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="k-field">
      <div className="k-field-label">{label}</div>
      {children}
      {hint && <div className="k-hint">{hint}</div>}
    </div>
  );
}

interface LookForm {
  name: string;
  country: string;
  transport: Transport;
  sni: string;
  port?: number;
}

function LookFields({ v, set, portHint }: { v: LookForm; set: (p: Partial<LookForm>) => void; portHint?: string }) {
  return (
    <>
      <Field label="Название" hint="Так сервер будет называться у пользователей в Happ. Флаг страны добавится сам.">
        <Input value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Германия" />
      </Field>
      <Field label="Страна">
        <CountrySelect value={v.country} onChange={(country) => set({ country })} />
      </Field>
      <Field label="Транспорт">
        <TransportPicker value={v.transport} onChange={(transport) => set({ transport })} />
      </Field>
      <Field
        label="Домен маскировки (SNI)"
        hint="Под какой сайт маскируется трафик. Для российского сервера при жёстких блокировках бери крупный российский сайт, который у оператора не режут."
      >
        <AutoComplete
          value={v.sni}
          onChange={(sni) => set({ sni })}
          options={SNI_SUGGESTIONS.map((s) => ({ value: s }))}
          placeholder="www.microsoft.com"
          style={{ width: '100%' }}
          filterOption={(input, opt) => (opt?.value ?? '').toString().includes(input)}
        />
      </Field>
      <Field label="Порт" hint={portHint ?? 'Пусто — подберём сами: 443, если свободен.'}>
        <InputNumber
          min={1}
          max={65535}
          value={v.port}
          onChange={(port) => set({ port: port ?? undefined })}
          placeholder="авто"
          style={{ width: 140 }}
        />
      </Field>
    </>
  );
}

/** Servers a new one can go through: configured, not routed themselves, not itself. */
function entryServers(all: ServerRow[], selfNodeId?: number) {
  return all.filter((x) => x.configured && !x.viaServerId && x.nodeId !== selfNodeId);
}

/** Default route: through the Russian entry server when there is one. */
function defaultRoute(all: ServerRow[], selfNodeId?: number, selfCountry?: string) {
  if (selfCountry === 'RU') return 'direct';
  const ru = entryServers(all, selfNodeId).find((x) => x.country === 'RU');
  return ru ? `${ru.id}:only` : 'direct';
}

function parseRoute(v: string) {
  if (v === 'direct') return { viaServerId: 0, keepDirect: false };
  const [id, mode] = v.split(':');
  return { viaServerId: Number(id), keepDirect: mode === 'both' };
}

function RouteField({
  all,
  selfNodeId,
  value,
  onChange,
}: {
  all: ServerRow[];
  selfNodeId?: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const entries = entryServers(all, selfNodeId);
  if (entries.length === 0) return null;
  const options = [
    { value: 'direct', label: 'Напрямую', text: 'Пользователь подключается прямо к этому серверу.' },
    ...entries.flatMap((e) => [
      {
        value: `${e.id}:only`,
        label: `Через ${flagOf(e.country)} ${e.name}`.replace('  ', ' '),
        text: `Подключение идёт на ${e.name}: российские сайты открываются оттуда, остальное — с этого сервера.`,
      },
      {
        value: `${e.id}:both`,
        label: `Оба варианта`,
        text: `В подписке будут два пункта: напрямую и через ${e.name}.`,
      },
    ]),
  ];
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <Field label="Маршрут" hint={current.text}>
      <Select
        value={current.value}
        onChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
        style={{ width: '100%' }}
      />
    </Field>
  );
}

function ConnectDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: command } = useNodeInstallCommand();
  const { data: servers = [] } = useServers();
  const [route, setRoute] = useState<string | null>(null);
  const routeNow = route ?? defaultRoute(servers);
  const connect = useKorovaPost<
    {
      key: string;
      name: string;
      country: string;
      look: InboundLook;
      publish: boolean;
      force: boolean;
      viaServerId: number;
      keepDirect: boolean;
    },
    ConnectNodeResult
  >('/nodes/connect');
  const [key, setKey] = useState('');
  const [publish, setPublish] = useState(true);
  const [look, setLook] = useState<LookForm>({ name: '', country: '', transport: 'tcp', sni: '' });
  const [result, setResult] = useState<ConnectNodeResult | null>(null);
  const shownCommand =
    command || 'bash <(curl -fsSL https://github.com/nyartny-ops/korova/releases/download/korova-latest/korova.sh) install node';
  const tunnelCommand = `korova tunnel ${window.location.hostname}`;

  const reset = () => {
    setKey('');
    setResult(null);
    setRoute(null);
    setLook({ name: '', country: '', transport: 'tcp', sni: '' });
  };

  const run = (force: boolean) =>
    connect.mutate(
      {
        key,
        name: look.name,
        country: look.country,
        look: { transport: look.transport, sni: look.sni, port: look.port },
        publish,
        force,
        ...parseRoute(look.country === 'RU' ? 'direct' : routeNow),
      },
      { onSuccess: (r) => setResult(r), onError: () => setResult(null) },
    );

  const copy = async (text: string) => {
    await ClipboardManager.copyText(text);
    getMessage().success('Скопировано');
  };

  const done = result && result.id > 0;

  return (
    <Drawer
      open={open}
      size={560}
      title="Подключить сервер"
      onClose={() => {
        onClose();
        if (done) reset();
      }}
      destroyOnHidden={false}
    >
      {done ? (
        <div className="k-done">
          <div className="k-done-mark" aria-hidden>
            ✓
          </div>
          <h3>{result.published ? `${result.serverName} уже в подписке` : `Сервер ${result.name} подключён`}</h3>
          <p className="k-muted">
            {result.published
              ? 'Пользователям ничего делать не нужно: Happ и Incy подтянут его при следующем обновлении подписки.'
              : result.publishError
                ? `Подключение не создалось: ${result.publishError}. Нажми «Добавить в подписку» у сервера в списке.`
                : 'Чтобы он появился у пользователей, нажми «Добавить в подписку» у сервера в списке.'}
            {!result.reachable && ' Сейчас связи с ним нет — он станет «онлайн», когда она появится.'}
          </p>
          {result.routeError && (
            <Alert
              type="warning"
              showIcon
              style={{ textAlign: 'left', marginBottom: 16 }}
              title="Маршрут не настроился"
              description={`Сервер пока раздаётся напрямую. ${result.routeError}. Маршрут можно выбрать в списке серверов.`}
            />
          )}
          <Button
            type="primary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Готово
          </Button>
          <Button type="text" onClick={reset} style={{ marginLeft: 8 }}>
            Подключить ещё один
          </Button>
        </div>
      ) : (
        <ol className="k-flow">
          <li>
            <div className="k-flow-title">Поставь Korova на новый сервер</div>
            <p className="k-hint">Зайди на него по SSH от root и выполни команду. Через минуту в конце появится ключ.</p>
            <div className="k-copy">
              <span className="k-mono" title={shownCommand}>
                {shownCommand}
              </span>
              <Button size="small" onClick={() => copy(shownCommand)}>
                Копировать
              </Button>
            </div>
          </li>
          <li>
            <div className="k-flow-title">Вставь ключ</div>
            <Input.TextArea
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setResult(null);
              }}
              placeholder="korova-node:eyJ2IjoxLC..."
              autoSize={{ minRows: 3, maxRows: 5 }}
              className="k-mono-input"
              spellCheck={false}
            />
          </li>
          <li>
            <div className="k-flow-title">Как показать пользователям</div>
            <Checkbox checked={publish} onChange={(e) => setPublish(e.target.checked)} style={{ marginBottom: 14 }}>
              Сразу добавить в подписку
            </Checkbox>
            {publish && (
              <>
                <LookFields v={look} set={(p) => setLook((prev) => ({ ...prev, ...p }))} />
                {look.country !== 'RU' && <RouteField all={servers} value={routeNow} onChange={setRoute} />}
              </>
            )}
          </li>
          <li className="k-flow-actions">
            <Button type="primary" size="large" disabled={!key.trim()} loading={connect.isPending} onClick={() => run(false)}>
              Подключить
            </Button>
          </li>
          {result?.needConfirm && (
            <Alert
              type="warning"
              showIcon
              title="Основной сервер не достучался до нового"
              description={
                <>
                  <p className="k-small" style={{ margin: '0 0 10px' }}>
                    {result.probeError}. Чаще всего хостинг нового сервера не пускает входящие соединения (так бывает у
                    российских). Тогда выполни на новом сервере команду ниже, введи root-пароль этого сервера и вставь новый
                    ключ.
                  </p>
                  <div className="k-copy" style={{ background: 'var(--k-surface)', marginBottom: 10 }}>
                    <span className="k-mono">{tunnelCommand}</span>
                    <Button size="small" onClick={() => copy(tunnelCommand)}>
                      Копировать
                    </Button>
                  </div>
                  <Button size="small" onClick={() => run(true)} loading={connect.isPending}>
                    Всё равно сохранить
                  </Button>
                </>
              }
            />
          )}
        </ol>
      )}
    </Drawer>
  );
}

function ServerDrawer({ server, onClose }: { server: ServerRow | null; onClose: () => void }) {
  const update = useKorovaPost<ServerPatch & { id: number }, ServerRow>((b) => `/servers/${b.id}`);
  const publish = useKorovaPost<
    { nodeId: number; name: string; country: string; look: InboundLook; viaServerId: number; keepDirect: boolean },
    ServerRow
  >('/servers/publish');
  const { data: all = [] } = useServers();
  const [route, setRoute] = useState<string | null>(null);
  const remove = useKorovaPost<{ id: number }>((b) => `/servers/${b.id}/del`);
  const [v, setV] = useState<LookForm>({ name: '', country: '', transport: 'tcp', sni: '' });

  useEffect(() => {
    if (server) {
      setV({
        name: server.configured ? server.name : '',
        country: server.country,
        transport: server.transport || 'tcp',
        sni: server.sni,
        port: server.port || undefined,
      });
      setRoute(null);
    }
  }, [server]);

  if (!server) return <Drawer open={false} onClose={onClose} />;
  const routeNow = route ?? defaultRoute(all, server.nodeId, v.country || server.country);
  const via = all.find((x) => x.id === server.viaServerId);

  const save = () => {
    if (server.configured) {
      update.mutate(
        { id: server.id, name: v.name, country: v.country, transport: v.transport, sni: v.sni, port: v.port },
        { onSuccess: onClose },
      );
    } else {
      publish.mutate(
        {
          nodeId: server.nodeId,
          name: v.name,
          country: v.country,
          look: { transport: v.transport, sni: v.sni, port: v.port },
          ...parseRoute(v.country === 'RU' ? 'direct' : routeNow),
        },
        { onSuccess: onClose },
      );
    }
  };

  return (
    <Drawer
      open
      size={520}
      onClose={onClose}
      title={server.configured ? `${flagOf(server.country)} ${server.name}`.trim() : 'Добавить в подписку'}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          {server.configured ? (
            <Popconfirm
              title="Убрать сервер из Korova?"
              description="Его подключение и маршруты удалятся, у пользователей он пропадёт. Сам узел останется в «Узлах»."
              okText="Убрать"
              cancelText="Отмена"
              okButtonProps={{ danger: true }}
              onConfirm={() => remove.mutate({ id: server.id }, { onSuccess: onClose })}
            >
              <Button danger type="text">
                Убрать из Korova
              </Button>
            </Popconfirm>
          ) : (
            <span />
          )}
          <Button type="primary" loading={update.isPending || publish.isPending} onClick={save}>
            {server.configured ? 'Сохранить' : 'Добавить в подписку'}
          </Button>
        </div>
      }
    >
      {server.configured && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          title="Ключи пользователей не меняются"
          description="Новые настройки применятся сразу, а Happ и Incy получат их при обновлении подписки."
        />
      )}
      <LookFields
        v={v}
        set={(p) => setV((prev) => ({ ...prev, ...p }))}
        portHint={server.configured ? `Сейчас ${server.port}.` : undefined}
      />
      {!server.configured && v.country !== 'RU' && (
        <RouteField all={all} selfNodeId={server.nodeId} value={routeNow} onChange={setRoute} />
      )}
      {server.configured && server.viaServerId === 0 && (
        <p className="k-hint">
          Если через этот сервер идут другие (он «вход»), их входы тоже получат эти транспорт и домен.
        </p>
      )}
      {server.configured && (
        <div className="k-field k-advanced">
          <div className="k-field-label">Все настройки</div>
          <p className="k-hint" style={{ marginTop: 0 }}>
            Полный редактор подключения, как в оригинальной 3x-ui: протокол, транспорт, Reality, сниффинг, JSON. Если
            потом сохранить эту форму, Korova перезапишет транспорт, домен и порт — остальное останется.
          </p>
          <div className="k-advanced-actions">
            <FullInboundEditor inboundId={server.inboundId} label="Подключение сервера" />
            {via && server.entryInboundId > 0 && (
              <FullInboundEditor
                inboundId={server.entryInboundId}
                label={`Вход на ${flagOf(via.country)} ${via.name}`.replace('  ', ' ')}
              />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function routeValue(s: ServerRow) {
  if (!s.viaServerId) return 'direct';
  return `${s.viaServerId}:${s.keepDirect ? 'both' : 'only'}`;
}

function ServerCard({ s, all, onOpen }: { s: ServerRow; all: ServerRow[]; onOpen: () => void }) {
  const update = useKorovaPost<ServerPatch & { id: number }, ServerRow>((b) => `/servers/${b.id}`);
  const entries = all.filter((x) => x.configured && x.id !== s.id && !x.viaServerId);
  const tone = s.status === 'online' ? 'good' : s.status === 'offline' ? 'bad' : 'warn';
  const statusText = s.status === 'online' ? 'работает' : s.status === 'offline' ? 'нет связи' : 'проверка';

  const routeOptions = [
    { value: 'direct', label: 'Напрямую' },
    ...entries.flatMap((e) => [
      { value: `${e.id}:only`, label: `Через ${flagOf(e.country)} ${e.name}`.replace('  ', ' ') },
      { value: `${e.id}:both`, label: `Напрямую и через ${e.name}` },
    ]),
  ];

  const setRoute = (v: string) => {
    if (v === 'direct') {
      update.mutate({ id: s.id, viaServerId: 0, keepDirect: false });
      return;
    }
    const [id, mode] = v.split(':');
    update.mutate({ id: s.id, viaServerId: Number(id), keepDirect: mode === 'both' });
  };

  return (
    <article className={`k-srv${s.configured && !s.inSub ? ' is-muted' : ''}`}>
      <div className="k-srv-flag" aria-hidden>
        {flagOf(s.country) || '·'}
      </div>
      <div className="k-srv-main">
        <div className="k-srv-name">
          {s.name}
          <Status tone={tone}>{statusText}</Status>
        </div>
        <div className="k-srv-meta">
          {s.address}
          {s.tunnel && ' · через туннель'}
          {s.configured && ` · ${transportTitle(s.transport)} · порт ${s.port}`}
        </div>
        {s.cascadeError && <div className="k-srv-error">Маршрут не настроился: {s.cascadeError}</div>}
      </div>
      {s.configured ? (
        <div className="k-srv-controls">
          <label className="k-srv-toggle">
            <Switch
              size="small"
              checked={s.inSub}
              loading={update.isPending}
              onChange={(inSub) => update.mutate({ id: s.id, inSub })}
            />
            В подписке
          </label>
          <Select
            size="middle"
            value={routeValue(s)}
            onChange={setRoute}
            options={routeOptions}
            disabled={!s.inSub || update.isPending}
            style={{ width: 196 }}
            popupMatchSelectWidth={false}
            aria-label="Маршрут"
          />
          <Button onClick={onOpen}>Настроить</Button>
        </div>
      ) : (
        <div className="k-srv-controls">
          <Button type="primary" onClick={onOpen}>
            Добавить в подписку
          </Button>
        </div>
      )}
    </article>
  );
}

export default function ServersPage() {
  const navigate = useNavigate();
  const { data: servers = [], isLoading } = useServers();
  const { data: settings } = useKorovaSettings();
  const { data: overview } = useOverview();
  const saveSettings = useKorovaPost<KorovaSettings>('/settings');
  const [connectOpen, setConnectOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const keyOf = (s: ServerRow) => `${s.nodeId}`;
  const opened = useMemo(() => servers.find((s) => keyOf(s) === openId) ?? null, [servers, openId]);
  const visible = servers.filter((s) => s.configured || s.nodeId !== 0);
  const anyConfigured = servers.some((s) => s.configured);

  return (
    <KorovaPage
      title="Серверы"
      lead="Где работает VPN и как до него добираются пользователи. Новый сервер: поставил Korova, вставил ключ — он уже у всех в Happ."
      actions={
        <Button type="primary" onClick={() => setConnectOpen(true)}>
          Подключить сервер
        </Button>
      }
    >
      <div className="k-cols">
        <div className="k-stack">
          <Section
            title="Мои серверы"
            sub="«Через …» — пользователь подключается к российскому серверу: российские сайты открываются с него напрямую, остальные идут на зарубежный."
            flush
          >
            {isLoading ? (
              <div style={{ padding: 20 }}>
                <Skeleton active paragraph={{ rows: 3 }} />
              </div>
            ) : visible.length === 0 ? (
              <div className="k-empty">
                <b>Серверов пока нет</b>
                Подключи первый: установка на сервере занимает минуту.
                <div style={{ marginTop: 14 }}>
                  <Button type="primary" onClick={() => setConnectOpen(true)}>
                    Подключить сервер
                  </Button>
                </div>
              </div>
            ) : (
              <div className="k-srv-list">
                {visible.map((s) => (
                  <ServerCard key={keyOf(s)} s={s} all={servers} onOpen={() => setOpenId(keyOf(s))} />
                ))}
              </div>
            )}
            {!servers.find((s) => s.nodeId === 0)?.configured && anyConfigured && (
              <div className="k-srv-foot">
                Основной сервер тоже можно раздавать пользователям (на порту 8443).{' '}
                <Button type="link" size="small" onClick={() => setOpenId('0')} style={{ padding: 0 }}>
                  Добавить его
                </Button>
              </div>
            )}
          </Section>

          <Collapse
            ghost
            items={[
              {
                key: 'manual',
                label: 'Для опытных: ручные каскады и узлы',
                children: (
                  <div className="k-stack">
                    <p className="k-hint" style={{ marginTop: 0 }}>
                      Всё, что выше, Korova настраивает сама. Здесь можно собрать каскад из любых подключений вручную, а
                      узлы и подключения целиком доступны во{' '}
                      <a onClick={() => navigate('/nodes')}>«Узлах»</a> и{' '}
                      <a onClick={() => navigate('/inbounds')}>«Входящих»</a>.
                    </p>
                    <ManualCascades />
                  </div>
                ),
              },
            ]}
          />
        </div>

        <aside className="k-sticky">
          <p className="k-caption">Так подписка выглядит в Happ и Incy</p>
          <HappPreview
            brand={settings?.brandName ?? 'Korova VPN'}
            bot={overview?.botUsername}
            autoSelect={!!settings?.autoSelect}
            servers={servers}
          />
          {settings && (
            <div className="k-section" style={{ marginTop: 12, padding: '14px 16px' }}>
              <label className="k-srv-toggle" style={{ fontWeight: 600 }}>
                <Switch
                  size="small"
                  checked={settings.autoSelect}
                  loading={saveSettings.isPending}
                  onChange={(autoSelect) => saveSettings.mutate({ ...settings, autoSelect })}
                />
                Автовыбор сервера
              </label>
              <p className="k-hint" style={{ marginBottom: 0 }}>
                Добавляет «⚡ Автовыбор»: Happ и Incy сами берут самый быстрый сервер. Подписка для них переходит в формат
                JSON. Включи и проверь на своём телефоне.
              </p>
            </div>
          )}
        </aside>
      </div>

      <ConnectDrawer open={connectOpen} onClose={() => setConnectOpen(false)} />
      <ServerDrawer server={opened} onClose={() => setOpenId(null)} />
    </KorovaPage>
  );
}
