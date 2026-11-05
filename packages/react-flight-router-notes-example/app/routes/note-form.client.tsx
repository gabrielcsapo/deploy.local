"use client";

import { useActionState } from "react";
import { createNote } from "./note-actions.js";

export function NoteForm() {
  const [state, formAction, isPending] = useActionState(createNote, {});

  if (state.success) {
    return (
      <div className="border border-green-200 rounded-lg p-6 bg-green-50">
        <p className="text-green-800 font-medium">Note created successfully!</p>
        <a href="/" className="text-blue-600 hover:underline text-sm mt-2 inline-block">
          Back to notes
        </a>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {state.error && <p className="text-red-600 text-sm">{state.error}</p>}
      <div>
        <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">
          Title
        </label>
        <input
          id="title"
          name="title"
          placeholder="Note title"
          className="w-full px-3 py-2 border border-gray-300 rounded text-base"
        />
      </div>
      <div>
        <label htmlFor="body" className="block text-sm font-medium text-gray-700 mb-1">
          Content
        </label>
        <textarea
          id="body"
          name="body"
          rows={5}
          placeholder="Write your note..."
          className="w-full px-3 py-2 border border-gray-300 rounded text-base"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
      >
        {isPending ? "Creating..." : "Create Note"}
      </button>
    </form>
  );
}
