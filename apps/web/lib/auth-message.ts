// Sign-In-With-Ethereum style message. Client builds it, the server re-parses and verifies it.
// Client-safe, pure.
export const SIGN_IN_TITLE = "ARENA sign-in";

export interface SignInFields {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: string;
}

export function buildSignInMessage(f: SignInFields): string {
  return [SIGN_IN_TITLE, `Domain: ${f.domain}`, `Address: ${f.address}`, `Nonce: ${f.nonce}`, `Issued At: ${f.issuedAt}`].join(
    "\n",
  );
}

export function parseSignInMessage(message: string): SignInFields | null {
  const lines = message.split("\n");
  if (lines[0] !== SIGN_IN_TITLE) return null;
  const field = (prefix: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${prefix}: `));
    return line ? line.slice(prefix.length + 2) : null;
  };
  const domain = field("Domain");
  const address = field("Address");
  const nonce = field("Nonce");
  const issuedAt = field("Issued At");
  if (!domain || !address || !nonce || !issuedAt) return null;
  return { domain, address, nonce, issuedAt };
}
