import { useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ConfigProvider, Layout, message } from 'antd';

import { useTheme } from '@/hooks/useTheme';
import { setMessageInstance } from '@/utils/messageBus';
import AppSidebar from '@/layouts/AppSidebar';
import '@/styles/korova.css';

interface Props {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export default function KorovaPage({ title, lead, actions, children }: Props) {
  const { isDark, antdThemeConfig } = useTheme();
  const [messageApi, messageHolder] = message.useMessage();
  useEffect(() => {
    setMessageInstance(messageApi);
  }, [messageApi]);

  return (
    <ConfigProvider theme={antdThemeConfig}>
      {messageHolder}
      <Layout className={`korova-page${isDark ? ' is-dark' : ''}`}>
        <AppSidebar />
        <Layout className="content-shell">
          <Layout.Content id="content-layout" className="content-area">
            <div className="k-wrap">
              <header className="k-head">
                <div>
                  <h1 className="k-title">{title}</h1>
                  {lead && <p className="k-lead">{lead}</p>}
                </div>
                {actions && <div className="k-actions">{actions}</div>}
              </header>
              {children}
            </div>
          </Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

interface SectionProps {
  title?: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  bare?: boolean;
  flush?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

export function Section({ title, sub, extra, bare, flush, children, style }: SectionProps) {
  return (
    <section className="k-section" style={style}>
      {(title || extra) && (
        <div className={`k-section-head${bare ? ' is-bare' : ''}`}>
          <div>
            {title && <h2 className="k-section-title">{title}</h2>}
            {sub && <p className="k-section-sub">{sub}</p>}
          </div>
          {extra}
        </div>
      )}
      <div className={`k-section-body${flush ? ' is-flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="k-row">
      <div className="k-row-label">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Avatar({ name, online, large }: { name: string; online?: boolean; large?: boolean }) {
  const letter = (name.replace(/^@/, '').trim()[0] || '?').toUpperCase();
  return (
    <span className={`k-avatar${large ? ' is-lg' : ''}`} data-online={online ? 'true' : 'false'} aria-hidden>
      {letter}
    </span>
  );
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral';

export function Status({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`k-status${tone === 'neutral' ? '' : ` is-${tone}`}`}>{children}</span>;
}
