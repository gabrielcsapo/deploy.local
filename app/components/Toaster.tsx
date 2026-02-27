'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';

export type ToastType = 'success' | 'error' | 'loading' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  createdAt: number;
}

interface ToasterContextValue {
  toast: (id: string, t: Omit<Toast, 'id' | 'createdAt'>) => void;
  dismiss: (id: string) => void;
}

const ToasterContext = createContext<ToasterContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToasterContext);
  if (!ctx) throw new Error('useToast must be used within <Toaster>');
  return ctx;
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (toast.type === 'loading') return;
    timerRef.current = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 200);
    }, 5000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.type, toast.createdAt, onDismiss]);

  const icon =
    toast.type === 'success'
      ? '✓'
      : toast.type === 'error'
        ? '✗'
        : toast.type === 'loading'
          ? '◌'
          : 'ℹ';

  const iconColor =
    toast.type === 'success'
      ? 'text-success'
      : toast.type === 'error'
        ? 'text-danger'
        : toast.type === 'loading'
          ? 'text-warning'
          : 'text-accent';

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border border-border bg-bg-surface px-4 py-3 shadow-lg shadow-black/40 transition-all duration-200 ${
        exiting ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'
      }`}
      style={{ minWidth: 280, maxWidth: 380 }}
    >
      <span
        className={`${iconColor} text-sm mt-0.5 shrink-0 ${toast.type === 'loading' ? 'animate-spin' : ''}`}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-text-secondary mt-0.5">{toast.description}</p>
        )}
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="text-xs text-accent hover:text-accent-hover mt-1.5 font-medium"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={() => {
          setExiting(true);
          setTimeout(onDismiss, 200);
        }}
        className="text-text-tertiary hover:text-text text-xs shrink-0 mt-0.5"
      >
        ✕
      </button>
    </div>
  );
}

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((id: string, t: Omit<Toast, 'id' | 'createdAt'>) => {
    setToasts((prev) => {
      const existing = prev.find((p) => p.id === id);
      if (existing) {
        return prev.map((p) => (p.id === id ? { ...t, id, createdAt: Date.now() } : p));
      }
      return [...prev, { ...t, id, createdAt: Date.now() }];
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToasterContext.Provider value={{ toast, dismiss }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToasterContext.Provider>
  );
}
