import Link from "next/link";
import { UserX } from "lucide-react";
import { EmptyState, buttonVariants } from "@/components/ui";

export default function ContactNotFound() {
  return (
    <div className="mx-auto max-w-xl py-16">
      <EmptyState
        icon={UserX}
        title="Contact not found"
        description="It may have been deleted, or it belongs to a different workspace."
        action={
          <Link href="/crm" className={buttonVariants({ variant: "outline" })}>
            Back to CRM
          </Link>
        }
      />
    </div>
  );
}
