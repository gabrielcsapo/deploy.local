"use client";

import { useState, useEffect } from "react";
import { Link } from "react-flight-router/client";

export function AuthNav() {
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => setUser(data.user))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-400">...</div>;
  }

  if (!user) {
    return (
      <div className="flex items-center gap-3">
        <Link to="/login" className="text-gray-600 hover:text-blue-500 text-sm">
          Sign in
        </Link>
        <Link
          to="/register"
          className="text-sm px-3 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link to="/profile" className="text-sm font-medium text-gray-700 hover:text-blue-500">
        {user.username}
      </Link>
      <button
        onClick={async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          window.location.href = "/";
        }}
        className="text-sm text-gray-500 hover:text-red-500"
      >
        Sign out
      </button>
    </div>
  );
}
