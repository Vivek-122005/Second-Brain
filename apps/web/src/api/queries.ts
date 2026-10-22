import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { isApiError } from './client';
import { useApi } from './context';
import type {
  CreateKeyInput,
  DeviceApproveInput,
  ListNotesParams,
  NoteType,
  ProjectStatus,
  SaveNoteRequest,
} from './contract';

/** Query keys in one place so invalidation stays consistent. */
export const qk = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  notes: (params: Omit<ListNotesParams, 'cursor'>) => ['notes', params] as const,
  notesAll: ['notes'] as const,
  note: (path: string) => ['note', path] as const,
  search: (q: string, types: NoteType[]) => ['search', q, types] as const,
  projects: (status?: ProjectStatus) => ['projects', status ?? 'all'] as const,
  keys: ['keys'] as const,
  passkeys: ['passkeys'] as const,
  connect: ['connect'] as const,
  device: (code: string) => ['device', code] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: qk.me, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}

export function useDashboard() {
  const api = useApi();
  return useQuery({ queryKey: qk.dashboard, queryFn: () => api.dashboard() });
}

export function useNotes(params: Omit<ListNotesParams, 'cursor'>) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: qk.notes(params),
    queryFn: ({ pageParam }) =>
      api.listNotes({ ...params, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useNote(path: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.note(path ?? ''),
    queryFn: () => api.getNote(path ?? ''),
    enabled: Boolean(path),
  });
}

export function useSearch(q: string, types: NoteType[] = [], limit = 20) {
  const api = useApi();
  const trimmed = q.trim();
  return useQuery({
    queryKey: qk.search(trimmed, types),
    queryFn: () => api.search({ q: trimmed, types, limit }),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useProjects(status?: ProjectStatus) {
  const api = useApi();
  return useQuery({
    queryKey: qk.projects(status),
    queryFn: () => api.projects(status),
    placeholderData: keepPreviousData,
  });
}

export function useKeys() {
  const api = useApi();
  return useQuery({ queryKey: qk.keys, queryFn: () => api.listKeys() });
}

export function useConnectInfo() {
  const api = useApi();
  return useQuery({ queryKey: qk.connect, queryFn: () => api.connect(), staleTime: Infinity });
}

export function useDeviceRequest(code: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.device(code ?? ''),
    queryFn: () => api.deviceRequest(code ?? ''),
    enabled: Boolean(code),
    retry: false,
  });
}

/** After any write, everything derived from notes may be stale. */
function useInvalidateNotes() {
  const qc = useQueryClient();
  return (path?: string) => {
    void qc.invalidateQueries({ queryKey: qk.notesAll });
    void qc.invalidateQueries({ queryKey: qk.dashboard });
    void qc.invalidateQueries({ queryKey: ['search'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
    if (path) void qc.invalidateQueries({ queryKey: qk.note(path) });
  };
}

export function useSaveNote() {
  const api = useApi();
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: (req: SaveNoteRequest) => api.saveNote(req),
    onSuccess: (res) => invalidate(res.path),
  });
}

export function useCreateKey() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateKeyInput) => api.createKey(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

export function useRevokeKey() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

export function useApproveDevice() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: DeviceApproveInput) => api.approveDevice(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.keys }),
  });
}

/** Retry transient failures only; 4xx answers will not change on retry. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}
