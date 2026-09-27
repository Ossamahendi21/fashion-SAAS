import { Manrope } from "next/font/google";
import type { ReactNode } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import "@/components/auth/auth.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-auth", display: "swap" });

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={manrope.variable}>
      <AuthShell>{children}</AuthShell>
    </div>
  );
}
