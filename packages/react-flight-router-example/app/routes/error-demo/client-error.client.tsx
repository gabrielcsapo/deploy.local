"use client";

export default function ClientErrorPage() {
  // Intentionally throw during render to test the error boundary
  throw new Error("This component intentionally throws during client render");
}
