import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import { ApiContext } from '../api/context';
import { createMockApi } from '../api/mock';

/**
 * Renders `ui` inside the same providers the app uses (API, Query, Router, Tooltip), backed by a
 * fresh in-memory mock API with no latency.
 */
export function renderWithProviders(ui: ReactNode, opts: { api?: ApiClient; path?: string } = {}) {
  const api = opts.api ?? createMockApi().api;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [opts.path ?? '/'] }),
  });
  const result = render(
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={queryClient}>
        <Tooltip.Provider>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any -- test router is not the registered app router */}
          <RouterProvider router={router as any} />
        </Tooltip.Provider>
      </QueryClientProvider>
    </ApiContext.Provider>,
  );
  return { ...result, api, queryClient, router };
}
