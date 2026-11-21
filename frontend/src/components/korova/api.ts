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
  useQuery({ queryKey: kq.settings, queryFn: () => getObj<KorovaSettings>('/settings') });
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
