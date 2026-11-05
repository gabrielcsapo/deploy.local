import { NoteForm } from "./note-form.client.js";

export default function NewNotePage() {
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-6">New Note</h1>
      <p className="text-gray-600 mb-6">
        This heading is a server component. The form below is a client component that calls a server
        action.
      </p>
      <NoteForm />
    </main>
  );
}
