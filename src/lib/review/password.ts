import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt with N=2^15, r=8, p=1 (about 32 MiB and tens of milliseconds per hash).
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_RULES = { minLength: 12, maxLength: 200 } as const;

const derive = (
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password.normalize("NFC"),
      salt,
      KEY_BYTES,
      { N: n, r, p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );

/** `scrypt$N$r$p$salt$hash` (base64url). Parameters are stored so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  if (
    password.length < PASSWORD_RULES.minLength ||
    password.length > PASSWORD_RULES.maxLength
  ) {
    throw new Error(
      `Password must be ${PASSWORD_RULES.minLength}-${PASSWORD_RULES.maxLength} characters`,
    );
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

const STORED =
  /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([\w-]{16,64})\$([\w-]{32,128})$/;

/**
 * The parameters of a stored hash, or undefined when they are malformed or outside
 * what this code will run: N of 2^14 or 2^15, r = 8, p of 1 or 2. That keeps scrypt
 * within MAXMEM (128 * N * r bytes), so a stored row can't pick a cost that throws.
 */
export function parseStoredHash(stored: string) {
  const m = STORED.exec(stored);
  if (!m) return undefined;
  const [n, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![2 ** 14, 2 ** 15].includes(n) || r !== 8 || p < 1 || p > 2) {
    return undefined;
  }
  return {
    n,
    r,
    p,
    salt: Buffer.from(m[4]!, "base64url"),
    hash: Buffer.from(m[5]!, "base64url"),
  };
}

/** Constant-time check. A malformed or unsupported stored hash never verifies. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const params = parseStoredHash(stored);
  if (!params || password.length > PASSWORD_RULES.maxLength) return false;
  const actual = await derive(
    password,
    params.salt,
    params.n,
    params.r,
    params.p,
  );
  return (
    actual.length === params.hash.length && timingSafeEqual(actual, params.hash)
  );
}

/** A fixed hash to verify against when the username doesn't exist, so timing doesn't tell. */
export const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
