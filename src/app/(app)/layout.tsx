import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { requireSignedIn } from "@/lib/auth";

export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireSignedIn();
  return <AppShell>{children}</AppShell>;
}
