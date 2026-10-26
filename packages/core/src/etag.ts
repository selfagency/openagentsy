/**
 * The entity tag of a byte string.
 *
 * A task file is written by one agent and read by another, and the two have
 * to agree on whether the file changed. The tag is therefore a function of the
 * bytes alone, cheap enough to run on every write, and the same on every
 * machine and in every run. FNV-1a is that function. It is not a
 * cryptographic hash, and it does not need to be: the tag answers "did these
 * bytes change", not "is this a secret".
 */

/** The FNV-1a 64-bit offset basis, which is the hash of the empty string. */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;

/** The FNV-1a 64-bit prime. */
const FNV_PRIME = 0x100000001b3n;

/** The bits of a 64-bit value, which is where the multiplication wraps. */
const UINT64_MASK = 0xffffffffffffffffn;

/**
 * The FNV-1a 64-bit hash of the bytes, as 16 lowercase hex characters.
 */
export function etag(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The encoder holds no state, so one is enough for the whole process. */
const encoder = new TextEncoder();

/**
 * The tag of a string, over its UTF-8 bytes.
 */
export function etagOf(text: string): string {
  return etag(encoder.encode(text));
}
