import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { register, login, logout, validateSession } from "./lib/auth.js";

export const app = new Hono();

app.post("/api/auth/register", async (c) => {
  const { username, password } = await c.req.json();
  const result = register(username, password);

  if (result.error) {
    return c.json({ error: result.error }, 400);
  }

  setCookie(c, "session", result.token!, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 86400,
  });

  return c.json({ user: { username } });
});

app.post("/api/auth/login", async (c) => {
  const { username, password } = await c.req.json();
  const result = login(username, password);

  if (result.error) {
    return c.json({ error: result.error }, 401);
  }

  setCookie(c, "session", result.token!, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 86400,
  });

  return c.json({ user: { username } });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, "session");
  if (token) {
    logout(token);
  }

  setCookie(c, "session", "", {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });

  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const token = getCookie(c, "session");
  if (!token) return c.json({ user: null });

  const session = validateSession(token);
  if (!session) return c.json({ user: null });

  return c.json({ user: { username: session.username } });
});
