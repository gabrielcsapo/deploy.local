"use client";

import { useActionState } from "react";
import { deleteNote } from "./note-actions.js";

export function DeleteButton({ noteId }: { noteId: string }) {
  const [state, formAction, isPending] = useActionState(deleteNote, {});

  if (state.deleted) {
    return (
      <div className="border border-red-200 rounded-lg p-4 bg-red-50">
        <p className="text-red-800 font-medium">Note deleted.</p>
        <a href="/" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          Back to notes
        </a>
      </div>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={noteId} />
      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer text-sm"
      >
        {isPending ? "Deleting..." : "Delete Note"}
      </button>
    </form>
  );
}
