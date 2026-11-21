import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Popconfirm, Segmented, Skeleton, Table, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { CheckOutlined } from '@ant-design/icons';

import KorovaPage, { Avatar, Section, Status } from '@/components/korova/KorovaPage';
import { ClipboardManager } from '@/utils';
import { getMessage } from '@/utils/messageBus';
import {
  daysLeft,
  inviteLink,
  plural,
  useKorovaPost,
  useOverview,
  usePlans,
  useSubscribers,
  type DayPoint,
  type NodeBrief,
  type Overview,
  type Promo,
} from '@/components/korova/api';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const dayLabel = (day: string) => {
  const [, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
const fmt = (n: number) => n.toLocaleString('ru-RU');

function Setup({ o }: { o: Overview }) {
  const navigate = useNavigate();
  const steps = [
    { done: o.serversReady, title: 'Выбери серверы', text: 'Какие подключения получат подписчики', to: '/korova/bot' },
    { done: o.subBaseReady, title: 'Адрес подписки', text: 'Ссылка, которую вставляют в Happ', to: '/korova/bot' },
    { done: o.botRunning, title: 'Запусти бота', text: o.botError || 'Вставь токен от @BotFather', to: '/korova/bot' },
    { done: o.plansReady, title: 'Проверь тарифы', text: 'Цены в звёздах и устройства', to: '/korova/plans' },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <nav className="k-setup" aria-label="Шаги запуска">
      {steps.map((s, i) => (
        <button key={s.title} type="button" className={`k-setup-step${s.done ? ' is-done' : ''}`} onClick={() => navigate(s.to)}>
          <span className="k-setup-num" aria-hidden>
            {s.done ? <CheckOutlined style={{ fontSize: 11 }} /> : i + 1}
          </span>
          <span>
            <b>{s.title}</b>
            <span className="k-setup-text">{s.done ? 'Готово' : s.text}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}

function Bars({ series, field }: { series: DayPoint[]; field: 'stars' | 'newSubs' }) {
  const peak = Math.max(1, ...series.map((d) => d[field]));
  const unit = (n: number) => (field === 'stars' ? `${fmt(n)} ★` : plural(n, 'подписчик', 'подписчика', 'подписчиков'));
  return (
    <>
      <div className="k-chart" role="img" aria-label={field === 'stars' ? 'Звёзды по дням' : 'Новые подписчики по дням'}>
        {series.map((d) => (
          <Tooltip key={d.day} title={`${dayLabel(d.day)}: ${unit(d[field])}`} mouseEnterDelay={0}>
            <span className="k-bar-hit" tabIndex={0} aria-label={`${dayLabel(d.day)}: ${unit(d[field])}`}>
              <span className="k-bar" style={{ height: `${(d[field] / peak) * 100}%` }} />
            </span>
          </Tooltip>
        ))}
      </div>
      <div className="k-chart-axis">
        <span>{series[0] && dayLabel(series[0].day)}</span>
        <span>сегодня</span>
      </div>
    </>
  );
}

function ExpiringSoon() {
  const { data = [], isLoading } = useSubscribers('', 'soon');
  const { data: plans = [] } = usePlans();
  const act = useKorovaPost<{ id: number; action: string; days: number }>((b) => `/users/${b.id}/action`);
  const planTitle = (id: number) => plans.find((p) => p.id === id)?.title;
  const when = (ms: number) => {
    const d = daysLeft(ms);
    return d <= 1 ? 'завтра' : `через ${plural(d, 'день', 'дня', 'дней')}`;
  };
  return (
    <Section title="Скоро закончится" sub="Подписка истекает в ближайшие 3 дня" flush>
      {isLoading ? (
        <div style={{ padding: 20 }}>
          <Skeleton active paragraph={{ rows: 2 }} title={false} />
        </div>
      ) : data.length === 0 ? (
        <div className="k-empty">Ни у кого подписка не заканчивается в ближайшие дни.</div>
      ) : (
        <ul className="k-list">
          {data.slice(0, 6).map((u) => (
            <li className="k-list-row" key={u.id}>
              <Avatar name={u.username || u.firstName} online={u.online} />
              <span className="k-list-main">
                <b>{u.username ? `@${u.username}` : u.firstName || u.tgId}</b>
                <span>
                  {when(u.expiresAt)}
                  {planTitle(u.planId) ? ` · ${planTitle(u.planId)}` : ''}
                </span>
              </span>
              <Popconfirm
                title="Продлить на 30 дней?"
                okText="Продлить"
                cancelText="Отмена"
                onConfirm={() => act.mutate({ id: u.id, action: 'extend', days: 30 })}
              >
                <Button size="small">Продлить</Button>
              </Popconfirm>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const nodeColumns: TableColumnsType<NodeBrief> = [
  {
    title: 'Сервер',
    key: 'name',
    render: (_, n) => (
      <span>
        <b>{n.name}</b> <span className="k-muted">· {n.address}</span>
      </span>
    ),
  },
  {
    title: 'Состояние',
    dataIndex: 'status',
    render: (s: string) =>
      s === 'online' ? (
        <Status tone="good">работает</Status>
      ) : s === 'offline' ? (
        <Status tone="bad">недоступен</Status>
      ) : (
        <Status tone="warn">проверка</Status>
      ),
  },
  {
    title: 'Задержка',
    dataIndex: 'latencyMs',
    align: 'right',
    render: (v: number, n) => <span className="k-num">{n.status === 'online' && n.id !== 0 ? `${v} мс` : '—'}</span>,
  },
  {
    title: 'CPU',
    dataIndex: 'cpuPct',
    align: 'right',
    render: (v: number, n) => <span className="k-num">{n.status === 'online' && n.id !== 0 ? `${Math.round(v)}%` : '—'}</span>,
  },
  {
    title: 'Память',
    dataIndex: 'memPct',
    align: 'right',
    render: (v: number, n) => <span className="k-num">{n.status === 'online' && n.id !== 0 ? `${Math.round(v)}%` : '—'}</span>,
  },
];

export default function OverviewPage() {
  const navigate = useNavigate();
  const { data: o, isLoading, error } = useOverview();
  const [metric, setMetric] = useState<'stars' | 'newSubs'>('stars');
  const createPromo = useKorovaPost<Promo, Promo>('/promos');
  const total30 = useMemo(() => (o?.series ?? []).reduce((acc, d) => acc + d[metric], 0), [o?.series, metric]);

  const invite = async () => {
    const free = o?.mode !== 'paid';
    const p = await createPromo
      .mutateAsync({
        code: '',
        kind: free ? 'free' : 'days',
        days: free ? 0 : 30,
        devices: 1,
        maxUses: 1,
        expiresAt: 0,
        active: true,
        note: 'Приглашение с обзора',
      })
      .catch(() => null);
    if (!p) return;
    await ClipboardManager.copyText(inviteLink(o?.botUsername, p.code));
    getMessage().success('Ссылка-приглашение скопирована. Отправь её человеку в Telegram.');
  };

  const lead = o && (
    <>
      {o.mode === 'paid' ? 'Платная подписка' : 'Доступ по приглашениям'}
      {' · '}
      {o.botRunning ? (
        <>
          бот <b>@{o.botUsername}</b> работает
        </>
      ) : (
        'бот выключен'
      )}
    </>
  );

  return (
    <KorovaPage
      title="Обзор"
      lead={lead}
      actions={
        <>
          <Button onClick={() => navigate('/korova/subscribers')}>Подписчики</Button>
          <Button type="primary" loading={createPromo.isPending} onClick={invite}>
            Пригласить человека
          </Button>
        </>
      }
    >
      {error && <Alert type="error" showIcon title={(error as Error).message} style={{ marginBottom: 20 }} />}
      {isLoading || !o ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <>
          <Setup o={o} />

          <div className="k-ledger">
            <div className="k-ledger-cell is-hero">
              <div className="k-ledger-label">С доступом</div>
              <div className="k-ledger-value">{fmt(o.active)}</div>
              <div className="k-ledger-note">+{o.new7d} новых за неделю</div>
            </div>
            <div className="k-ledger-cell">
              <div className="k-ledger-label">Сейчас онлайн</div>
              <div className="k-ledger-value">{fmt(o.online)}</div>
            </div>
            <div className="k-ledger-cell">
              <div className="k-ledger-label">Платные</div>
              <div className="k-ledger-value">{fmt(o.paid)}</div>
            </div>
            <div className="k-ledger-cell">
              <div className="k-ledger-label">По приглашению</div>
              <div className="k-ledger-value">{fmt(o.free)}</div>
            </div>
            <div className="k-ledger-cell">
              <div className="k-ledger-label">Истекли</div>
              <div className="k-ledger-value">{fmt(o.expired)}</div>
            </div>
          </div>

          <div className="k-cols" style={{ marginTop: 20 }}>
            <Section
              bare
              title={metric === 'stars' ? 'Доход за 30 дней' : 'Новые подписчики за 30 дней'}
              extra={
                <Segmented
                  size="small"
                  value={metric}
                  onChange={(v) => setMetric(v as 'stars' | 'newSubs')}
                  options={[
                    { label: 'Звёзды', value: 'stars' },
                    { label: 'Подписчики', value: 'newSubs' },
                  ]}
                />
              }
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                <span className="k-big">{metric === 'stars' ? `${fmt(total30)} ★` : fmt(total30)}</span>
                <span className="k-muted k-small">
                  {metric === 'stars'
                    ? `${plural(o.payments30d, 'оплата', 'оплаты', 'оплат')} · всего ${fmt(o.starsTotal)} ★`
                    : `всего ${fmt(o.users)} в боте`}
                </span>
              </div>
              <Bars series={o.series} field={metric} />
            </Section>
            <ExpiringSoon />
          </div>

          <Section
            title="Серверы"
            flush
            style={{ marginTop: 20 }}
            extra={
              <Button type="text" size="small" onClick={() => navigate('/korova/servers')}>
                Добавить сервер
              </Button>
            }
          >
            <Table<NodeBrief>
              rowKey="id"
              size="middle"
              columns={nodeColumns}
              dataSource={[
                {
                  id: 0,
                  name: 'Основной',
                  address: 'панель, бот, подписки',
                  status: 'online',
                  latencyMs: 0,
                  cpuPct: 0,
                  memPct: 0,
                  xrayState: '',
                },
                ...(o.nodes ?? []),
              ]}
              pagination={false}
              scroll={{ x: 620 }}
            />
          </Section>
        </>
      )}
    </KorovaPage>
  );
}
