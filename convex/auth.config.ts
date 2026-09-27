/**
 * Read at deploy time by the Convex CLI, outside any function context, so `lib/env.ts`'s
 * `requireEnv` (which is meant to fail loudly inside a running function) cannot be used here:
 * a missing `CLERK_JWT_ISSUER_DOMAIN` has to surface as a push-time config error instead.
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
