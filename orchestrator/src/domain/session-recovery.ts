import type { SessionState } from "./types.ts";

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
