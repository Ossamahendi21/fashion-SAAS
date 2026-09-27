import type { Metadata } from "next";
import { BillingOverview } from "@/components/billing/billing-overview";
import { LedgerTable } from "@/components/billing/ledger-table";
import { PlansCard } from "@/components/billing/plans-card";
import { PageHeader } from "@/components/common/page-header";
import { requireSignedIn } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Billing",
  description: "Your plan, your credits and every line of the ledger.",
};

export default async function BillingPage() {
  await requireSignedIn();
  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Your account"
        title="Plans & credits."
        description="One credit for each clothing cutout or standard try-on. HQ try-ons use three. Styling conversations are free."
      />
      <BillingOverview />
      <PlansCard />
      <LedgerTable />
    </div>
  );
}
