import ActionForm from "./action-form.client.js";

export default function ActionsPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Server Actions</h1>
      <p className="text-gray-600 mb-6">
        Submit an action with a configurable delay to test worker thread execution.
      </p>
      <ActionForm />
    </div>
  );
}
