import { describe, expect, it } from "vitest"
import { publicLinkQueryKey, secretFingerprint } from "@/features/publicLinks/lib/queryKey.logic"

// ★ SECURITY: the #1 invariant of the unauthenticated surface — a link's decryption key and any
// visitor-typed password must NEVER ride a react-query key. The default key hasher JSON-stringifies the
// whole key into `queryHash`, which the global queryCache onError logs and the persister uses as an
// on-disk row name; either would leak the secret. These tests guard, by construction, that only the
// non-secret djb2 fingerprint reaches the key — for every secret-bearing query the viewer builds.

// A raw fragment key (64 hex → 32-byte key) and a visitor password, the two secrets that must not leak.
const RAW_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const RAW_PASSWORD = "hunter2-super-secret"

describe("public-link query-key secret discipline", () => {
	it("keeps the raw key and password out of the serialized query key for every secret-bearing query", () => {
		// The exact keys the four hooks build (file resolve, dir info, dir size, dir listing).
		const composed = [
			publicLinkQueryKey("file", "uuid", secretFingerprint(RAW_KEY, RAW_PASSWORD)),
			publicLinkQueryKey("dirInfo", "uuid", secretFingerprint(RAW_KEY)),
			publicLinkQueryKey("size", "uuid", secretFingerprint(RAW_KEY, RAW_PASSWORD)),
			publicLinkQueryKey("listing", "uuid", secretFingerprint(RAW_KEY, RAW_PASSWORD))
		]

		for (const key of composed) {
			const serialized = JSON.stringify(key)

			expect(serialized).not.toContain(RAW_KEY)
			expect(serialized).not.toContain(RAW_PASSWORD)
		}
	})

	it("re-runs when a secret changes — the fingerprint tracks the key and the password", () => {
		expect(secretFingerprint(RAW_KEY)).not.toBe(secretFingerprint(`${RAW_KEY}0`))
		expect(secretFingerprint(RAW_KEY, RAW_PASSWORD)).not.toBe(secretFingerprint(RAW_KEY, `${RAW_PASSWORD}!`))
		expect(secretFingerprint(RAW_KEY, undefined)).not.toBe(secretFingerprint(RAW_KEY, RAW_PASSWORD))
	})

	it("is stable for the same secret so a re-render does not thrash the cache", () => {
		expect(secretFingerprint(RAW_KEY, RAW_PASSWORD)).toBe(secretFingerprint(RAW_KEY, RAW_PASSWORD))
	})

	it("separates parts so a shifted boundary never digests identically", () => {
		expect(secretFingerprint("ab", "c")).not.toBe(secretFingerprint("a", "bc"))
	})

	it("emits a short, log-safe token, never the secret itself", () => {
		const fingerprint = secretFingerprint(RAW_KEY, RAW_PASSWORD)

		expect(fingerprint).toMatch(/^[0-9a-z]+$/)
		expect(fingerprint.length).toBeLessThan(RAW_KEY.length)
	})
})
