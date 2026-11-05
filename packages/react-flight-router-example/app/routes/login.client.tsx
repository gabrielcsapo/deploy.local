"use client";

import { useState } from "react";
import { Link } from "react-flight-router/client";

export default function LoginForm() {
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    try {
      const form = new FormData(e.currentTarget);
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password: form.get("password"),
        }),
      });

      const result = await res.json();

      if (result.error) {
        setError(result.error);
        return;
      }

      window.location.href = "/";
    } catch {
      setError("An unexpected error occurred. Please try again.");
    }
  }

  return (
    <>
      {error && (
        <div className="mb-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="username" className="block text-sm font-medium mb-1">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div>
          <label htmlFor="password" className="block text-sm font-medium mb-1">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <button
          type="submit"
          className="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
        >
          Sign in
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-600 text-center">
        Don&apos;t have an account?{" "}
        <Link to="/register" className="text-blue-600 hover:underline">
          Register
        </Link>
      </p>
    </>
  );
}
