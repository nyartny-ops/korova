import { useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Input, Modal, Popconfirm, Segmented, Table } from 'antd';
import type { TableColumnsType } from 'antd';

import KorovaPage, { Avatar, Status, type Tone } from '@/components/korova/KorovaPage';
import { ClipboardManager, SizeFormatter } from '@/utils';
import { getMessage } from '@/utils/messageBus';
import {
  days,
  daysLeft,
  devices,
  fmtDate,
  usePlans,
  useKorovaPost,
  useSubscribers,
  type Subscriber,
} from '@/components/korova/api';

const FILTERS = [
  { label: 'Все', value: '' },
  { label: 'С доступом', value: 'active' },
  { label: 'Приглашения', value: 'free' },
  { label: 'Истекают', value: 'soon' },
  { label: 'Истекли', value: 'expired' },
  { label: 'Без доступа', value: 'new' },
  { label: 'Заблокированы', value: 'banned' },
];

const who = (u: Subscriber) => (u.username ? `@${u.username}` : u.firstName || `id ${u.tgId}`);

function statusOf(u: Subscriber): [Tone, string] {
  if (u.banned) return ['bad', 'Заблокирован'];
  if (u.access === 'free') return ['info', 'Приглашение'];
  if (u.access === 'paid' && u.active) {
    return daysLeft(u.expiresAt) <= 3 ? ['warn', 'Скоро истекает'] : ['good', 'Подписка'];
  }
  if (u.access === 'paid') return ['bad', 'Истекла'];
  return ['neutral', 'Без доступа'];
}

function Until({ u }: { u: Subscriber }) {
  if (u.access === 'free') return <span>бессрочно</span>;
  if (!u.expiresAt) return <span className="k-muted">—</span>;
  const left = daysLeft(u.expiresAt);
  return (
    <span className="k-num">
      {fmtDate(u.expiresAt)}
      {left > 0 && <div className="k-muted k-small">через {days(left)}</div>}
    </span>
  );
}

interface ActionBody {
  id: number;
  action: string;
  days?: number;
  devices?: number;
  note?: string;
}

