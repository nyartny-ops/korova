import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { HttpUtil } from '@/utils';

const BASE = '/panel/api/korova';

export type Mode = 'invite' | 'paid';
export type Access = 'none' | 'free' | 'paid';

export interface KorovaSettings {
  brandName: string;
  mode: Mode;
  botToken: string;
  botTokenSet?: boolean;
  botEnabled: boolean;
  adminUsernames: string;
  adminIds: number[];
  supportUrl: string;
  subBase: string;
  inboundIds: number[];
  deviceMode: 'hwid' | 'ip' | 'both';
  trialDays: number;
  trialDevices: number;
  remindDays: number[];
  welcomeText: string;
  inviteOnlyText: string;
  expiredText: string;
  happEnabled: boolean;
  incyEnabled: boolean;
  autoSelect: boolean;
  manageSubLook: boolean;
}

export interface DayPoint {
  day: string;
  stars: number;
  newSubs: number;
}

export interface NodeBrief {
  id: number;
  name: string;
  address: string;
  status: string;
  latencyMs: number;
  cpuPct: number;
  memPct: number;
  xrayState: string;
}

export interface Overview {
  mode: Mode;
  botRunning: boolean;
  botUsername: string;
  botError: string;
  users: number;
  active: number;
  paid: number;
  free: number;
  expired: number;
  expiringSoon: number;
  new7d: number;
  online: number;
  stars30d: number;
  starsTotal: number;
  payments30d: number;
  series: DayPoint[];
  nodes: NodeBrief[] | null;
  serversReady: boolean;
  subBaseReady: boolean;
  plansReady: boolean;
}

export interface Subscriber {
  id: number;
  tgId: number;
  username: string;
  firstName: string;
  access: Access;
  devices: number;
  expiresAt: number;
  clientEmail: string;
  subId: string;
  planId: number;
  invitedBy: string;
  note: string;
  banned: boolean;
  trialUsed: boolean;
  spentStars: number;
  lastSeenAt: number;
  createdAt: number;
  active: boolean;
  up: number;
  down: number;
  lastOnline: number;
  online: boolean;
  subUrl: string;
}

export interface Plan {
  id?: number;
  title: string;
  devices: number;
  days: number;
  priceStars: number;
  active: boolean;
  featured: boolean;
  sort: number;
}

export interface Promo {
  id?: number;
  code: string;
  kind: 'days' | 'free';
  days: number;
  devices: number;
  maxUses: number;
  uses?: number;
  expiresAt: number;
  active: boolean;
  note: string;
  createdAt?: number;
}

export interface Payment {
  id: number;
  tgId: number;
  planTitle: string;
  stars: number;
  days: number;
  devices: number;
  createdAt: number;
}

export interface InboundOption {
  id: number;
  remark: string;
  protocol: string;
  port: number;
  enable: boolean;
  nodeId: number;
  nodeName: string;
  tag: string;
}

export interface Cascade {
  id: number;
  name: string;
  entryNodeId: number;
  entryInboundId: number;
  entryTag: string;
  exitNodeId: number;
  exitInboundId: number;
  outboundTag: string;
  clientEmail: string;
  directRu: boolean;
  status: string;
  lastError: string;
  createdAt: number;
}

async function getObj<T>(path: string, params?: Record<string, string>): Promise<T> {
  const msg = await HttpUtil.get<T>(BASE + path, params, { silent: true });
  if (!msg.success) throw new Error(msg.msg || 'Не удалось загрузить данные');
  return msg.obj as T;
}

export const kq = {
  overview: ['korova', 'overview'] as const,
  settings: ['korova', 'settings'] as const,
  inbounds: ['korova', 'inbounds'] as const,
  users: (q: string, f: string) => ['korova', 'users', q, f] as const,
  plans: ['korova', 'plans'] as const,
  promos: ['korova', 'promos'] as const,
  payments: ['korova', 'payments'] as const,
  cascades: ['korova', 'cascades'] as const,
};

export const useOverview = () =>
  useQuery({ queryKey: kq.overview, queryFn: () => getObj<Overview>('/overview'), refetchInterval: 15000 });
export const useKorovaSettings = () =>
  useQuery({
    queryKey: kq.settings,
    queryFn: async () => {
      const s = await getObj<KorovaSettings>('/settings');
      return { ...s, inboundIds: s.inboundIds ?? [], adminIds: s.adminIds ?? [], remindDays: s.remindDays ?? [] };
    },
  });
export const useInboundOptions = () =>
  useQuery({ queryKey: kq.inbounds, queryFn: async () => (await getObj<InboundOption[] | null>('/inbounds')) ?? [] });
export const useSubscribers = (q: string, filter: string) =>
  useQuery({
    queryKey: kq.users(q, filter),
    queryFn: async () => (await getObj<Subscriber[] | null>('/users', { q, filter })) ?? [],
    refetchInterval: 20000,
  });
