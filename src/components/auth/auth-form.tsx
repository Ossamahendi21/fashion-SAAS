"use client";

import { ClerkFailed, ClerkLoaded, ClerkLoading, SignIn, SignUp } from "@clerk/nextjs";
import type { Appearance } from "@clerk/ui";
import { shadcn } from "@clerk/ui/themes";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { PLANS } from "@convex/shared/credits";

const appearance: Appearance = {
  theme: shadcn,
  options: {
    elevation: "flush",
    logoPlacement: "none",
    socialButtonsVariant: "blockButton",
    autoFocus: false,
  },
  variables: {
    fontFamily: "var(--font-auth), var(--font-sans), sans-serif",
    colorBackground: "var(--background)",
    colorForeground: "var(--foreground)",
    colorInput: "var(--background)",
    colorInputForeground: "var(--foreground)",
    colorBorder: "var(--border)",
    borderRadius: "0.625rem",
  },
  elements: {
    rootBox: "auth-clerk-root",
    cardBox: "auth-clerk-box",
    card: "auth-clerk-card",
    main: "auth-clerk-main",
    form: "auth-clerk-form",
    header: "auth-clerk-header",
    headerTitle: "auth-clerk-title",
    headerSubtitle: "auth-clerk-subtitle",
    socialButtonsBlockButton: "auth-clerk-social",
    formFieldInput: "auth-clerk-input",
    formFieldLabel: "auth-clerk-label",
    formFieldInputShowPasswordButton: "auth-clerk-password-toggle",
    formButtonPrimary: "auth-clerk-submit",
    footer: "auth-clerk-footer",
    footerAction: "auth-clerk-footer-action",
    footerActionLink: "auth-clerk-link",
    formResendCodeLink: "auth-clerk-link",
    otpCodeFieldInput: "auth-clerk-otp",
    otpCodeField: "auth-clerk-otp-group",
    otpCodeFieldInputs: "auth-clerk-otp-group",
    otpCodeFieldInputContainer: "auth-clerk-otp-group",
  },
};

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const signingUp = mode === "sign-up";

  return (
    <>
      <p className="auth-eyebrow auth-form-eyebrow">
        {signingUp ? `${PLANS.free.signupCredits} free credits. A fresh start.` : "Back to your wardrobe"}
      </p>
      <ClerkLoading>
        <div className="auth-loading" role="status" aria-live="polite">
          <Spinner className="size-5" />
          <span>Getting your {signingUp ? "sign-up" : "sign-in"} ready…</span>
        </div>
      </ClerkLoading>
      <ClerkFailed>
        <div className="auth-unavailable" role="alert">
          <h2>We couldn’t load sign-in.</h2>
          <p>Check your connection and try again.</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </ClerkFailed>
      <ClerkLoaded>
        {signingUp ? (
          <SignUp appearance={appearance} routing="path" path={routes.signUp} signInUrl={routes.signIn} />
        ) : (
          <SignIn appearance={appearance} routing="path" path={routes.signIn} signUpUrl={routes.signUp} />
        )}
      </ClerkLoaded>
    </>
  );
}
