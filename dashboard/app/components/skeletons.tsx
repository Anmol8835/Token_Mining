import { Skeleton } from "@/app/components/ui";

/*
 * First-load skeletons. Each mirrors the final layout's geometry so
 * nothing jumps when data lands. Only shown before the first poll
 * returns; refetches hold the previous render (see use-poll.ts).
 */

function PanelSkeleton({ title = "w-40", body = "h-52" }: { title?: string; body?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
      <Skeleton className={`h-3 ${title}`} />
      <Skeleton className={`mt-4 w-full ${body}`} />
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading overview">
      {/* hero */}
      <div className="rounded-xl border border-hairline bg-surface px-5 py-6 sm:px-7">
        <Skeleton className="h-3 w-44" />
        <Skeleton className="mt-3 h-10 w-60" />
        <Skeleton className="mt-3 h-3 w-80" />
      </div>
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      {/* chart grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <PanelSkeleton title="w-36" body="h-56" />
        </div>
        <PanelSkeleton title="w-32" body="h-44" />
        <PanelSkeleton title="w-48" body="h-44" />
        <PanelSkeleton title="w-40" body="h-40" />
        <PanelSkeleton title="w-36" body="h-40" />
      </div>
      {/* accounting + table */}
      <PanelSkeleton title="w-44" body="h-28" />
      <PanelSkeleton title="w-32" body="h-48" />
    </div>
  );
}

export function ModelsSkeleton() {
  return (
    <div className="flex max-w-4xl flex-col gap-6" aria-busy="true" aria-label="Loading models">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-3 w-96" />
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-xl border border-hairline bg-surface">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-4 rounded-full" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24 rounded-full" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        ))}
      </div>
      <PanelSkeleton title="w-40" body="h-20" />
    </div>
  );
}

export function RoutingSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading routing preferences">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-44" />
        <Skeleton className="h-3 w-[26rem] max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface p-4">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-1 h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </div>
      <PanelSkeleton title="w-32" body="h-16" />
      <PanelSkeleton title="w-32" body="h-40" />
    </div>
  );
}

export function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading activity">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-3 w-72" />
      </div>
      <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
        <div className="mb-3 flex gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-14" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-line/60 py-2.5 last:border-b-0">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
