import type { SessionContext } from "eve/tools";

export type SessionPrincipal = NonNullable<SessionContext["session"]["auth"]["current"]>;

export function samePrincipal(a: SessionPrincipal | null, b: SessionPrincipal | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.principalId === b.principalId &&
    a.principalType === b.principalType &&
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer
  );
}
