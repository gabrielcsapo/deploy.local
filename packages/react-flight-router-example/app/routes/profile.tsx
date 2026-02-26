import { getSessionUser } from "../lib/auth.js";

/**
 * Profile page — a server component that reads the session directly
 * via AsyncLocalStorage (populated by the onRequest callback).
 *
 * This is the key test surface for verifying that onRequest works:
 * the server component can synchronously read the per-request context
 * without any props or API calls.
 */
export default function ProfilePage() {
  const user = getSessionUser();

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-4">Profile</h1>
      {user ? (
        <div>
          <p className="text-lg">
            Welcome,{" "}
            <span className="font-semibold" data-testid="profile-username">
              {user.username}
            </span>
          </p>
          <p className="text-sm text-gray-500 mt-2">
            This username was read by a server component via <code>getSessionUser()</code>, which
            uses <code>AsyncLocalStorage</code> populated by the <code>onRequest</code> callback.
          </p>
        </div>
      ) : (
        <div>
          <p className="text-gray-600" data-testid="not-logged-in">
            Not logged in
          </p>
          <p className="text-sm text-gray-500 mt-2">
            Sign in to see your profile here. The server component reads the session cookie via{" "}
            <code>onRequest</code> + <code>AsyncLocalStorage</code>.
          </p>
        </div>
      )}
    </main>
  );
}
