import { useState } from 'react';
import { Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Radio, Switch, Table, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import type { Dayjs } from 'dayjs';

import KorovaPage, { Section, Status } from '@/components/korova/KorovaPage';
import { TgPlans } from '@/components/korova/TgPreview';
import { ClipboardManager } from '@/utils';
import { getMessage } from '@/utils/messageBus';
import {
  days,
  devices,
  fmtDate,
  inviteLink,
  useKorovaPost,
  useKorovaSettings,
  useOverview,
  usePayments,
  usePlans,
  usePromos,
  type Payment,
  type Plan,
  type Promo,
} from '@/components/korova/api';

const EMPTY_PLAN: Plan = { title: '', devices: 1, days: 30, priceStars: 99, active: true, featured: false, sort: 0 };
const EMPTY_PROMO: Promo = { code: '', kind: 'free', days: 30, devices: 1, maxUses: 1, expiresAt: 0, active: true, note: '' };

function PlanModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [form] = Form.useForm<Plan>();
  const save = useKorovaPost<Plan, Plan>('/plans');
  return (
    <Modal
      open
      title={plan.id ? 'Изменить тариф' : 'Новый тариф'}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={async () => {
        const v = await form.validateFields();
        const ok = await save
          .mutateAsync({ ...plan, ...v })
          .then(() => true)
          .catch(() => false);
        if (ok) onClose();
      }}
    >
      <Form form={form} layout="vertical" initialValues={plan} requiredMark={false} style={{ marginTop: 16 }}>
        <Form.Item name="title" label="Название" extra="Видно на кнопке в боте. Пусто — соберём из устройств и срока.">
          <Input placeholder="Например, Дуэт" />
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Form.Item name="devices" label="Устройства" rules={[{ required: true, message: 'Нужно число' }]}>
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="days" label="Дней" rules={[{ required: true, message: 'Нужно число' }]}>
            <InputNumber min={1} max={3650} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="priceStars" label="Цена, ★" rules={[{ required: true, message: 'Нужна цена' }]}>
            <InputNumber min={1} max={100000} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <Form.Item name="active" label="Продаётся" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="featured" label="Выделить синим" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="sort" label="Порядок" tooltip="Меньше — выше в списке">
            <InputNumber min={0} style={{ width: 90 }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

type PromoForm = Promo & { expires?: Dayjs | null };

function PromoModal({ onClose, botUsername }: { onClose: () => void; botUsername?: string }) {
  const [form] = Form.useForm<PromoForm>();
  const save = useKorovaPost<Promo, Promo>('/promos');
  const kind = Form.useWatch('kind', form) ?? 'free';
  return (
    <Modal
      open
      title="Новый промокод"
      okText="Создать и скопировать ссылку"
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={onClose}
      onOk={async () => {
        const { expires, ...v } = await form.validateFields();
        const p = await save
          .mutateAsync({ ...EMPTY_PROMO, ...v, expiresAt: expires ? expires.endOf('day').valueOf() : 0 })
          .catch(() => null);
        if (!p) return;
        await ClipboardManager.copyText(inviteLink(botUsername, p.code));
        getMessage().success(botUsername ? 'Ссылка-приглашение скопирована' : 'Код скопирован');
        onClose();
      }}
    >
      <Form form={form} layout="vertical" initialValues={EMPTY_PROMO} requiredMark={false} style={{ marginTop: 16 }}>
        <Form.Item
          name="kind"
          label="Что даёт"
          extra={
            kind === 'days'
              ? 'Добавляет дни к подписке. Работает в любом режиме.'
              : 'Бессрочный бесплатный доступ. Перестаёт работать, когда включишь платную подписку.'
          }
        >
          <Radio.Group
            optionType="button"
            options={[
              { label: 'Бесплатный доступ', value: 'free' },
              { label: 'Дни подписки', value: 'days' },
            ]}
          />
        </Form.Item>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          {kind === 'days' && (
            <Form.Item name="days" label="Дней" rules={[{ required: true, message: 'Нужно число' }]}>
              <InputNumber min={1} max={3650} style={{ width: '100%' }} />
            </Form.Item>
          )}
          <Form.Item name="devices" label="Устройства">
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="maxUses" label="Активаций">
            <InputNumber min={1} max={100000} style={{ width: '100%' }} />
          </Form.Item>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 180px', gap: 12 }}>
          <Form.Item name="code" label="Код" extra="Пусто — сгенерируем вида MOO-X7K2PQ.">
            <Input placeholder="FRIENDS" />
          </Form.Item>
          <Form.Item name="expires" label="Действует до">
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} placeholder="Без срока" />
          </Form.Item>
        </div>
        <Form.Item name="note" label="Для кого" style={{ marginBottom: 0 }}>
          <Input placeholder="Например, для Маши" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function PlansPage() {
  const { data: plans = [], isLoading } = usePlans();
  const { data: promos = [], isLoading: promosLoading } = usePromos();
  const { data: payments = [] } = usePayments();
  const { data: overview } = useOverview();
  const { data: settings } = useKorovaSettings();
  const [editPlan, setEditPlan] = useState<Plan | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const delPlan = useKorovaPost<{ id: number }>((b) => `/plans/${b.id}/del`);
  const delPromo = useKorovaPost<{ id: number }>((b) => `/promos/${b.id}/del`);
  const savePromo = useKorovaPost<Promo, Promo>('/promos');
  const bot = overview?.botUsername;

  const copyPromo = async (code: string) => {
    await ClipboardManager.copyText(inviteLink(bot, code));
    getMessage().success(bot ? 'Ссылка-приглашение скопирована' : 'Код скопирован');
  };

  const promoCols: TableColumnsType<Promo> = [
    {
      title: 'Код',
      dataIndex: 'code',
      render: (c: string, p) => (
        <span>
          <b className="k-mono" style={{ fontSize: 13 }}>
            {c}
          </b>
          {p.note && <div className="k-muted k-small">{p.note}</div>}
        </span>
      ),
    },
    {
      title: 'Даёт',
      key: 'gives',
      render: (_, p) => (
        <span>
          {p.kind === 'free' ? 'Бесплатный доступ' : `+${days(p.days)}`}
          <div className="k-muted k-small">{devices(p.devices)}</div>
        </span>
      ),
    },
    {
      title: 'Активации',
      key: 'uses',
      render: (_, p) => {
        const used = p.uses ?? 0;
        const expired = p.expiresAt > 0 && p.expiresAt < Date.now();
        if (!p.active) return <Status>выключен</Status>;
        if (used >= p.maxUses) return <Status>использован</Status>;
        if (expired) return <Status tone="warn">истёк</Status>;
        return (
          <span className="k-num">
            {used} из {p.maxUses}
            {p.expiresAt > 0 && <div className="k-muted k-small">до {fmtDate(p.expiresAt)}</div>}
          </span>
        );
      },
    },
    {
      title: 'Вкл.',
      dataIndex: 'active',
      width: 70,
      render: (a: boolean, p) => (
        <Switch
          size="small"
          checked={a}
          aria-label="Промокод активен"
          onChange={(v) => savePromo.mutate({ ...p, active: v })}
        />
      ),
    },
    {
      title: '',
      key: 'a',
      align: 'right',
      render: (_, p) => (
        <span style={{ display: 'inline-flex', gap: 2 }}>
          <Button size="small" type="text" onClick={() => copyPromo(p.code)}>
            Скопировать ссылку
          </Button>
          <Popconfirm title="Удалить промокод?" okText="Удалить" cancelText="Отмена" onConfirm={() => delPromo.mutate({ id: p.id! })}>
            <Button size="small" type="text" danger>
              Удалить
            </Button>
          </Popconfirm>
        </span>
      ),
    },
  ];

  const payCols: TableColumnsType<Payment> = [
    { title: 'Дата', dataIndex: 'createdAt', render: (ms: number) => <span className="k-num">{fmtDate(ms)}</span> },
    { title: 'Telegram ID', dataIndex: 'tgId', render: (n: number) => <span className="k-num">{n}</span> },
    { title: 'Тариф', dataIndex: 'planTitle' },
    { title: 'Сумма', dataIndex: 'stars', align: 'right', render: (n: number) => <b className="k-num">{n} ★</b> },
  ];

  return (
    <KorovaPage
      title="Тарифы и промокоды"
      lead="Тарифы отличаются числом устройств и сроком. Оплата звёздами Telegram прямо в боте, без договоров и эквайринга."
      actions={
        <Button type="primary" onClick={() => setPromoOpen(true)}>
          Создать промокод
        </Button>
      }
    >
      <div className="k-cols">
        <div className="k-stack">
          <Section
            title="Тарифы"
            sub={
              overview?.mode === 'paid'
                ? 'Бот показывает включённые тарифы всем.'
                : 'Сейчас режим приглашений: тарифы видят только те, у кого уже была платная подписка.'
            }
            extra={<Button onClick={() => setEditPlan({ ...EMPTY_PLAN })}>Добавить</Button>}
            flush
          >
            {isLoading ? null : plans.length === 0 ? (
              <div className="k-empty">
                <b>Тарифов нет</b>
                Добавь хотя бы один, чтобы бот мог продавать подписку.
              </div>
            ) : (
              plans.map((p) => (
                <div key={p.id} className={`k-plan${p.active ? '' : ' is-off'}`}>
                  <div>
                    <b>{p.title}</b>
                    {p.featured && (
                      <span style={{ marginLeft: 8 }}>
                        <Status tone="accent">выделен</Status>
                      </span>
                    )}
                    {!p.active && (
                      <span style={{ marginLeft: 8 }}>
                        <Status>скрыт</Status>
                      </span>
                    )}
                    <div className="k-muted k-small">
                      {devices(p.devices)} · {days(p.days)}
                    </div>
                  </div>
                  <Tooltip title={`≈ ${Math.round(p.priceStars / Math.max(1, p.days / 30))} ★ в месяц`}>
                    <span className="k-plan-price">{p.priceStars} ★</span>
                  </Tooltip>
                  <Button size="small" type="text" onClick={() => setEditPlan(p)}>
                    Изменить
                  </Button>
                  <Popconfirm
                    title="Удалить тариф?"
                    description="Купленные подписки останутся как есть."
                    okText="Удалить"
                    cancelText="Отмена"
                    onConfirm={() => delPlan.mutate({ id: p.id! })}
                  >
                    <Button size="small" type="text" danger>
                      Удалить
                    </Button>
                  </Popconfirm>
                </div>
              ))
            )}
          </Section>

          <Section
            title="Промокоды и приглашения"
            sub="Ссылка открывает бота и сразу применяет код. Удобно отправить человеку в личку."
            flush
          >
            <Table<Promo>
              rowKey="id"
              loading={promosLoading}
              columns={promoCols}
              dataSource={promos}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ x: 640 }}
              locale={{
                emptyText: (
                  <div className="k-empty">
                    <b>Промокодов пока нет</b>
                    Создай приглашение — бот выдаст доступ по ссылке.
                  </div>
                ),
              }}
            />
          </Section>

          <Section title="Последние оплаты" flush>
            <Table<Payment>
              rowKey="id"
              size="small"
              columns={payCols}
              dataSource={payments}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              locale={{ emptyText: <div className="k-empty">Оплат ещё не было.</div> }}
            />
          </Section>
        </div>

        <aside className="k-sticky">
          <p className="k-caption">Так тарифы выглядят в боте</p>
          <TgPlans brand={settings?.brandName ?? 'Korova VPN'} plans={plans} />
        </aside>
      </div>

      {editPlan && <PlanModal plan={editPlan} onClose={() => setEditPlan(null)} />}
      {promoOpen && <PromoModal onClose={() => setPromoOpen(false)} botUsername={bot} />}
    </KorovaPage>
  );
}
