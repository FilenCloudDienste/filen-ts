import { beforeEach, describe, expect, it } from "vitest"
import { confirmDiscardUnsavedPreview, setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"

// Plain node — zustand needs no DOM, and this store deliberately holds nothing React-specific.

function settled<T>(promise: Promise<T>): Promise<T | "pending"> {
	return Promise.race([promise, Promise.resolve<"pending">("pending")])
}

beforeEach(() => {
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("confirmDiscardUnsavedPreview", () => {
	it("resolves true immediately and sets no logoutRequest when nothing is dirty", async () => {
		expect(await confirmDiscardUnsavedPreview()).toBe(true)
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
	})

	it("sets a logoutRequest and stays pending until it is answered", async () => {
		setPreviewDirty(true)

		const pending = confirmDiscardUnsavedPreview()

		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).not.toBeNull()
		expect(await settled(pending)).toBe("pending")

		usePreviewUnsavedGuardStore.getState().clear()
		await pending
	})

	it("resolves true when the request is answered with discard", async () => {
		setPreviewDirty(true)

		const pending = confirmDiscardUnsavedPreview()

		usePreviewUnsavedGuardStore.getState().logoutRequest?.resolve(true)

		expect(await pending).toBe(true)
	})

	it("resolves false when the request is cancelled", async () => {
		setPreviewDirty(true)

		const pending = confirmDiscardUnsavedPreview()

		usePreviewUnsavedGuardStore.getState().logoutRequest?.resolve(false)

		expect(await pending).toBe(false)
	})

	it("coalesces two concurrent asks onto one request and one answer", async () => {
		setPreviewDirty(true)

		const first = confirmDiscardUnsavedPreview()
		const request = usePreviewUnsavedGuardStore.getState().logoutRequest
		const second = confirmDiscardUnsavedPreview()

		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBe(request)

		request?.resolve(true)

		expect(await first).toBe(true)
		expect(await second).toBe(true)
	})

	// Load-bearing: clear() and the dialog are the ONLY settlement paths, so an overlay that unmounts
	// while a sign-out waits must release it or the sign-out soft-locks forever.
	it("clear() while a request is pending resolves it true and drops both the flag and the request", async () => {
		setPreviewDirty(true)

		const pending = confirmDiscardUnsavedPreview()

		usePreviewUnsavedGuardStore.getState().clear()

		expect(await pending).toBe(true)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
	})

	it("starts a fresh request after an earlier one settled", async () => {
		setPreviewDirty(true)

		const first = confirmDiscardUnsavedPreview()
		usePreviewUnsavedGuardStore.getState().logoutRequest?.resolve(false)
		expect(await first).toBe(false)

		usePreviewUnsavedGuardStore.setState({ logoutRequest: null })

		const second = confirmDiscardUnsavedPreview()

		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).not.toBeNull()

		usePreviewUnsavedGuardStore.getState().logoutRequest?.resolve(true)

		expect(await second).toBe(true)
	})
})
