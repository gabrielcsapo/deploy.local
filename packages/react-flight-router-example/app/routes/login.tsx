import LoginForm from "./login.client.js";

export default function LoginPage() {
  return (
    <main className="max-w-sm mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Sign In</h1>
      <LoginForm />
    </main>
  );
}
