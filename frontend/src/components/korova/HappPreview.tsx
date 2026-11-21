import { flagOf, type ServerRow } from './api';

interface Props {
  brand: string;
  bot?: string;
  autoSelect: boolean;
  servers: ServerRow[];
}

// What the subscription renders as in Happ/Incy; mirrors applyServerSubscription.
export function subscriptionEntries(servers: ServerRow[]): string[] {
  const byId = new Map(servers.map((s) => [s.id, s]));
  const out: string[] = [];
  for (const s of servers) {
    if (!s.configured || !s.inSub) continue;
    const name = `${flagOf(s.country)} ${s.name}`.trim();
    const via = s.viaServerId ? byId.get(s.viaServerId) : undefined;
    if (via && s.entryInboundId) {
      out.push(`${name} · через ${via.name}`);
      if (s.keepDirect) out.push(name);
    } else {
      out.push(name);
    }
  }
  return out;
}

export default function HappPreview({ brand, bot, autoSelect, servers }: Props) {
  const entries = subscriptionEntries(servers);
  const rows = autoSelect && entries.length > 1 ? ['⚡ Автовыбор', ...entries] : entries;
  return (
    <div className="k-happ" role="img" aria-label="Предпросмотр подписки в Happ">
      <div className="k-happ-head">
        <div className="k-happ-title">{brand || 'Korova VPN'}</div>
        <div className="k-happ-meta">До 12 декабря · 3 устройства</div>
        {bot && <div className="k-happ-announce">Продлить подписку или добавить устройство — в боте @{bot}</div>}
      </div>
      <ul className="k-happ-list">
        {rows.length === 0 ? (
          <li className="k-happ-empty">Серверов в подписке пока нет</li>
        ) : (
          rows.map((r, i) => (
            <li key={r} className={`k-happ-row${i === 0 ? ' is-active' : ''}`}>
              <span className="k-happ-radio" aria-hidden />
              <span className="k-happ-name">{r}</span>
              <span className="k-happ-ping">{i === 0 && r.startsWith('⚡') ? 'лучший' : `${38 + i * 17} мс`}</span>
            </li>
          ))
        )}
      </ul>
      <div className="k-happ-foot">Когда подписка закончится: «⛔ Подписка закончилась · продли в {bot ? `@${bot}` : 'боте'}»</div>
    </div>
  );
}
