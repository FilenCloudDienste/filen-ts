import { beforeEach, describe, expect, it, vi } from "vitest"

// Every teardown collaborator is worker- or DOM-backed; the phased wipe itself is runLogout's own test
// (logout.test.ts). What matters here is WHEN — and whether — performLogout reaches it.
const { runLogout, toastWarning } = vi.hoisted(() => ({
	runLogout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
	toastWarning: vi.fn()
}))

vi.mock("@/lib/logout", () => ({ runLogout }))
vi.mock("@/features/notes/lib/sync", () => ({ sync: { cancel: vi.fn() } }))
vi.mock("@/features/chats/lib/sync", () => ({ sync: { cancel: vi.fn() } }))
vi.mock("@/features/chats/lib/typing", () => ({ clearAllTyping: vi.fn() }))
vi.mock("@/lib/sdk/socket", () => ({ socketBridge: { stop: vi.fn(() => Promise.resolve()) } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { logout: vi.fn() } }))
vi.mock("@/features/drive/lib/saveDownload", () => ({ wipeSwClient: vi.fn() }))
vi.mock("@/lib/sdk/session", () => ({ clearSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/lib/storage/adapter", () => ({ kvClear: vi.fn() }))
vi.mock("@/features/audio/lib/audioEngine", () => ({ disposeAudioEngine: vi.fn() }))
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
