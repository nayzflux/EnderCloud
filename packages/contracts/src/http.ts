export class HttpResponseError extends Error {
  public constructor(message: string, public readonly status: number, public readonly requestId: string | null) {
    super(message); this.name = "HttpResponseError";
  }
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  if (response.ok && [204, 205].includes(response.status)) return undefined as T;
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { throw new HttpResponseError(response.ok ? "Invalid JSON response" : `Request failed (${response.status})`, response.ok ? 502 : response.status, response.headers.get("x-request-id")); }
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : `Request failed (${response.status})`;
    throw new HttpResponseError(message, response.status, response.headers.get("x-request-id"));
  }
  return body as T;
}

export async function requestJson<T>(input: string | URL, init: RequestInit = {}, timeoutMs = 8_000): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (!headers.has("x-request-id")) headers.set("x-request-id", crypto.randomUUID());
  return readJsonResponse<T>(await fetch(input, { ...init, headers,
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }));
}