function Detail({ u, onClose }: { u: Subscriber; onClose: () => void }) {
  const act = useKorovaPost<ActionBody, Subscriber>((b) => `/users/${b.id}/action`);
  const del = useKorovaPost<{ id: number }>((b) => `/users/${b.id}/del`);
  const { data: plans = [] } = usePlans();
  const [dev, setDev] = useState(Math.max(u.devices, 1));
  const [note, setNote] = useState(u.note);
  const run = (b: Omit<ActionBody, 'id'>) => act.mutate({ id: u.id, ...b });
  const [tone, label] = statusOf(u);
  const plan = plans.find((p) => p.id === u.planId);

  useEffect(() => setDev(Math.max(u.devices, 1)), [u.devices]);

  return (
    <div>
      <div className="k-block">
        <dl className="k-dl">
          <dt>Статус</dt>
          <dd>
            <Status tone={tone}>{label}</Status>
          </dd>
          <dt>Действует до</dt>
          <dd>
            {u.access === 'free' ? 'бессрочно' : fmtDate(u.expiresAt)}
            {u.access === 'paid' && daysLeft(u.expiresAt) > 0 && (
              <span className="k-muted"> · {days(daysLeft(u.expiresAt))}</span>
            )}
          </dd>
          {plan && (
            <>
              <dt>Тариф</dt>
              <dd>{plan.title}</dd>
            </>
          )}
          <dt>Устройства</dt>
          <dd>{devices(Math.max(u.devices, 1))}</dd>
          <dt>Трафик</dt>
          <dd>{SizeFormatter.sizeFormat(u.up + u.down)}</dd>
          <dt>Последнее подключение</dt>
          <dd>{u.online ? 'сейчас' : u.lastOnline ? fmtDate(u.lastOnline) : 'ещё не было'}</dd>
          <dt>Оплачено</dt>
          <dd>{u.spentStars ? `${u.spentStars} ★` : '—'}</dd>
          {u.invitedBy && (
            <>
              <dt>Промокод</dt>
              <dd className="k-mono">{u.invitedBy}</dd>
            </>
          )}
        </dl>
      </div>

      {u.subUrl && (
        <div className="k-block">
          <h3 className="k-block-title">Ссылка подписки</h3>
          <div className="k-copy">
            <span className="k-mono" title={u.subUrl}>
              {u.subUrl}
            </span>
            <Button
              size="small"
              onClick={async () => {
                await ClipboardManager.copyText(u.subUrl);
                getMessage().success('Ссылка скопирована');
              }}
            >
              Копировать
            </Button>
          </div>
        </div>
      )}

      <div className="k-block">
        <h3 className="k-block-title">Продлить</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[7, 30, 90, 365].map((d) => (
            <Button key={d} size="small" disabled={act.isPending} onClick={() => run({ action: 'extend', days: d })}>
              {d === 365 ? '+ год' : `+${days(d)}`}
            </Button>
          ))}
        </div>
        <div className="k-hint">Дни добавляются к оставшемуся сроку. Приглашённый станет платным подписчиком.</div>
      </div>

      <div className="k-block">
        <h3 className="k-block-title">Устройства</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="k-stepper">
            <button type="button" aria-label="Меньше" disabled={dev <= 1} onClick={() => setDev(dev - 1)}>
              −
            </button>
            <output aria-live="polite">{dev}</output>
            <button type="button" aria-label="Больше" disabled={dev >= 20} onClick={() => setDev(dev + 1)}>
              +
            </button>
          </span>
          {dev !== Math.max(u.devices, 1) && (
            <Button type="primary" size="small" onClick={() => run({ action: 'devices', devices: dev })}>
              Сохранить
            </Button>
          )}
        </div>
      </div>

      <div className="k-block">
        <h3 className="k-block-title">Заметка</h3>
        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder="Видна только в панели"
        />
        {note !== u.note && (
          <Button size="small" style={{ marginTop: 8 }} onClick={() => run({ action: 'note', note })}>
            Сохранить заметку
          </Button>
        )}
      </div>

      <div className="k-block" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {u.access !== 'free' && <Button onClick={() => run({ action: 'free', devices: dev })}>Дать бесплатный доступ</Button>}
        {(u.active || u.access === 'free') && (
          <Popconfirm
            title="Забрать доступ?"
            description="Вместо серверов у человека появится «Продлите подписку»."
            okText="Забрать"
            cancelText="Отмена"
            onConfirm={() => run({ action: 'revoke' })}
          >
            <Button>Забрать доступ</Button>
          </Popconfirm>
        )}
        {u.banned ? (
          <Button onClick={() => run({ action: 'unban' })}>Разблокировать</Button>
        ) : (
          <Popconfirm
            title="Заблокировать?"
            description="Бот перестанет выдавать доступ этому человеку."
            okText="Заблокировать"
            cancelText="Отмена"
            okButtonProps={{ danger: true }}
            onConfirm={() => run({ action: 'ban' })}
          >
            <Button danger>Заблокировать</Button>
          </Popconfirm>
        )}
        <Popconfirm
          title="Удалить подписчика?"
          description="Его ключи удалятся со всех серверов."
          okText="Удалить"
          cancelText="Отмена"
          okButtonProps={{ danger: true }}
          onConfirm={async () => {
            await del.mutateAsync({ id: u.id }).catch(() => null);
            onClose();
          }}
        >
          <Button danger type="text">
            Удалить
          </Button>
        </Popconfirm>
      </div>
    </div>
  );
}

