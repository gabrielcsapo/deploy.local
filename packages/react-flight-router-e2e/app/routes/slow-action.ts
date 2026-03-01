"use server";

import { isMainThread } from "node:worker_threads";
import { getRequest } from "react-flight-router/server";

interface ActionResult {
  completedAt: number;
  delayMs: number;
  threadType: string;
  userAgent: string;
}

export async function slowAction(
  _prev: ActionResult | null,
  formData: FormData | Record<string, unknown>,
): Promise<ActionResult> {
  // Support both real FormData (from browser) and plain objects (from benchmark tools)
  const delayMs =
    formData && typeof (formData as FormData).get === "function"
      ? Number((formData as FormData).get("delay")) || 1000
      : Number((formData as Record<string, unknown>).delay) || 1000;

  // Simulate CPU-bound or I/O-bound work
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const request = getRequest();

  return {
    completedAt: Date.now(),
    delayMs,
    threadType: isMainThread ? "main" : "worker",
    userAgent: request?.headers.get("user-agent") ?? "unknown",
  };
}
