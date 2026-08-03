import { beforeEach, describe, expect, it, vi } from "vitest"

// Every teardown collaborator is worker- or DOM-backed; the phased wipe itself is runLogout's own test
// (logout.test.ts). What matters here is WHEN — and whether — performLogout reaches it.
//
// Each collaborator records its own name in `calls` before doing anything else, so the ORDER assertions
// below read one array instead of comparing invocation counters: the security property is that every
// plaintext producer is silenced BEFORE the wipe, not merely that each was called at some point.
const { calls, runLogout, notesCancel, chatsCancel, clearAllTyping, disposeAudioEngine, socketStop, toastWarning } = vi.hoisted(() => {
	const calls: string[] = []
	const record =
		<T>(name: string, result: () => T) =>
		() => {
			calls.push(name)

			return result()
		}

	return {
		calls,
		runLogout: vi.fn<() => Promise<void>>(record("runLogout", () => Promise.resolve())),
		notesCancel: vi.fn(record("notesSync.cancel", () => undefined)),
		chatsCancel: vi.fn(record("chatsSync.cancel", () => undefined)),
		clearAllTyping: vi.fn(record("clearAllTyping", () => undefined)),
		disposeAudioEngine: vi.fn(record("disposeAudioEngine", () => undefined)),
		socketStop: vi.fn(record("socketBridge.stop", () => Promise.resolve())),
		toastWarning: vi.fn()
	}
})

// Every step that must run before the wipe, in the order performLogout runs them.
const TEARDOWN_STEPS = ["notesSync.cancel", "chatsSync.cancel", "clearAllTyping", "disposeAudioEngine", "socketBridge.stop"]

vi.mock("@/lib/logout", () => ({ runLogout }))
vi.mock("@/features/notes/lib/sync", () => ({ sync: { cancel: notesCancel } }))
vi.mock("@/features/chats/lib/sync", () => ({ sync: { cancel: chatsCancel } }))
vi.mock("@/features/chats/lib/typing", () => ({ clearAllTyping }))
vi.mock("@/lib/sdk/socket", () => ({ socketBridge: { stop: socketStop } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { logout: vi.fn() } }))
vi.mock("@/features/drive/lib/saveDownload", () => ({ wipeSwClient: vi.fn() }))
vi.mock("@/lib/sdk/session", () => ({ clearSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/lib/storage/adapter", () => ({ kvClear: vi.fn() }))
vi.mock("@/features/audio/lib/audioEngine", () => ({ disposeAudioEngine }))
vi.mock("@/queries/client", () => ({ queryClient: { cancelQueries: vi.fn(), clear: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { warning: toastWarning } }))

import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { performLogout } from "@/features/shell/lib/performLogout"

// Stands in for the overlay's unsaved-changes prompt: waits for the request the guard armed, then
// answers it the way a Cancel click does.
async function declinePrompt(): Promise<void> {
	await vi.waitFor(() => {
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).not.toBeNull()
	})

	const request = usePreviewUnsavedGuardStore.getState().logoutRequest

	request?.resolve(false)
	usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
}

async function settleMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	calls.length = 0
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("performLogout", () => {
	it("runs the wipe straight away when no preview buffer is dirty", async () => {
		await expect(performLogout()).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("a user-initiated sign-out is genuinely cancelled at the unsaved-changes prompt", async () => {
		usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout()

		await declinePrompt()

		await expect(result).resolves.toBe(false)
		expect(runLogout).not.toHaveBeenCalled()
		expect(toastWarning).not.toHaveBeenCalled()
	})

	// The session is already revoked server-side, so declining can only buy time to copy the buffer out.
	it("a FORCED sign-out is only delayed by the prompt, never cancelled", async () => {
		usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		expect(runLogout).not.toHaveBeenCalled()
		expect(toastWarning).toHaveBeenCalledTimes(1)

		// The buffer is released (the preview was closed / unmounted) — the deferred wipe completes.
		usePreviewUnsavedGuardStore.getState().clear()

		await expect(result).resolves.toBe(true)
		expect(runLogout).toHaveBeenCalledTimes(1)
	})

	it("a forced sign-out with a clean buffer never shows the pending notice", async () => {
		await expect(performLogout({ forced: true })).resolves.toBe(true)
		expect(toastWarning).not.toHaveBeenCalled()
		expect(runLogout).toHaveBeenCalledTimes(1)
	})
})

// ★ SECURITY: the five pre-wipe teardown steps exist so no plaintext producer can outlive the wipe —
// an outbox flush, a typing timer or a live socket that fires AFTER kv-clear resurrects this account's
// decrypted queue on disk. That the steps run, run once, and run BEFORE runLogout is the property; the
// wipe itself is runLogout's own test.
describe("performLogout — pre-wipe teardown", () => {
	it("silences every plaintext producer exactly once, all of them before the wipe", async () => {
		await expect(performLogout()).resolves.toBe(true)

		expect(calls).toEqual([...TEARDOWN_STEPS, "runLogout"])

		for (const step of [notesCancel, chatsCancel, clearAllTyping, disposeAudioEngine, socketStop]) {
			expect(step).toHaveBeenCalledTimes(1)
		}
	})

	it("a declined user-initiated sign-out leaves the session completely intact", async () => {
		usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout()

		await declinePrompt()

		await expect(result).resolves.toBe(false)
		expect(calls).toEqual([])
	})

	it("a declined FORCED sign-out defers the teardown until the buffer is released, then runs all of it", async () => {
		usePreviewUnsavedGuardStore.setState({ dirty: true })

		const result = performLogout({ forced: true })

		await declinePrompt()
		await settleMicrotasks()

		// Still waiting on the buffer: nothing may be torn down yet, or the user loses the text the
		// pending notice just promised them a chance to copy.
		expect(calls).toEqual([])

		usePreviewUnsavedGuardStore.getState().clear()

		await expect(result).resolves.toBe(true)
		expect(calls).toEqual([...TEARDOWN_STEPS, "runLogout"])
	})
})