function Broadcast({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const [audience, setAudience] = useState('active');
  const send = useKorovaPost<{ text: string; audience: string }>('/broadcast');
  return (
    <Modal
      open={open}
      title="Сообщение подписчикам"
      okText="Отправить"
      cancelText="Отмена"
      confirmLoading={send.isPending}
      okButtonProps={{ disabled: !text.trim() }}
      onCancel={onClose}
      onOk={async () => {
        const ok = await send
          .mutateAsync({ text, audience })
          .then(() => true)
          .catch(() => false);
        if (ok) {
          setText('');
          onClose();
        }
      }}
    >
      <div style={{ display: 'grid', gap: 12 }}>
        <div>
          <div className="k-small k-muted" style={{ marginBottom: 6 }}>
            Кому
          </div>
          <Segmented
            value={audience}
            onChange={(v) => setAudience(String(v))}
            options={[
              { label: 'С доступом', value: 'active' },
              { label: 'Истекли', value: 'expired' },
              { label: 'Без доступа', value: 'new' },
              { label: 'Всем', value: '' },
            ]}
          />
        </div>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder="Например: сегодня в 3:00 обновим серверы, связь пропадёт на пару минут"
          maxLength={3500}
          showCount
        />
      </div>
    </Modal>
  );
}

export default function SubscribersPage() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [bcOpen, setBcOpen] = useState(false);
  const { data = [], isLoading } = useSubscribers(search, filter);
  const sync = useKorovaPost<Record<string, never>>('/sync');
  const opened = useMemo(() => data.find((u) => u.id === openId) ?? null, [data, openId]);

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const columns: TableColumnsType<Subscriber> = [
    {
      title: 'Подписчик',
      key: 'who',
      render: (_, u) => (
        <div className="k-who">
          <Avatar name={u.username || u.firstName} online={u.online} />
          <span className="k-who-text">
            <b>{who(u)}</b>
            <span>{u.note || (u.username ? u.firstName : `id ${u.tgId}`)}</span>
          </span>
        </div>
      ),
    },
    {
      title: 'Статус',
      key: 'status',
      render: (_, u) => {
        const [tone, label] = statusOf(u);
        return <Status tone={tone}>{label}</Status>;
      },
    },
    { title: 'Действует до', key: 'until', render: (_, u) => <Until u={u} />, sorter: (a, b) => a.expiresAt - b.expiresAt },
    { title: 'Устройства', dataIndex: 'devices', align: 'right', render: (n: number) => <span className="k-num">{Math.max(n, 1)}</span> },
    {
      title: 'Трафик',
      key: 'traffic',
      align: 'right',
      sorter: (a, b) => a.up + a.down - (b.up + b.down),
      render: (_, u) => <span className="k-num">{SizeFormatter.sizeFormat(u.up + u.down)}</span>,
    },
    {
      title: 'Оплачено',
      dataIndex: 'spentStars',
      align: 'right',
      sorter: (a, b) => a.spentStars - b.spentStars,
      render: (n: number) => <span className="k-num">{n ? `${n} ★` : '—'}</span>,
    },
  ];

  return (
    <KorovaPage
      title="Подписчики"
      lead="Все, кто открывал бота. Нажми на человека, чтобы продлить, поменять лимит устройств или забрать доступ."
      actions={
        <>
          <Button loading={sync.isPending} onClick={() => sync.mutate({})}>
            Синхронизировать серверы
          </Button>
          <Button type="primary" onClick={() => setBcOpen(true)}>
            Написать всем
          </Button>
        </>
      }
    >
      <section className="k-section">
        <div className="k-toolbar">
          <div className="k-scroll-x">
            <Segmented value={filter} onChange={(v) => setFilter(String(v))} options={FILTERS} />
          </div>
          <Input.Search
            allowClear
            placeholder="Имя, username, ID или заметка"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 300, maxWidth: '100%' }}
          />
        </div>
        <Table<Subscriber>
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={data}
          scroll={{ x: 760 }}
          pagination={{ pageSize: 25, showSizeChanger: false, hideOnSinglePage: true }}
          onRow={(u) => ({
            onClick: () => setOpenId(u.id),
            onKeyDown: (e) => e.key === 'Enter' && setOpenId(u.id),
            tabIndex: 0,
            style: { cursor: 'pointer' },
          })}
          locale={{
            emptyText: (
              <div className="k-empty">
                <b>{search || filter ? 'Никого не нашли' : 'Пока никого'}</b>
                {search || filter
                  ? 'Попробуй другой фильтр или запрос.'
                  : 'Отправь ссылку на бота или приглашение с экрана «Обзор».'}
              </div>
            ),
          }}
        />
      </section>

      <Drawer
        open={!!opened}
        size={460}
        onClose={() => setOpenId(null)}
        destroyOnHidden
        title={
          opened && (
            <div className="k-drawer-head">
              <Avatar name={opened.username || opened.firstName} online={opened.online} large />
              <div>
                <div className="k-drawer-name">{who(opened)}</div>
                <div className="k-muted k-small" style={{ fontWeight: 400 }}>
                  {[opened.username ? opened.firstName : '', opened.tgId, opened.online ? 'онлайн' : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          )
        }
      >
        {opened && <Detail key={opened.id} u={opened} onClose={() => setOpenId(null)} />}
      </Drawer>
      <Broadcast open={bcOpen} onClose={() => setBcOpen(false)} />
    </KorovaPage>
  );
}
