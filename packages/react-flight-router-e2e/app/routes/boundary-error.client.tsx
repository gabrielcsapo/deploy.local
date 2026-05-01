"use client";

export default function BoundaryError({ error }: { error?: Error }) {
  return (
    <div className="text-red-600">
      <p>Boundary error: {error?.message ?? "unknown"}</p>
    </div>
  );
}
