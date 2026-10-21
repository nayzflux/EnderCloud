"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Too many attempts. Try again in a minute."
            : "Unable to sign in. Check your credentials and try again.",
        );
      router.replace("/");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to sign in.");
    } finally {
      setPending(false);
    }
  }
  return (
    <main id="main-content" className="flex min-h-svh items-center justify-center p-6">
      <form
        onSubmit={signIn}
        className="grid w-full max-w-sm gap-5 rounded-xl border bg-card p-7 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-semibold">EnderCloud</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to cluster control</p>
        </div>
        <div className="grid gap-2">
          <label htmlFor="email">Email</label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="grid gap-2">
          <label htmlFor="password">Password</label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