export const usePlans = () =>
  useQuery({ queryKey: kq.plans, queryFn: async () => (await getObj<Plan[] | null>('/plans')) ?? [] });
export const usePromos = () =>
  useQuery({ queryKey: kq.promos, queryFn: async () => (await getObj<Promo[] | null>('/promos')) ?? [] });
export const usePayments = () =>
  useQuery({ queryKey: kq.payments, queryFn: async () => (await getObj<Payment[] | null>('/payments')) ?? [] });
export const useCascades = () =>
  useQuery({ queryKey: kq.cascades, queryFn: async () => (await getObj<Cascade[] | null>('/cascades')) ?? [] });

// Every write invalidates all Korova queries: the screens are small and
// counts on the overview depend on almost every change.
export function useKorovaPost<TBody = unknown, TObj = unknown>(path: string | ((b: TBody) => string)) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TBody) => {
      const url = BASE + (typeof path === 'function' ? path(body) : path);
      const msg = await HttpUtil.post<TObj>(url, body ?? {}, { headers: { 'Content-Type': 'application/json' } });
      if (!msg.success) throw new Error(msg.msg);
      return msg.obj as TObj;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['korova'] }),
  });
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function fmtDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const days = (n: number) => plural(n, 'день', 'дня', 'дней');
export const devices = (n: number) => plural(n, 'устройство', 'устройства', 'устройств');

export function daysLeft(ms: number): number {
  return Math.ceil((ms - Date.now()) / 86400000);
}

export function inviteLink(botUsername: string | undefined, code: string): string {
  return botUsername ? `https://t.me/${botUsername}?start=${code}` : code;
}

export interface ConnectNodeResult {
  id: number;
  name: string;
  address: string;
  reachable: boolean;
  probeError: string;
  needConfirm: boolean;
  published: boolean;
  serverName: string;
  publishError: string;
  routeError: string;
}

export const useNodeInstallCommand = () =>
  useQuery({
    queryKey: ['korova', 'node-install-command'],
    queryFn: async () => (await getObj<{ command: string }>('/nodes/install-command')).command,
    staleTime: Infinity,
  });

export type Transport = 'tcp' | 'xhttp' | 'grpc';

export interface InboundLook {
  transport?: Transport;
  sni?: string;
  port?: number;
}

export interface ServerRow {
  id: number;
  nodeId: number;
  name: string;
  country: string;
  transport: Transport;
  sni: string;
  inboundId: number;
  inSub: boolean;
  viaServerId: number;
  keepDirect: boolean;
  entryInboundId: number;
  cascadeId: number;
  configured: boolean;
  flag: string;
  address: string;
  status: string;
  latencyMs: number;
  tunnel: boolean;
  port: number;
  entryPort: number;
  viaName: string;
  cascadeError: string;
}

export interface ServerPatch {
  name?: string;
  country?: string;
  transport?: Transport;
  sni?: string;
  port?: number;
  inSub?: boolean;
  viaServerId?: number;
  keepDirect?: boolean;
}

export const useServers = () =>
  useQuery({
    queryKey: ['korova', 'servers'],
    queryFn: async () => (await getObj<ServerRow[] | null>('/servers')) ?? [],
    refetchInterval: 15000,
  });

export const COUNTRIES: { code: string; name: string }[] = [
  { code: 'RU', name: 'Россия' },
  { code: 'DE', name: 'Германия' },
  { code: 'NL', name: 'Нидерланды' },
  { code: 'FI', name: 'Финляндия' },
  { code: 'SE', name: 'Швеция' },
  { code: 'FR', name: 'Франция' },
  { code: 'GB', name: 'Великобритания' },
  { code: 'PL', name: 'Польша' },
  { code: 'LV', name: 'Латвия' },
  { code: 'EE', name: 'Эстония' },
  { code: 'LT', name: 'Литва' },
  { code: 'CH', name: 'Швейцария' },
  { code: 'AT', name: 'Австрия' },
  { code: 'TR', name: 'Турция' },
  { code: 'KZ', name: 'Казахстан' },
  { code: 'AE', name: 'ОАЭ' },
  { code: 'US', name: 'США' },
  { code: 'JP', name: 'Япония' },
  { code: 'SG', name: 'Сингапур' },
];

export function flagOf(code?: string): string {
  const c = (code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export const TRANSPORTS: { value: Transport; title: string; text: string }[] = [
  { value: 'tcp', title: 'TCP + Vision', text: 'Самый быстрый. Для зарубежных серверов, пока у пользователей всё работает.' },
  { value: 'xhttp', title: 'XHTTP', text: 'Лучше проходит блокировки в России. Рекомендуем для российского сервера-входа.' },
  { value: 'grpc', title: 'gRPC', text: 'Запасной вариант, если первые два у кого-то не работают.' },
];

export const SNI_SUGGESTIONS = [
  'www.microsoft.com',
  'www.apple.com',
  'dl.google.com',
  'www.yahoo.com',
  'ya.ru',
  'vk.com',
  'www.ozon.ru',
];
