import { Skeleton } from "@/components/ui";

export default function CrmLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading CRM">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-9 w-full sm:w-96" />
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    </div>
  );
}
