import postgres from "postgres";

/** Dedicated session lock: connection loss immediately withdraws the control plane. */
export async function acquireLeadership(url: string, onLost: () => void): Promise<() => Promise<void>> {
  let holding = false;
  const connection = postgres(url, { max: 1, idle_timeout: 0, connect_timeout: 10,
    onclose: () => { if (holding) { holding = false; onLost(); } }, onnotice: () => {} });
  try {
    const [result] = await connection`SELECT pg_try_advisory_lock(18523419) AS acquired`;
    if (!result?.acquired) throw new Error("Another EnderCloud orchestrator is active on this database");
    holding = true;
    return async () => { holding = false; await connection.end({ timeout: 5 }); };
  } catch (error) { await connection.end({ timeout: 5 }); throw error; }
}
