"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { useCloseSlot } from "react-flight-router/client";

export default function CartDrawer({ children }: { children?: ReactNode }) {
  const close = useCloseSlot("drawer");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <aside
      className="fixed top-0 right-0 bottom-0 z-[60] w-80 bg-white shadow-2xl border-l border-gray-200 flex flex-col"
      data-testid="cart-drawer"
    >
      <header className="flex items-center justify-between p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold">Cart</h2>
        <button
          type="button"
          onClick={close}
          aria-label="Close cart"
          data-testid="cart-drawer-close"
          className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center"
        >
          ×
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}
