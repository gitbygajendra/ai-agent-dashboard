import { Skeleton } from "@/components/ui";

export default function ContactLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading contact">
      <Skeleton className="h-4 w-28" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72 max-w-full" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-[28rem] lg:col-span-2" />
      </div>
    </div>
  );
}
