'use server';

const messages: string[] = [];

export async function addMessage(prevState: string[], formData: FormData): Promise<string[]> {
  const text = formData.get('text') as string;
  if (text?.trim()) {
    messages.push(text.trim());
  }
  return [...messages];
}
