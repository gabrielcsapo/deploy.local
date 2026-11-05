import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Link } from "react-flight-router/client";
import { DeleteButton } from "./delete-button.client.js";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export default async function NoteDetailPage({ params }: { params: Record<string, string> }) {
  const raw = await readFile(resolve(process.cwd(), "data/notes.json"), "utf-8");
  const notes: Note[] = JSON.parse(raw);
  const note = notes.find((n) => n.id === params.id);

  if (!note) {
    return (
      <main className="max-w-3xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-4">Note not found</h1>
        <p className="text-gray-600">
          <Link to="/" className="text-blue-600 hover:underline">
            Back to notes
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="max-w-3xl mx-auto p-8">
      <Link to="/" className="text-blue-600 hover:underline text-sm">
        &larr; Back to notes
      </Link>
      <article className="mt-4">
        <h1 className="text-3xl font-bold mb-2">{note.title}</h1>
        <p className="text-sm text-gray-500 mb-6">
          Created {new Date(note.createdAt).toLocaleDateString()}
        </p>
        <div className="mb-8">
          <p className="leading-relaxed">{note.body}</p>
        </div>
        <DeleteButton noteId={note.id} />
      </article>
    </main>
  );
}
