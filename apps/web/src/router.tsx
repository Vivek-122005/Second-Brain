import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { BookOpen, FileText, History, Inbox, Scale, type LucideIcon } from 'lucide-react';
import type { NoteType } from './api/contract';
import { AppShell } from './components/layout/AppShell';
import { EmptyState, ErrorState } from './components/ui/Feedback';
import { RouterAnchor } from './components/ui/RouterAnchor';
import type { SectionPath } from './lib/notes';
import { DevicePage } from './routes/Device';
import { NotesSection, type NoteSearch } from './routes/NotesSection';
import { ProjectsPage, type ProjectFilter, type ProjectsSearch } from './routes/Projects';
import { SearchPage, type SearchPageSearch } from './routes/Search';
import { SettingsPage } from './routes/Settings';
import { SignInPage } from './routes/SignIn';
import { TodayPage } from './routes/Today';
import { KeysPage } from './routes/Keys';

// Search params arrive untyped from the URL (TanStack may JSON-parse numbers); coerce defensively.
function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function noteSearch(s: Record<string, unknown>): NoteSearch {
  return {
    path: str(s.path),
    mode: s.mode === 'edit' ? 'edit' : undefined,
    project: str(s.project),
  };
}

function NotFound() {
  return (
    <div className="flex min-h-dvh flex-1">
      <EmptyState
        icon={FileText}
        title="Page not found"
        action={
          <RouterAnchor href="/" className="text-accent-text">
            Go to Today
          </RouterAnchor>
        }
      >
        There is nothing at this address.
      </EmptyState>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
  errorComponent: ({ error, reset }) => (
    <div className="flex min-h-dvh flex-1">
      <ErrorState error={error} onRetry={reset} />
    </div>
  ),
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-in',
  validateSearch: (s: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: str(s.redirect),
  }),
  component: function SignInRoute() {
    const { redirect } = signInRoute.useSearch();
    return <SignInPage redirect={redirect} />;
  },
});

const deviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/device',
  validateSearch: (s: Record<string, unknown>): { code?: string | undefined } => ({
    code: str(s.code),
  }),
  component: function DeviceRoute() {
    const { code } = deviceRoute.useSearch();
    return <DevicePage code={code} />;
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppShell,
});

const todayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: TodayPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  validateSearch: (s: Record<string, unknown>): ProjectsSearch => ({
    status: (['active', 'paused', 'done'] as ProjectFilter[]).includes(s.status as ProjectFilter)
      ? (s.status as ProjectFilter)
      : undefined,
    path: str(s.path),
    mode: s.mode === 'edit' ? 'edit' : undefined,
  }),
  component: function ProjectsRoute() {
    return <ProjectsPage search={projectsRoute.useSearch()} />;
  },
});

function sectionRoute(
  path: SectionPath,
  title: string,
  type: NoteType | undefined,
  icon: LucideIcon,
  emptyText: string,
) {
  const route = createRoute({
    getParentRoute: () => appRoute,
    path,
    validateSearch: noteSearch,
    component: function SectionRoute() {
      const search = route.useSearch();
      return (
        <NotesSection
          section={path}
          title={title}
          {...(type ? { type } : {})}
          icon={icon}
          emptyText={emptyText}
          search={search}
        />
      );
    },
  });
  return route;
}

const topicsRoute = sectionRoute(
  '/topics',
  'Topics',
  'topic',
  BookOpen,
  'Topics collect what you know about a subject. Agents add to them as you work.',
);
const decisionsRoute = sectionRoute(
  '/decisions',
  'Decisions',
  'decision-log',
  Scale,
  'Decision logs record what was decided, when and why, one log per project.',
);
const sessionsRoute = sectionRoute(
  '/sessions',
  'Sessions',
  'session',
  History,
  'Each time an assistant saves its work, a session log appears here.',
);
const inboxRoute = sectionRoute(
  '/inbox',
  'Inbox',
  'note',
  Inbox,
  'Quick notes land here. Press ⌘N to capture one.',
);
const allNotesRoute = sectionRoute(
  '/notes',
  'All notes',
  undefined,
  FileText,
  'Your vault is empty.',
);

const searchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/search',
  validateSearch: (s: Record<string, unknown>): SearchPageSearch => ({
    q: str(s.q),
    types: str(s.types),
  }),
  component: function SearchRoute() {
    return <SearchPage search={searchRoute.useSearch()} />;
  },
});

const keysRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/keys',
  component: KeysPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  signInRoute,
  deviceRoute,
  appRoute.addChildren([
    todayRoute,
    projectsRoute,
    topicsRoute,
    decisionsRoute,
    sessionsRoute,
    inboxRoute,
    allNotesRoute,
    searchRoute,
    keysRoute,
    settingsRoute,
  ]),
]);

export function createAppRouter() {
  return createRouter({
    routeTree,
    defaultPreload: false,
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
