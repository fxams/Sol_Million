import bs58 from "bs58";

export function bytesToBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

