import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it down
// to the one method the session store calls. `injectClient` is a spy so the resume path is observable.
const { injectClient } = vi.hoisted(() => ({ injectClient: vi.fn<(blob: StringifiedClient) => Promise<void>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { injectClient } }))

// Map-backed fake StorageApi (mirrors adapter.test.ts) so persist/resume/clear exercise the REAL
// adapter + envelope + arktype validation — only the leader-election machinery is faked.
const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				open: () => Promise.resolve("persistent" as const),
				mode: () => Promise.resolve("persistent" as const),
				kvGet: (key: string) => Promise.resolve(fakeStore.get(key) ?? null),
				kvSet: (key: string, value: string) => {
					fakeStore.set(key, value)
					return Promise.resolve()
				},
				kvDelete: (key: string) => {
					fakeStore.delete(key)
					return Promise.resolve()
				},
				kvKeys: (prefix: string) => Promise.resolve([...fakeStore.keys()].filter(k => k.startsWith(prefix)))
			}
		})
}))

vi.stubGlobal("location", { search: "" })

import { persistSession, resumeSession, clearSession, SESSION_KV_KEY } from "@/lib/sdk/session"
import { log } from "@/lib/log"

function sampleBlob(): StringifiedClient {
	return {
		email: "user@example.com",
		userId: 123456789012345678n, // exceeds Number.MAX_SAFE_INTEGER — proves the bigint survives the envelope
		rootUuid: "root-uuid",
		authInfo: "auth-info",
		privateKey: "private-key",
		apiKey: "api-key",
		authVersion: 2
	}
}

beforeEach(() => {
	fakeStore.clear()
	vi.restoreAllMocks()
	injectClient.mockReset()
	injectClient.mockResolvedValue(undefined)
})

describe("session store (Map-backed fake kv, mocked worker inject)", () => {
	it("persist → resume round-trips the blob (bigint userId intact) and injects it", async () => {
		const blob = sampleBlob()

		await persistSession(blob)

		await expect(resumeSession()).resolves.toBe(true)
		expect(injectClient).toHaveBeenCalledTimes(1)
		expect(injectClient).toHaveBeenCalledWith(blob) // deep-equal incl. the bigint
	})

	it("resume with no persisted session returns false without injecting", async () => {
		await expect(resumeSession()).resolves.toBe(false)
		expect(injectClient).not.toHaveBeenCalled()
	})

	it("self-heals a persisted session the SDK rejects: warns, clears it, returns false, never boot-loops", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)

		await persistSession(sampleBlob())
		injectClient.mockRejectedValueOnce(new Error("stale session"))

		await expect(resumeSession()).resolves.toBe(false)

		expect(fakeStore.has(SESSION_KV_KEY)).toBe(false) // purged
		expect(warnSpy).toHaveBeenCalledWith("session", expect.stringContaining("clearing"), expect.anything())

		// The next boot finds nothing to inject — no repeat failure on the same blob.
		await expect(resumeSession()).resolves.toBe(false)
		expect(injectClient).toHaveBeenCalledTimes(1)
	})

	it("clear removes the persisted session so a later resume finds nothing", async () => {
		await persistSession(sampleBlob())
		expect(fakeStore.has(SESSION_KV_KEY)).toBe(true)

		await clearSession()

		expect(fakeStore.has(SESSION_KV_KEY)).toBe(false)
		await expect(resumeSession()).resolves.toBe(false)
		expect(injectClient).not.toHaveBeenCalled()
	})
})
