import {
  CheckCircle2,
  CopyCheck,
  History,
  Link2Off,
  ShieldAlert,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { CheckOutput } from '../api/contract';
import { useDashboard } from '../api/queries';
import { Page } from '../components/layout/Pane';
import { ErrorState, Pill, Skeleton, StatusPill } from '../components/ui/Feedback';
import { GroupedSection, Row, RowText } from '../components/ui/GroupedList';
import { RouterAnchor } from '../components/ui/RouterAnchor';
import { formatDay } from '../lib/format';
import { noteHref, projectNotePath } from '../lib/notes';

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card bg-cell px-4 py-3 shadow-soft ring-1 ring-separator">
      <p className="text-[24px] leading-tight font-semibold tracking-tight text-label tabular-nums">
        {value}
      </p>
      <p className="text-[13px] text-label-secondary">{label}</p>
    </div>
  );
}

function Finding({
  icon: Icon,
  tone,
  children,
  href,
}: {
  icon: LucideIcon;
  tone: 'orange' | 'red' | 'gray';
  children: ReactNode;
  href?: string;
}) {
  const color =
    tone === 'red' ? 'text-red' : tone === 'orange' ? 'text-orange' : 'text-label-secondary';
  return (
    <Row
      leading={<Icon aria-hidden className={`size-[18px] ${color}`} strokeWidth={1.75} />}
      {...(href ? { href } : {})}
    >
      <span className="block text-[14px] leading-snug text-label">{children}</span>
    </Row>
  );
}

function Hygiene({ check }: { check: CheckOutput }) {
  const total =
    check.stale_projects.length +
    check.broken_links.length +
    check.duplicate_topics.length +
    check.suspicious_notes.length +
    check.unsaved_sessions.length;
  if (total === 0) {
    return (
      <GroupedSection title="Hygiene">
        <Row
          leading={
            <CheckCircle2 aria-hidden className="size-[18px] text-green" strokeWidth={1.75} />
          }
        >
          <span className="text-[14px]">Everything looks tidy.</span>
        </Row>
      </GroupedSection>
    );
  }
  return (
    <GroupedSection
      title="Hygiene"
      action={<Pill tone="orange">{total} to review</Pill>}
      footer={check.suggestions.length ? check.suggestions.join(' ') : undefined}
    >
      {check.stale_projects.map((p) => (
        <Finding
          key={`stale-${p.slug}`}
          icon={Timer}
          tone="orange"
          href={noteHref(projectNotePath(p.slug))}
        >
          <strong className="font-medium">{p.title}</strong> hasn’t been updated
          {p.updated ? ` since ${formatDay(p.updated)}` : ' in a while'}.
        </Finding>
      ))}
      {check.unsaved_sessions.map((s) => (
        <Finding key={`unsaved-${s.id}`} icon={History} tone="orange">
          A session{s.project ? ` on ${s.project}` : ''} opened {formatDay(s.opened_at)} was never
          saved.
        </Finding>
      ))}
      {check.broken_links.map((l) => (
        <Finding
          key={`broken-${l.from}-${l.target}`}
          icon={Link2Off}
          tone="gray"
          href={noteHref(l.from)}
        >
          Broken link <code className="font-mono text-[13px]">[[{l.target}]]</code> in{' '}
          <span className="text-label-secondary">{l.from}</span>
        </Finding>
      ))}
      {check.duplicate_topics.map((d) => (
        <Finding key={`dup-${d.a}-${d.b}`} icon={CopyCheck} tone="gray" href={noteHref(d.a)}>
          <span className="text-label-secondary">{d.a}</span> and{' '}
          <span className="text-label-secondary">{d.b}</span> look like duplicates ({d.reason}).
        </Finding>
      ))}
      {check.suspicious_notes.map((n) => (
        <Finding
          key={`sus-${n.path}-${n.reason}`}
          icon={ShieldAlert}
          tone="red"
          href={noteHref(n.path)}
        >
          <span className="text-label-secondary">{n.path}</span> {n.reason}. Agents treat it as
          data, but you may want to review it.
        </Finding>
      ))}
    </GroupedSection>
  );
}

export function TodayPage() {
  const dashboard = useDashboard();
  const now = new Date();
  const subtitle = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <Page title={greeting(now)} subtitle={subtitle} width="lg">
      {dashboard.isPending ? (
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton lines={5} />
          <Skeleton lines={5} />
        </div>
      ) : dashboard.isError ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : (
        <>
          <div
            className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
            aria-label="Stats"
            role="group"
          >
            <Stat label="Notes" value={dashboard.data.stats.notes} />
            <Stat label="Topics" value={dashboard.data.stats.topics} />
            <Stat label="Decisions" value={dashboard.data.stats.decisions} />
            <Stat label="Sessions" value={dashboard.data.stats.sessions} />
          </div>

          <div className="grid gap-x-8 lg:grid-cols-2">
            <div>
              <GroupedSection
                title="Active projects"
                action={
                  <RouterAnchor
                    href="/projects"
                    className="text-[13px] text-accent-text hover:underline"
                  >
                    See all
                  </RouterAnchor>
                }
              >
                {dashboard.data.projects.length === 0 ? (
                  <Row>
                    <span className="text-[14px] text-label-secondary">No active projects.</span>
                  </Row>
                ) : (
                  dashboard.data.projects.map((p) => (
                    <Row
                      key={p.slug}
                      href={noteHref(projectNotePath(p.slug))}
                      trailing={<StatusPill status={p.status} />}
                    >
                      <RowText
                        title={p.title}
                        subtitle={p.next ? `Next: ${p.next}` : 'No next step recorded'}
                      />
                    </Row>
                  ))
                )}
              </GroupedSection>

              <GroupedSection title="Recent decisions">
                {dashboard.data.recent_decisions.length === 0 ? (
                  <Row>
                    <span className="text-[14px] text-label-secondary">No decisions yet.</span>
                  </Row>
                ) : (
                  dashboard.data.recent_decisions.map((d) => (
                    <Row key={d.id} href={noteHref(d.path)}>
                      <RowText
                        title={d.title}
                        meta={
                          <>
                            <span className="font-mono">{d.id}</span> · {formatDay(d.date)}
                            {d.project ? ` · ${d.project}` : ''}
                          </>
                        }
                      />
                    </Row>
                  ))
                )}
              </GroupedSection>
            </div>

            <div>
              <GroupedSection title="Recent sessions">
                {dashboard.data.recent_sessions.length === 0 ? (
                  <Row>
                    <span className="text-[14px] text-label-secondary">No sessions yet.</span>
                  </Row>
                ) : (
                  dashboard.data.recent_sessions.map((s) => (
                    <Row key={s.id} href={noteHref(s.path)}>
                      <RowText
                        title={s.summary}
                        meta={`${formatDay(s.date)}${s.project ? ` · ${s.project}` : ''}`}
                      />
                    </Row>
                  ))
                )}
              </GroupedSection>

              <Hygiene check={dashboard.data.check} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
