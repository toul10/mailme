/** Shared secret helpers live in src/lib/crypto.ts (one implementation for server, worker and CLI). */
export { deriveLinkSecret, safeEqual, sha256Hex } from "../lib/crypto.js";
