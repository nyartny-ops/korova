import type { ReactNode } from 'react';

import { KorovaMark } from './Spots';
import { days, devices, type KorovaSettings, type Plan } from './api';

type Btn = { text: string; tone?: 'primary' | 'success' };

function Keyboard({ rows }: { rows: Btn[][] }) {
  return (
    <div className="k-tg-kb">
      {rows.map((row, i) => (
        <div className="k-tg-kb-row" key={i}>
          {row.map((b) => (
            <span key={b.text} className={`k-tg-btn${b.tone ? ` is-${b.tone}` : ''}`}>
              {b.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Frame({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="k-tg" role="img" aria-label="Предпросмотр сообщения бота">
      <div className="k-tg-top">
        <KorovaMark size={32} />
        <span>
          <b>{name || 'Korova VPN'}</b>
          <span>бот</span>
        </span>
      </div>
      <div className="k-tg-chat">{children}</div>
    </div>
  );
}

// Mirrors bot.go: menu() for a user without access, and plans().
export function TgWelcome({ s }: { s: Pick<KorovaSettings, 'brandName' | 'mode' | 'welcomeText' | 'inviteOnlyText' | 'trialDays'> }) {
  const rows: Btn[][] =
    s.mode === 'paid'
      ? [
          [{ text: 'Выбрать тариф', tone: 'primary' }],
          ...(s.trialDays > 0 ? [[{ text: `Попробовать ${days(s.trialDays)} бесплатно` }]] : []),
          [{ text: 'У меня есть промокод' }],
          [{ text: 'Как подключиться' }, { text: 'Поддержка' }],
        ]
      : [[{ text: 'Ввести промокод', tone: 'primary' }], [{ text: 'Как подключиться' }, { text: 'Поддержка' }]];
  return (
    <Frame name={s.brandName}>
      <div className="k-tg-msg">
        <strong>{s.brandName}</strong>
        {'\n\n'}
        {s.welcomeText}
        {s.mode !== 'paid' && `\n\n${s.inviteOnlyText}`}
      </div>
      <Keyboard rows={rows} />
    </Frame>
  );
}

export function TgPlans({ brand, plans }: { brand: string; plans: Plan[] }) {
  const visible = plans.filter((p) => p.active);
  return (
    <Frame name={brand}>
      <div className="k-tg-msg">
        <strong>Тарифы</strong>
        {'\n'}Оплата звёздами Telegram. Дни добавляются к текущей подписке.
      </div>
      <Keyboard
        rows={[
          ...visible.map((p) => [
            {
              text: `${p.title} · ${devices(p.devices)} · ${days(p.days)} — ${p.priceStars} ★`,
              tone: p.featured ? ('primary' as const) : undefined,
            },
          ]),
          [{ text: 'Назад' }],
        ]}
      />
    </Frame>
  );
}
