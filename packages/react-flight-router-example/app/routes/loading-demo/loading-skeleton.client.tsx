"use client";

export default function LoadingSkeleton() {
  return (
    <div data-testid="loading-skeleton" className="animate-pulse space-y-4 p-6">
      <div className="h-6 bg-gray-200 rounded w-1/3" />
      <div className="space-y-2">
        <div className="h-4 bg-gray-200 rounded w-full" />
        <div className="h-4 bg-gray-200 rounded w-5/6" />
        <div className="h-4 bg-gray-200 rounded w-4/6" />
      </div>
      <p className="text-sm text-gray-400">Loading content...</p>
    </div>
  );
}
