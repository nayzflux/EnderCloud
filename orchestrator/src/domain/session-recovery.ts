import type { SessionState } from "./types.ts";

// Allow retries only while a session is still safe to reassign to another instance.
export function shouldRetryFailedSession(
  state: SessionState,
  connectedPlayers: number,
  retryCount: number,
  maximumRetries: number,
): boolean {
  const stillWaitingForPlayers = state === "TRANSFERRING" || state === "WAITING";
  return (
    stillWaitingForPlayers &&
    connectedPlayers === 0 &&
    retryCount < maximumRetries
  );
}
