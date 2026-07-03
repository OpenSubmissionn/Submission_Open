// Redact RPC/API secrets from error text before it's returned to the client or
// logged, so a failing RPC call can't leak the Helius key embedded in
// HELIUS_RPC_URL (`...?api-key=<secret>`). The rest of the message is preserved
// so the client can still show a useful, specific error.
export function redactSecrets(input: string): string {
  return input.replace(
    /([?&](?:api-key|apikey|key|access-token|token)=)[^&\s"']+/gi,
    '$1REDACTED',
  );
}
