import RegisterForm from "./register.client.js";

export default function RegisterPage() {
  return (
    <main className="max-w-sm mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">Register</h1>
      <RegisterForm />
    </main>
  );
}
