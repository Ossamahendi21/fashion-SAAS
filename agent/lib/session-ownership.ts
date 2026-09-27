import type { EveChannel } from "eve/channels/eve";
import type { SessionPrincipal } from "./session-auth";

type OwnershipPolicy = {
  authenticate(request: Request): Promise<SessionPrincipal | Response>;
  canAccessThread(caller: SessionPrincipal, threadId: string): Promise<boolean>;
  canAccessSession(caller: SessionPrincipal, sessionId: string): Promise<boolean>;
  bindSession(caller: SessionPrincipal, threadId: string, sessionId: string): Promise<unknown>;
};

function denied(status = 403, message = "This conversation is not available."): Response {
  return Response.json({ ok: false, error: message }, { status, headers: { "cache-control": "no-store" } });
}

/** Eve authenticates routes but supplies no session ACL; guard every ID-addressed operation. */
export function withSessionOwnership(channel: EveChannel, policy: OwnershipPolicy): EveChannel {
  return {
    ...channel,
    routes: channel.routes.map((route) => {
      if (route.transport === "websocket" || !route.path.startsWith("/eve/v1/session")) return route;
      return {
        ...route,
        async handler(request, context) {
          const caller = await policy.authenticate(request);
          if (caller instanceof Response) return caller;
          const sessionId = context.params.sessionId ?? context.params.parentSessionId;
          if (sessionId) {
            try {
              if (!(await policy.canAccessSession(caller, sessionId))) return denied();
            } catch {
              return denied(503, "Conversation access could not be checked. Try again.");
            }
            return route.handler(request, context);
          }

          if (route.path !== "/eve/v1/session" || route.method !== "POST") return denied();
          const threadId = request.headers.get("x-fitcheck-thread-id");
          if (!threadId) return denied(400, "Choose a conversation before sending a message.");
          try {
            if (!(await policy.canAccessThread(caller, threadId))) return denied();
          } catch {
            return denied(503, "Conversation access could not be checked. Try again.");
          }

          const response = await route.handler(request, context);
          if (!response.ok) return response;
          const createdSessionId = response.headers.get("x-eve-session-id");
          if (!createdSessionId) return denied(502, "The conversation could not be started.");
          try {
            // Finish the ownership write before the browser receives an ID it can stream or resume.
            await policy.bindSession(caller, threadId, createdSessionId);
          } catch {
            return denied(503, "The conversation could not be saved. Try again.");
          }
          return response;
        },
      };
    }),
  };
}
