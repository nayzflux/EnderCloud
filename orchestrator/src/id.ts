const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DEFAULT_SIZE = 16;
const RANDOM_BYTE_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/** Generates a Nano ID using only ASCII letters and digits. */
export function nanoid(size = DEFAULT_SIZE): string {
  let result = "";
  const bytes = new Uint8Array(size);

  while (result.length < size) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= RANDOM_BYTE_LIMIT) continue;
      result += ALPHABET[byte % ALPHABET.length];
      if (result.length === size) break;
    }
  }

  return result;
}
