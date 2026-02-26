"use client";

import { useState } from "react";
import { Link } from "react-flight-router/client";

export default function RegisterForm() {
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    const form = new FormData(e.currentTarget);
    const password = form.get("password") as string;
    const confirm = form.get("confirm") as string;

    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.get("username"),
          password,
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
            minLength={6}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
          <p className="text-xs text-gray-500 mt-1">Must be at least 6 characters</p>
        </div>
        <div>
          <label htmlFor="confirm" className="block text-sm font-medium mb-1">
            Confirm password
          </label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={6}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <button
          type="submit"
          className="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
        >
          Create account
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-600 text-center">
        Already have an account?{" "}
        <Link to="/login" className="text-blue-600 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
