import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StringifiedClient } from "@filen/sdk-rs"
import type { DesktopBridge, DesktopSessionVault } from "@filen/shared/desktop"

// The real sdk client module imports a Vite `?worker`, unresolvable under node vitest — mock it down
// to the one method the session store calls. `injectClient` is a spy so the resume path is observable.
const { injectClient } = vi.hoisted(() => ({ injectClient: vi.fn<(blob: StringifiedClient) => Promise<void>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { injectClient } }))

// Map-backed fake StorageApi (mirrors adapter.test.ts) so persist/resume/clear exercise the REAL
// adapter + envelope + schema validation — only the leader-election machinery is faked.
const { fakeStore } = vi.hoisted(() => ({ fakeStore: new Map<string, string>() }))

vi.mock("@/lib/storage/leader", () => ({
	acquireStorage: () =>
		Promise.resolve({
			role: "leader" as const,
			api: {
				open: () => Promise.resolve(undefined),
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

// Spied so every session write, delete and resume is checked against the splash's signed-in hint.
const { writeSignedInHint } = vi.hoisted(() => ({ writeSignedInHint: vi.fn<(signedIn: boolean) => void>() }))

vi.mock("@/lib/signedInHint", () => ({ writeSignedInHint }))

// The desktop shell's bridge, swapped in per test; undefined is a plain browser.
const desktop = vi.hoisted(() => ({ bridge: undefined as DesktopBridge | undefined }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => desktop.bridge }))

import { persistSession, resumeSession, clearSession, clearSessionOutsideKv, hasPersistedSession } from "@/lib/sdk/session"
import { log } from "@/lib/log"
import { stringifyEnvelope } from "@/lib/serialize"

const SESSION_KV_KEY = "sdk.session.v1"

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
	writeSignedInHint.mockReset()
	desktop.bridge = undefined
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

// Login, password reset, the e2e seed and credential changes persist through persistSession; logout and a
// failed credential-change persist clear through clearSession. Wiring the hint here covers all of them.
describe("signed-in hint", () => {
	it("is set once a session is persisted", async () => {
		await persistSession(sampleBlob())

		expect(writeSignedInHint.mock.calls).toEqual([[true]])
	})

	it("is not set when the persist fails", async () => {
		vi.spyOn(fakeStore, "set").mockImplementationOnce(() => {
			throw new Error("write failed")
		})

		await expect(persistSession(sampleBlob())).rejects.toThrow("write failed")
		expect(writeSignedInHint).not.toHaveBeenCalled()
	})

	it("is cleared with the session", async () => {
		await clearSession()

		expect(writeSignedInHint.mock.calls).toEqual([[false]])
	})

	it("is reconciled by every resume outcome", async () => {
		await resumeSession()
		expect(writeSignedInHint.mock.lastCall).toEqual([false])

		await persistSession(sampleBlob())
		writeSignedInHint.mockClear()
		await resumeSession()
		expect(writeSignedInHint.mock.calls).toEqual([[true]])

		writeSignedInHint.mockClear()
		vi.spyOn(log, "warn").mockImplementation(() => undefined)
		injectClient.mockRejectedValueOnce(new Error("stale session"))
		await resumeSession()
		expect(writeSignedInHint.mock.calls).toEqual([[false]])
	})
})

describe("browser kv", () => {
	it("reads an unparseable or invalid row as no session, without clearing or injecting", async () => {
		const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined)

		fakeStore.set(SESSION_KV_KEY, "{")
		await expect(resumeSession()).resolves.toBe(false)

		fakeStore.set(SESSION_KV_KEY, stringifyEnvelope({ ...sampleBlob(), userId: 1 }))
		await expect(resumeSession()).resolves.toBe(false)

		expect(injectClient).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("private-key")
	})

	it("hasPersistedSession follows the kv row; the vault-only clear is a no-op", async () => {
		await expect(hasPersistedSession()).resolves.toBe(false)
		await persistSession(sampleBlob())
		await expect(hasPersistedSession()).resolves.toBe(true)

		await clearSessionOutsideKv()
		expect(fakeStore.has(SESSION_KV_KEY)).toBe(true)
	})
})

describe("desktop vault", () => {
	function installVault(stored: string | null = null) {
		const state = { stored }
		const vault = {
			state,
			get: vi.fn<DesktopSessionVault["get"]>(() => Promise.resolve(state.stored)),
			set: vi.fn<DesktopSessionVault["set"]>(blob => {
				state.stored = blob

				return Promise.resolve()
			}),
			clear: vi.fn<DesktopSessionVault["clear"]>(() => {
				state.stored = null

				return Promise.resolve()
			})
		}

		desktop.bridge = { platform: "darwin", session: vault, setTitleBarColors: () => undefined }

		return vault
	}

	it("persists the envelope to the vault only and resumes from it", async () => {
		const vault = installVault()
		const blob = sampleBlob()

		await persistSession(blob)

		expect(vault.state.stored).toBe(stringifyEnvelope(blob))
		expect(fakeStore.size).toBe(0)
		await expect(hasPersistedSession()).resolves.toBe(true)
		await expect(resumeSession()).resolves.toBe(true)
		expect(injectClient).toHaveBeenCalledWith(blob)
		expect(writeSignedInHint.mock.calls).toEqual([[true], [true]])
	})

	it("an unreadable vault rejects the resume and clears nothing", async () => {
		const vault = installVault(stringifyEnvelope(sampleBlob()))

		vault.get.mockRejectedValueOnce(new Error("locked"))

		await expect(resumeSession()).rejects.toThrow("locked")
		expect(vault.clear).not.toHaveBeenCalled()
		expect(vault.state.stored).not.toBeNull()
		expect(injectClient).not.toHaveBeenCalled()
	})

	it("a session the SDK rejects is cleared from the vault", async () => {
		vi.spyOn(log, "warn").mockImplementation(() => undefined)

		const vault = installVault(stringifyEnvelope(sampleBlob()))

		injectClient.mockRejectedValueOnce(new Error("stale session"))

		await expect(resumeSession()).resolves.toBe(false)
		expect(vault.clear).toHaveBeenCalledTimes(1)
		expect(vault.state.stored).toBeNull()
	})

	it("clears through the vault, also for a pending sign-out", async () => {
		const vault = installVault(stringifyEnvelope(sampleBlob()))

		await clearSession()
		expect(vault.clear).toHaveBeenCalledTimes(1)
		await expect(hasPersistedSession()).resolves.toBe(false)

		await clearSessionOutsideKv()
		expect(vault.clear).toHaveBeenCalledTimes(2)
	})
})
