"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useCloseSlot } from "react-flight-router/client";

export default function PhotoModalLayout({ children }: { children?: ReactNode }) {
  const close = useCloseSlot("modal");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="photo-modal"
      onClick={close}
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close modal"
          data-testid="photo-modal-close"
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center text-gray-700"
        >
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
