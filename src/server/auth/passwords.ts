import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id password hashing (library default algorithm; OWASP parameters: 19 MiB, t=2, p=1).
 * Hashes are PHC strings ("$argon2id$v=19$m=19456,t=2,p=1$…").
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

/** Shortest accepted web password (CLI prompt and the setup link alike). */
export const MIN_PASSWORD = 12;

export async function hashPassword(password: string): Promise<string> {
  const h = await hash(password, OPTIONS);
  if (!h.startsWith("$argon2id$")) throw new Error("argon2 did not produce an argon2id hash");
  return h;
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Spend the same time as a real verification when the account doesn't exist (no user enumeration by timing). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("mailme-dummy-password-for-timing");
  await verifyPassword(await dummyHash, password);
}
