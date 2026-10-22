import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { KeyRound, MailCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApi } from '../api/context';
import { qk } from '../api/queries';
import { Button } from '../components/ui/Button';
import { errorMessage } from '../lib/errors';
import { TextField } from '../components/ui/Field';
import { passkeyErrorMessage, passkeysSupported, signInWithPasskey } from '../lib/passkeys';
import { resolveDestination } from '../lib/redirect';

function GoogleMark() {
  // Neutral monochrome "G" so the button stays calm (no brand colors), still recognisable.
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-[18px]">
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.39a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.74 2.98-4.3 2.98-7.33ZM12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.5c-.9.6-2.04.95-3.39.95-2.6 0-4.81-1.76-5.6-4.12H3.07v2.58A10 10 0 0 0 12 22Zm-5.6-8.1a6 6 0 0 1 0-3.8V7.52H3.07a10 10 0 0 0 0 8.96l3.33-2.58ZM12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.52l3.33 2.58C7.19 7.74 9.4 5.98 12 5.98Z"
      />
    </svg>
  );
}

export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-grouped px-4 py-12">
      <div className="animate-sheet w-full max-w-[400px] rounded-[18px] bg-cell px-7 py-8 shadow-card ring-1 ring-separator">
        {children}
      </div>
    </div>
  );
}

export function AppMark() {
  return (
    <div
      aria-hidden
      className="mx-auto mb-5 flex size-14 items-center justify-center rounded-[14px] bg-accent text-[26px] font-semibold text-white shadow-card"
    >
      B
    </div>
  );
}

export function SignInPage({ redirect }: { redirect?: string | undefined }) {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const providers = useQuery({
    queryKey: ['auth-providers'],
    queryFn: () => api.authProviders(),
    retry: false,
    staleTime: Infinity,
  });
  // An older server without /auth/providers still supports the magic link.
  const offers = providers.data ?? { passkey: false, google: false, magic_link: true };
  const showPasskey = offers.passkey && passkeysSupported();
  const destination = resolveDestination(redirect);

  const finish = async () => {
    await qc.invalidateQueries({ queryKey: qk.me });
    // Server-rendered pages (e.g. the OAuth consent screen) are outside the SPA router.
    if (destination.server) window.location.assign(destination.href);
    else await router.navigate({ href: destination.href });
  };

  // Already signed in (e.g. sent here by the OAuth authorize page): continue straight away.
  const session = useQuery({ queryKey: qk.me, queryFn: () => api.me(), retry: false });
  const continued = useRef(false);
  useEffect(() => {
    if (session.isSuccess && !continued.current) {
      continued.current = true;
      if (destination.server) window.location.assign(destination.href);
      else void router.navigate({ href: destination.href });
    }
  }, [session.isSuccess, destination.href, destination.server, router]);
  const passkey = useMutation({
    mutationFn: () => signInWithPasskey(api),
    onMutate: () => setPasskeyError(null),
    onSuccess: finish,
    onError: (err) => setPasskeyError(passkeyErrorMessage(err)),
  });
  const google = useMutation({
    mutationFn: () => api.startGoogleSignIn(destination.href),
    // Against a real server this navigates away; the mock signs in directly.
    onSuccess: finish,
  });
  const send = useMutation({ mutationFn: (e: string) => api.requestMagicLink(e) });
  const follow = useMutation({
    mutationFn: (link: string) => api.followDevLink(link),
    onSuccess: finish,
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate(email.trim());
  };

  const fieldError =
    send.error && 'errors' in send.error
      ? (send.error as { errors: { path: string; message: string }[] }).errors.find(
          (x) => x.path === 'email',
        )?.message
      : undefined;

  if (send.isSuccess) {
    return (
      <AuthCard>
        <div className="text-center">
          <MailCheck aria-hidden className="mx-auto mb-4 size-12 text-accent" strokeWidth={1.25} />
          <h1 className="text-[22px] font-semibold tracking-tight text-label">Check your email</h1>
          <p className="mt-2 text-[15px] text-label-secondary">
            We sent a sign-in link to <span className="font-medium text-label">{email.trim()}</span>
            . It works once and expires soon.
          </p>
          {send.data.dev_link ? (
            <div className="mt-6 rounded-card bg-grouped p-4 text-left ring-1 ring-separator">
              <p className="text-[13px] text-label-secondary">
                Development mode: no email is sent. Use the link directly.
              </p>
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={follow.isPending}
                onClick={() => send.data.dev_link && follow.mutate(send.data.dev_link)}
              >
                {follow.isPending ? 'Signing in…' : 'Open sign-in link'}
              </Button>
              {follow.isError ? (
                <p role="alert" className="mt-2 text-[13px] text-red">
                  {errorMessage(follow.error).detail || errorMessage(follow.error).title}
                </p>
              ) : null}
            </div>
          ) : null}
          <Button variant="plain" className="mt-5" onClick={() => send.reset()}>
            Use a different email
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AppMark />
      <h1 className="text-center text-[22px] font-semibold tracking-tight text-label">
        Sign in to Second Brain
      </h1>
      <p className="mt-1.5 mb-6 text-center text-[15px] text-label-secondary">
        Your memory, shared with every assistant you use.
      </p>
      {providers.isPending ? (
        <div className="h-11 animate-pulse rounded-[10px] bg-fill" aria-hidden />
      ) : (
        <div className="space-y-2.5">
          {showPasskey ? (
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              autoFocus
              disabled={passkey.isPending}
              onClick={() => passkey.mutate()}
            >
              <KeyRound aria-hidden className="size-[18px]" strokeWidth={1.75} />
              {passkey.isPending ? 'Waiting for passkey…' : 'Continue with passkey'}
            </Button>
          ) : null}
          {offers.google ? (
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              disabled={google.isPending}
              onClick={() => google.mutate()}
            >
              <GoogleMark />
              Continue with Google
            </Button>
          ) : null}
          {passkeyError ? (
            <p role="alert" className="text-center text-[13px] text-red">
              {passkeyError}
            </p>
          ) : null}
          {google.isError ? (
            <p role="alert" className="text-center text-[13px] text-red">
              {errorMessage(google.error).detail || errorMessage(google.error).title}
            </p>
          ) : null}
        </div>
      )}
      {offers.magic_link ? (
        <>
          {showPasskey || offers.google ? (
            <div
              className="my-5 flex items-center gap-3 text-[12px] text-label-secondary"
              aria-hidden
            >
              <span className="h-px flex-1 bg-separator" />
              or
              <span className="h-px flex-1 bg-separator" />
            </div>
          ) : null}
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoFocus={!showPasskey}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              error={
                fieldError ??
                (send.isError && !fieldError ? errorMessage(send.error).detail : undefined)
              }
            />
            <Button
              type="submit"
              variant={showPasskey || offers.google ? 'secondary' : 'primary'}
              size="lg"
              className="w-full"
              disabled={send.isPending || !email.trim()}
            >
              {send.isPending ? 'Sending…' : 'Email me a link'}
            </Button>
          </form>
        </>
      ) : null}
    </AuthCard>
  );
}
