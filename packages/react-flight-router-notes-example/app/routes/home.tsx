import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Link } from "react-flight-router/client";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

export default async function HomePage() {
  const raw = await readFile(resolve(process.cwd(), "data/notes.json"), "utf-8");
  const notes: Note[] = JSON.parse(raw);

  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-2">Notes</h1>
      <p className="text-sm text-gray-500 mb-6">
        {notes.length} note{notes.length !== 1 ? "s" : ""} &middot; Server rendered at{" "}
        {new Date().toISOString()}
      </p>

      {notes.length === 0 ? (
        <p className="text-gray-500">
          No notes yet.{" "}
          <Link to="/notes/new" className="text-blue-600 hover:underline">
            Create one
          </Link>
          .
        </p>
      ) : (
        <ul className="space-y-4">
          {notes.map((note) => (
            <li key={note.id} className="border border-gray-200 rounded-lg p-5 bg-white">
              <Link to={`/notes/${note.id}`}>
                <h2 className="text-lg font-medium text-blue-600 hover:underline mb-1">
                  {note.title}
                </h2>
              </Link>
              <p className="text-gray-600 text-sm">
                {note.body.length > 120 ? `${note.body.slice(0, 120)}...` : note.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
