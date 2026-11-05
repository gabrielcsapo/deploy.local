"use server";

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
}

const NOTES_PATH = resolve(process.cwd(), "data/notes.json");

async function readNotes(): Promise<Note[]> {
  const raw = await readFile(NOTES_PATH, "utf-8");
  return JSON.parse(raw);
}

async function writeNotes(notes: Note[]): Promise<void> {
  await writeFile(NOTES_PATH, JSON.stringify(notes, null, 2), "utf-8");
}

interface CreateNoteState {
  error?: string;
  success?: boolean;
  noteId?: string;
}

export async function createNote(
  prevState: CreateNoteState,
  formData: FormData,
): Promise<CreateNoteState> {
  const title = (formData.get("title") as string)?.trim();
  const body = (formData.get("body") as string)?.trim();

  if (!title) {
    return { error: "Title is required." };
  }
  if (!body) {
    return { error: "Body is required." };
  }

  const notes = await readNotes();
  const newNote: Note = {
    id: Date.now().toString(36),
    title,
    body,
    createdAt: new Date().toISOString(),
  };
  notes.push(newNote);
  await writeNotes(notes);

  return { success: true, noteId: newNote.id };
}

interface DeleteNoteState {
  deleted?: boolean;
}

export async function deleteNote(
  prevState: DeleteNoteState,
  formData: FormData,
): Promise<DeleteNoteState> {
  const id = formData.get("id") as string;
  const notes = await readNotes();
  const filtered = notes.filter((n) => n.id !== id);
  await writeNotes(filtered);
  return { deleted: true };
}
