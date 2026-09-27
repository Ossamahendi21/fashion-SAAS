"use client";

import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { dark } from "@clerk/ui/themes";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ThemeProvider, useTheme } from "next-themes";
import { useMemo, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { env } from "@/lib/env";
import { StoreUser } from "./store-user";
import { NavigationDataProvider } from "./navigation-data";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ThemedClerkProvider>{children}</ThemedClerkProvider>
    </ThemeProvider>
  );
}

function ThemedClerkProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const convex = useMemo(() => new ConvexReactClient(env.NEXT_PUBLIC_CONVEX_URL), []);
  return (
    <ClerkProvider
      publishableKey={env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
      signInUrl={env.NEXT_PUBLIC_CLERK_SIGN_IN_URL}
      signUpUrl={env.NEXT_PUBLIC_CLERK_SIGN_UP_URL}
      signInFallbackRedirectUrl={env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL}
      signUpFallbackRedirectUrl={env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL}
      appearance={{ theme: resolvedTheme === "dark" ? dark : undefined }}
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <TooltipProvider delay={200}>
          <StoreUser />
          <NavigationDataProvider>{children}</NavigationDataProvider>
          <Toaster position="bottom-right" richColors closeButton />
        </TooltipProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
