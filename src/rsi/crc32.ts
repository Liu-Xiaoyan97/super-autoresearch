/**
 * CRC32 identical to Python's zlib.crc32 for UTF-8 input.
 *
 * The offline simulator's metrics are defined in terms of this value, so the
 * TypeScript port and the Python reference must agree byte-for-byte.
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** U(n) in the simulator docs: (crc32(text) % n) / n. */
export function unit(text: string, modulus: number): number {
  return (crc32(text) % modulus) / modulus;
}

/** Deterministic PRNG in [0, 1), used by the offline provider. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
