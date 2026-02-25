---
title: "Server Actions"
description: "Learn how to use server actions in React Flight Router to handle form submissions and mutations from client components, with progressive enhancement support."
---

# Server Actions

Server actions let you define functions that run on the server and can be called directly from client components. They are the primary way to handle form submissions, data mutations, and other server-side operations in React Flight Router.

## Defining Server Actions

Add the `"use server"` directive at the top of a file to mark all exported functions as server actions.

```ts
// app/actions.ts
"use server";

export async function addMessage(prevState: string[], formData: FormData) {
  const text = (formData.get("text") as string)?.trim();
  if (text) {
    prevState.push(text);
  }
  return [...prevState];
}
```

Server action files can export multiple functions. Each exported function becomes a callable server action.

```ts
// app/actions.ts
"use server";

export async function createPost(prevState: any, formData: FormData) {
  const title = formData.get("title") as string;
  const body = formData.get("body") as string;
  // Save to database...
  return { success: true, title };
}

export async function deletePost(prevState: any, formData: FormData) {
  const id = formData.get("id") as string;
  // Delete from database...
  return { success: true };
}
```

## Using Server Actions with Forms

The recommended way to use server actions is with React's `useActionState` hook. This gives you the previous state, a form action dispatcher, and a pending flag.

```tsx
// app/routes/messages.client.tsx
"use client";

import { useActionState } from "react";
import { addMessage } from "./actions.js";

export function MessageBoard() {
  const [messages, formAction, isPending] = useActionState(addMessage, []);

  return (
    <form action={formAction}>
      <input name="text" placeholder="Message" />
      <button type="submit" disabled={isPending}>
        {isPending ? "Sending..." : "Send"}
      </button>
      <ul>
        {messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </form>
  );
}
```

The `useActionState` hook accepts three arguments:

1. **The server action function** -- imported from a `"use server"` file.
2. **The initial state** -- the starting value before any action has been dispatched.
3. **An optional permalink** -- a URL used for progressive enhancement.

It returns a tuple of:

1. **Current state** -- the latest value returned by the action.
2. **Form action** -- a dispatch function to pass as the form's `action` prop.
3. **isPending** -- a boolean indicating whether the action is currently executing.

## Server Action Signatures

Server actions used with `useActionState` receive two arguments:

```ts
"use server";

export async function myAction(
  prevState: MyStateType, // The previous state returned by the action
  formData: FormData, // The submitted form data
): Promise<MyStateType> {
  // Process and return the new state
}
```

The return value becomes the new state that `useActionState` provides to your component.

## Progressive Enhancement

Server actions support progressive enhancement out of the box. When JavaScript is not available or has not yet loaded, forms using server actions will still submit and work correctly through standard HTML form submission. This means your forms are functional before hydration completes.

```tsx
"use client";

import { useActionState } from "react";
import { subscribe } from "./actions.js";

export function NewsletterForm() {
  const [state, formAction, isPending] = useActionState(subscribe, {
    subscribed: false,
  });

  if (state.subscribed) {
    return <p>Thanks for subscribing!</p>;
  }

  return (
    <form action={formAction}>
      <input type="email" name="email" placeholder="you@example.com" required />
      <button type="submit" disabled={isPending}>
        {isPending ? "Subscribing..." : "Subscribe"}
      </button>
    </form>
  );
}
```

No extra configuration is needed. React Flight Router automatically handles the form submission on the server and returns the updated state to the client.

## Inline Server Actions

You can also define server actions inline within server components by adding `"use server"` at the top of the function body.

```tsx
// app/routes/home.tsx (server component)
export default function Home() {
  async function logVisit() {
    "use server";
    console.log("Page visited at", new Date().toISOString());
  }

  return (
    <form action={logVisit}>
      <button type="submit">Log Visit</button>
    </form>
  );
}
```

## Error Handling

Handle errors within your server action and return them as part of the state.

```ts
"use server";

type FormState = {
  error?: string;
  success?: boolean;
};

export async function submitForm(prevState: FormState, formData: FormData): Promise<FormState> {
  const email = formData.get("email") as string;

  if (!email || !email.includes("@")) {
    return { error: "Please enter a valid email address." };
  }

  try {
    // Save to database...
    return { success: true };
  } catch (e) {
    return { error: "Something went wrong. Please try again." };
  }
}
```

Then display the error in your client component:

```tsx
"use client";

import { useActionState } from "react";
import { submitForm } from "./actions.js";

export function ContactForm() {
  const [state, formAction, isPending] = useActionState(submitForm, {});

  return (
    <form action={formAction}>
      {state.error && <p style={{ color: "red" }}>{state.error}</p>}
      {state.success && <p style={{ color: "green" }}>Submitted!</p>}
      <input type="email" name="email" placeholder="Email" />
      <button type="submit" disabled={isPending}>
        {isPending ? "Submitting..." : "Submit"}
      </button>
    </form>
  );
}
```
