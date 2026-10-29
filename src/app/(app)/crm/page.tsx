import { Suspense } from "react";
import type { Metadata } from "next";
import { CrmWorkspace } from "@/components/crm/crm-workspace";
import { canWrite, requirePageContext } from "@/lib/auth/context";
import CrmLoading from "./loading";

export const metadata: Metadata = { title: "CRM" };

export default async function CrmPage() {
  const ctx = await requirePageContext();
  return (
    <Suspense fallback={<CrmLoading />}>
      <CrmWorkspace canWrite={canWrite(ctx)} currency={ctx.currency} />
    </Suspense>
  );
}
