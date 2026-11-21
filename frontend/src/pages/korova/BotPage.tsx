import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Modal, Radio, Select, Skeleton, Switch } from 'antd';
import { useNavigate } from 'react-router';

import KorovaPage, { Row, Section, Status } from '@/components/korova/KorovaPage';
import { TgWelcome } from '@/components/korova/TgPreview';
import {
  useInboundOptions,
  useKorovaPost,
  useKorovaSettings,
  useOverview,
  type InboundOption,
  type KorovaSettings,
  type Mode,
} from '@/components/korova/api';

function groupByServer(list: InboundOption[]) {
  const groups = new Map<string, InboundOption[]>();
  for (const ib of list) {
    const key = ib.nodeName || 'Основной сервер';
    groups.set(key, [...(groups.get(key) ?? []), ib]);
  }
  return [...groups.entries()];
}

export default function BotPage() {
  const navigate = useNavigate();
  const { data: remote, isLoading } = useKorovaSettings();
  const { data: inbounds = [] } = useInboundOptions();
  const { data: overview } = useOverview();
  const save = useKorovaPost<KorovaSettings>('/settings');
  const restart = useKorovaPost<Record<string, never>>('/bot/restart');
  const [s, setS] = useState<KorovaSettings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [modal, holder] = Modal.useModal();

  // Server data wins until the admin edits something; after save or reset it wins again.
  useEffect(() => {
    if (remote && !dirty) setS(remote);
  }, [remote, dirty]);

  const set = <K extends keyof KorovaSettings>(k: K, v: KorovaSettings[K]) => {
    setDirty(true);
    setS((p) => (p ? { ...p, [k]: v } : p));
  };

  const chooseMode = (m: Mode) => {
    if (!s || m === s.mode) return;
    if (m === 'paid' && remote?.mode !== 'paid') {
      modal.confirm({
        title: 'Включить платную подписку?',
        content:
          'После сохранения у всех, кто пользуется бесплатно по приглашению, доступ закончится. Бот напишет им и предложит выбрать тариф. Оплаченные подписки не затронет.',
        okText: 'Включить',
        cancelText: 'Отмена',
        onOk: () => set('mode', m),
      });
      return;
    }
    set('mode', m);
  };

  if (isLoading || !s) {
    return (
      <KorovaPage title="Бот и доступ">
        <Skeleton active paragraph={{ rows: 12 }} />
      </KorovaPage>
    );
  }

  const toggleInbound = (id: number, on: boolean) =>
    set('inboundIds', on ? [...new Set([...s.inboundIds, id])] : s.inboundIds.filter((x) => x !== id));

  const botStatus = overview?.botRunning ? (
    <Status tone="good">@{overview.botUsername} работает</Status>
  ) : (
    <Status tone="bad">бот выключен</Status>
  );

  return (
    <KorovaPage title="Бот и доступ" lead="Кто может пользоваться VPN, через какие серверы и что говорит бот.">
      {holder}
      <div className="k-cols">
        <div className="k-stack">
          <Section title="Режим доступа">
            <div className="k-choice" role="radiogroup" aria-label="Режим доступа">
              <button
                type="button"
                className="k-choice-item"
                aria-pressed={s.mode === 'invite'}
                onClick={() => chooseMode('invite')}
              >
                <b>По приглашениям</b>
                <span>Только по промокоду или ссылке от администратора. Покупка в боте скрыта.</span>
              </button>
              <button
                type="button"
                className="k-choice-item"
                aria-pressed={s.mode === 'paid'}
                onClick={() => chooseMode('paid')}
              >
                <b>Платная подписка</b>
                <span>Бот продаёт тарифы за звёзды. Бесплатные приглашения перестают работать.</span>
              </button>
            </div>
          </Section>

          <Section title="Telegram-бот" extra={botStatus} flush>
            {overview?.botError && (
              <div style={{ padding: '16px 20px 0' }}>
                <Alert type="error" showIcon title={overview.botError} />
              </div>
            )}
            <Row label="Токен" hint="Выдаёт @BotFather. Хранится только на сервере.">
              <Input.Password
                value={s.botToken}
                onChange={(e) => set('botToken', e.target.value)}
                placeholder="123456789:AA…"
                autoComplete="off"
              />
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                  <Switch checked={s.botEnabled} onChange={(v) => set('botEnabled', v)} />
                  Бот включён
                </label>
                <Button size="small" type="text" loading={restart.isPending} onClick={() => restart.mutate({})}>
                  Перезапустить
                </Button>
              </div>
              <div className="k-hint">
                Не включай встроенного бота 3x-ui на этом же токене: два бота на одном токене мешают друг другу.
              </div>
            </Row>
            <Row label="Администраторы" hint="Username через запятую, без @. Им в боте доступна админка и приглашения.">
              <Input value={s.adminUsernames} onChange={(e) => set('adminUsernames', e.target.value)} placeholder="TheArtemy" />
            </Row>
            <Row label="Поддержка" hint="Куда ведёт кнопка «Поддержка». Пусто — в чат с первым администратором.">
              <Input value={s.supportUrl} onChange={(e) => set('supportUrl', e.target.value)} placeholder="https://t.me/TheArtemy" />
            </Row>
            <Row label="Название">
              <Input value={s.brandName} onChange={(e) => set('brandName', e.target.value)} />
            </Row>
          </Section>

          <Section
            title="Подписка"
            sub="Каждый подписчик получает одну ссылку и свой ключ на каждом сервере."
            flush
          >
            <Row label="Серверы" hint="Добавляй и убирай серверы на странице «Серверы» — подписка обновится сама.">
              <Button onClick={() => navigate('/korova/servers')}>Открыть «Серверы»</Button>
              <Collapse
                ghost
                size="small"
                style={{ marginTop: 8, marginLeft: -16 }}
                items={[
                  {
                    key: 'manual',
                    label: `Вручную: отмечено подключений — ${s.inboundIds.length}`,
                    children: (
                      <div>
              {inbounds.length === 0 ? (
                <Alert
                  type="info"
                  showIcon
                  title="Подключений пока нет. Создай его во «Входящих», например VLESS + Reality."
                />
              ) : (
                groupByServer(inbounds).map(([server, list]) => (
                  <div key={server} style={{ marginBottom: 12 }}>
                    <div className="k-small" style={{ fontWeight: 600, color: 'var(--k-ink-2)', marginBottom: 4 }}>
                      {server}
                    </div>
                    {list.map((ib) => (
                      <div key={ib.id} style={{ padding: '4px 0' }}>
                        <Checkbox
                          checked={s.inboundIds.includes(ib.id)}
                          onChange={(e) => toggleInbound(ib.id, e.target.checked)}
                        >
                          {ib.remark || ib.tag}{' '}
                          <span className="k-muted">
                            {ib.protocol} · {ib.port}
                            {!ib.enable && ' · выключен'}
                          </span>
                        </Checkbox>
                      </div>
                    ))}
                  </div>
                ))
              )}
                      </div>
                    ),
                  },
                ]}
              />
            </Row>
            <Row
              label="Оформление в Happ и Incy"
              hint="Название подписки, кнопка «Поддержка», объявление и сообщение об окончании подписки берутся из бота."
            >
              <label style={{ display: 'inline-flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
                <Switch checked={s.manageSubLook} onChange={(v) => set('manageSubLook', v)} />
                Оформлять автоматически
              </label>
            </Row>
            <Row
              label="Адрес подписки"
              hint="Начало ссылки, к которому бот добавит ID подписчика. Путь совпадает с путём подписки в настройках панели."
            >
              <Input value={s.subBase} onChange={(e) => set('subBase', e.target.value)} placeholder="https://sub.korova.pro/…/" />
            </Row>
            <Row label="Как считать устройства">
              <Radio.Group value={s.deviceMode} onChange={(e) => set('deviceMode', e.target.value)}>
                <div style={{ display: 'grid', gap: 10 }}>
                  <Radio value="hwid">
                    По устройству
                    <div className="k-hint" style={{ marginTop: 2 }}>
                      Точнее всего. Работает в Happ и Incy, приложения без ID устройства подписку не получат.
                    </div>
                  </Radio>
                  <Radio value="ip">
                    По IP-адресам
                    <div className="k-hint" style={{ marginTop: 2 }}>
                      Подходит любым приложениям, но мобильный интернет часто меняет IP.
                    </div>
                  </Radio>
                  <Radio value="both">
                    Оба способа
                    <div className="k-hint" style={{ marginTop: 2 }}>
                      Самый строгий вариант.
                    </div>
                  </Radio>
                </div>
              </Radio.Group>
            </Row>
          </Section>

          <Section title="Пробный период и напоминания" flush>
            <Row label="Пробный период" hint="Только в платном режиме, один раз на человека. 0 — выключен.">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <InputNumber
                  min={0}
                  max={30}
                  value={s.trialDays}
                  onChange={(v) => set('trialDays', Number(v) || 0)}
                  suffix="дн."
                  style={{ width: 120 }}
                />
                <InputNumber
                  min={1}
                  max={10}
                  value={s.trialDevices}
                  onChange={(v) => set('trialDevices', Number(v) || 1)}
                  suffix="устр."
                  style={{ width: 120 }}
                />
              </div>
            </Row>
            <Row label="Напоминать" hint="За сколько дней до окончания бот напишет подписчику.">
              <Select
                mode="multiple"
                style={{ width: '100%', maxWidth: 320 }}
                value={s.remindDays}
                onChange={(v: number[]) => set('remindDays', [...v].sort((a, b) => b - a))}
                options={[7, 5, 3, 2, 1].map((n) => ({ value: n, label: `за ${n} дн.` }))}
              />
            </Row>
          </Section>

          <Section title="Тексты бота" flush>
            <Row label="Приветствие" hint="Для тех, у кого ещё нет доступа.">
              <Input.TextArea autoSize={{ minRows: 2 }} value={s.welcomeText} onChange={(e) => set('welcomeText', e.target.value)} />
            </Row>
            <Row label="Режим приглашений" hint="Добавляется к приветствию, пока покупка выключена.">
              <Input.TextArea
                autoSize={{ minRows: 2 }}
                value={s.inviteOnlyText}
                onChange={(e) => set('inviteOnlyText', e.target.value)}
              />
            </Row>
            <Row label="Подписка закончилась" hint="Бот отправит в день окончания.">
              <Input.TextArea autoSize={{ minRows: 2 }} value={s.expiredText} onChange={(e) => set('expiredText', e.target.value)} />
            </Row>
          </Section>
        </div>

        <aside className="k-sticky">
          <p className="k-caption">Так бот выглядит для нового человека</p>
          <TgWelcome s={s} />
        </aside>
      </div>

      {dirty && (
        <div className="k-savebar" role="status">
          Есть несохранённые изменения
          <Button size="small" type="text" style={{ color: 'inherit' }} onClick={() => setDirty(false)}>
            Отменить
          </Button>
          <Button
            size="small"
            loading={save.isPending}
            onClick={() => save.mutate(s, { onSuccess: () => setDirty(false) })}
          >
            Сохранить
          </Button>
        </div>
      )}
    </KorovaPage>
  );
}
