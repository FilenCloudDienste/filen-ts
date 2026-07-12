// ★ SECURITY: the decryption key AND any visitor-typed password MUST NOT appear in a react-query key.
// The default key hasher JSON-stringifies the whole key into `queryHash`, which the global queryCache
// `onError` LOGS (queries/client.ts) and the persister uses as its on-disk row name — either would
// leak the secret. So every secret travels ONLY through a query's queryFn closure; the query key
// instead carries a NON-SECRET djb2 fingerprint of it, purely so the query re-runs when the fragment
// key or password changes. Kept worker-free (no sdkApi import) so it stays directly unit-testable — the
// secret-out-of-the-key invariant is the surface's #1 property and must be assertable in isolation.
//
// djb2 → base36. One-way-ish (a 32-bit digest of a ~32-char secret is not reversible to it) and,
// unlike the secret, safe to log/persist. A collision only risks serving one wrong secret's cached
// error for another of the same uuid — a manual reload corrects it, never a data-exposure path.
export function secretFingerprint(...parts: (string | undefined)[]): string {
	let h = 5381

	for (const part of parts) {
		const value = part ?? ""

		// A per-part separator so ("ab","c") and ("a","bc") never digest identically.
		h = (Math.imul(h, 33) + 0x1f) | 0

		for (let i = 0; i < value.length; i++) {
			h = (Math.imul(h, 33) + value.charCodeAt(i)) | 0
		}
	}

	return (h >>> 0).toString(36)
}

export function publicLinkQueryKey(scope: string, uuid: string, secret: string) {
	return ["publicLinks", scope, { uuid, k: secret }] as const
}
