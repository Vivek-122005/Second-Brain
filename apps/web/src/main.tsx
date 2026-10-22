import * as Tooltip from '@radix-ui/react-tooltip';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApi, isApiError } from './api';
import { ApiContext } from './api/context';
import { qk, shouldRetry } from './api/queries';
import './app.css';
import { createAppRouter } from './router';

async function start() {
  const api = await createApi();
  const router = createAppRouter();

  // Any 401 (session expired, signed out elsewhere) sends the user to sign in, then back.
  const onError = (error: unknown) => {
    if (!isApiError(error) || !error.isUnauthorized) return;
    const { pathname, searchStr } = router.state.location;
    if (pathname === '/sign-in' || pathname === '/login') return;
    queryClient.setQueryData(qk.me, undefined);
    void router.navigate({ to: '/sign-in', search: { redirect: `${pathname}${searchStr}` } });
  };

  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 20_000, refetchOnWindowFocus: true },
    },
  });

  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={queryClient}>
          <Tooltip.Provider delayDuration={500}>
            <RouterProvider router={router} />
          </Tooltip.Provider>
        </QueryClientProvider>
      </ApiContext.Provider>
    </StrictMode>,
  );
}

void start();
