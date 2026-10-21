## What & why
<!-- Summary. Link requirement IDs (FR-xxx / NFR-xx) and issues. -->

## How
<!-- Approach, notable design choices. ADR link if architectural. -->

## Testing
- [ ] Unit
- [ ] Integration (Workers pool)
- [ ] Tenant-isolation suite unaffected / extended
- [ ] Manual check (describe)

## Security checklist
- [ ] AuthZ via central `can()`; no ad-hoc checks
- [ ] Inputs validated with Zod at the edge
- [ ] No note content / secrets in logs
- [ ] Memory returned to agents is in the untrusted envelope
- [ ] Migration is backward-compatible

## Docs
- [ ] README / docs / ADR updated where behaviour changed
