"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export function SignOut() {
  const router = useRouter();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <Button size="sm" variant="ghost" disabled={pending} onClick={async () => {
    setPending(true); setError(false);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) throw new Error("Sign out failed");
      await client.cancelQueries(); client.clear(); router.replace("/login"); router.refresh();
    } catch { setError(true); setPending(false); }
  }}>{error ? "Retry sign out" : "Sign out"}</Button>;
}
