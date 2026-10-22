import { Navigate, useRouter } from '@tanstack/react-router';
import { CheckCircle2, Laptop, XCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { isApiError } from '../api/client';
import { useApproveDevice, useDeviceRequest, useMe, useProjects } from '../api/queries';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Feedback';
import { errorMessage } from '../lib/errors';
import { SelectField, TextField } from '../components/ui/Field';
import { RouterAnchor } from '../components/ui/RouterAnchor';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { formatRelative } from '../lib/format';
import { normalizeUserCode } from '../lib/device';
import { buildHref } from '../lib/href';
import { AppMark, AuthCard } from './SignIn';

function CodeEntry() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void router.navigate({ href: buildHref('/device', { code: normalizeUserCode(code) }) });
  };
  return (
    <AuthCard>
      <AppMark />
      <h1 className="text-center text-[22px] font-semibold tracking-tight text-label">
        Connect a device
      </h1>
      <p className="mt-1.5 mb-6 text-center text-[15px] text-label-secondary">
        Enter the code shown in your terminal.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <TextField
          label="Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          autoFocus
          autoComplete="one-time-code"
          className="text-center font-mono tracking-[0.2em] uppercase"
        />
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!code.trim()}
        >
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}

function Approval({ code }: { code: string }) {
  const request = useDeviceRequest(code);
  const approve = useApproveDevice();
  const projects = useProjects('active');
  const [scope, setScope] = useState<'rw' | 'r'>('rw');
  const [project, setProject] = useState('');
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);

  const decide = (ok: boolean) => {
    approve.mutate(
      {
        user_code: code,
        approve: ok,
        scopes: scope === 'rw' ? ['read', 'write'] : ['read'],
        ...(project ? { project } : {}),
      },
      { onSuccess: () => setOutcome(ok ? 'approved' : 'denied') },
    );
  };

  if (outcome) {
    const approved = outcome === 'approved';
    const Icon = approved ? CheckCircle2 : XCircle;
    return (
      <AuthCard>
        <div className="text-center">
          <Icon
            aria-hidden
            className={`mx-auto mb-4 size-12 ${approved ? 'text-green' : 'text-label-secondary'}`}
            strokeWidth={1.25}
          />
          <h1 className="text-[22px] font-semibold tracking-tight text-label" role="status">
            {approved ? 'Device connected' : 'Request denied'}
          </h1>
          <p className="mt-2 text-[15px] text-label-secondary">
            {approved
              ? 'You can close this window and return to your terminal.'
              : 'The device was not given access. You can close this window.'}
          </p>
          <RouterAnchor
            href="/keys"
            className="mt-5 inline-block text-[15px] text-accent-text hover:underline"
          >
            Manage keys & devices
          </RouterAnchor>
        </div>
      </AuthCard>
    );
  }

  if (request.isPending) {
    return (
      <AuthCard>
        <div className="flex justify-center py-8">
          <Spinner label="Looking up the code" />
        </div>
      </AuthCard>
    );
  }

  if (request.isError) {
    const expired = isApiError(request.error) && request.error.status === 410;
    return (
      <AuthCard>
        <div className="text-center">
          <XCircle
            aria-hidden
            className="mx-auto mb-4 size-12 text-label-tertiary"
            strokeWidth={1.25}
          />
          <h1 className="text-[20px] font-semibold text-label">
            {expired ? 'This code has expired' : 'Code not found'}
          </h1>
          <p role="alert" className="mt-2 text-[15px] text-label-secondary">
            {errorMessage(request.error).detail}
          </p>
          <RouterAnchor
            href="/device"
            className="mt-5 inline-block text-[15px] text-accent-text hover:underline"
          >
            Enter a different code
          </RouterAnchor>
        </div>
      </AuthCard>
    );
  }

  const info = request.data;
  return (
    <AuthCard>
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-[14px] bg-fill">
        <Laptop aria-hidden className="size-7 text-label" strokeWidth={1.5} />
      </div>
      <h1 className="text-center text-[20px] font-semibold tracking-tight text-label">
        Allow this device to access your brain?
      </h1>
      <dl className="mt-5 divide-y divide-separator rounded-card bg-grouped text-[14px] ring-1 ring-separator">
        <div className="flex justify-between gap-4 px-4 py-2.5">
          <dt className="text-label-secondary">Client</dt>
          <dd className="font-medium text-label">{info.client}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-2.5">
          <dt className="text-label-secondary">Machine</dt>
          <dd className="font-medium text-label">{info.machine}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-2.5">
          <dt className="text-label-secondary">Code</dt>
          <dd className="font-mono font-medium tracking-wider text-label">{info.user_code}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-2.5">
          <dt className="text-label-secondary">Expires</dt>
          <dd className="text-label">{formatRelative(info.expires_at)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-[13px] leading-snug text-label-secondary">
        Only approve if you just ran <code className="font-mono">brain login</code> and the code
        matches your terminal.
      </p>
      <div className="mt-5 space-y-4">
        <div className="space-y-1.5">
          <span className="block text-[13px] font-medium text-label">Access</span>
          <SegmentedControl<'rw' | 'r'>
            label="Access"
            className="w-full"
            value={scope}
            onChange={setScope}
            segments={[
              { value: 'rw', label: 'Read & write' },
              { value: 'r', label: 'Read only' },
            ]}
          />
        </div>
        <SelectField label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {(projects.data?.items ?? []).map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.title}
            </option>
          ))}
        </SelectField>
      </div>
      {approve.isError ? (
        <p role="alert" className="mt-4 text-[13px] text-red">
          {errorMessage(approve.error).detail || errorMessage(approve.error).title}
        </p>
      ) : null}
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Button
          variant="secondary"
          size="lg"
          onClick={() => decide(false)}
          disabled={approve.isPending}
        >
          Deny
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => decide(true)}
          disabled={approve.isPending}
        >
          Approve
        </Button>
      </div>
    </AuthCard>
  );
}

/** `/device?code=XXXX-XXXX`: approve a CLI sign-in (RFC 8628 style). Requires a session. */
export function DevicePage({ code }: { code?: string | undefined }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <AuthCard>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </AuthCard>
    );
  }
  if (me.isError && isApiError(me.error) && me.error.isUnauthorized) {
    const redirect = buildHref('/device', { code });
    return <Navigate to="/sign-in" search={{ redirect }} replace />;
  }
  return code ? <Approval code={normalizeUserCode(code)} /> : <CodeEntry />;
}
