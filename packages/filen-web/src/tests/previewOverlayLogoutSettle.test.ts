// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// ★ The overlay is the ONLY settler of the promise performLogout awaits. If either arm stops resolving
// it, a socket-driven (password-changed) force-logout waits forever: the wipe never runs and this
// browser keeps decrypted local state for a session the server already revoked. The store half and the
// pure decision (resolveUnsavedConfirm) are both pinned elsewhere; the overlay's own two calls are not.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	// The overlay blocks in-app navigation while dirty; an idle blocker is the "no navigation pending"
	// state, which is what isolates the logout arm here.
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

import "@/lib/i18n"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

// The external arm keeps the body a plain <img> — the save/editor machinery is not this file's subject.
const SOURCE: PreviewSource = { type: "external", url: "https://example.invalid/photo.png", name: "photo.png" }

function renderOverlay() {
	const onClose = vi.fn()

	const rendered = render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: [SOURCE],
			index: 0,
			onStep: vi.fn(),
			onClose,
			onItemRemoved: vi.fn()
		})
	)

	return { ...rendered, onClose }
}

function armLogoutRequest(): ReturnType<typeof vi.fn> {
	const resolve = vi.fn()

	usePreviewUnsavedGuardStore.setState({ dirty: true, logoutRequest: { resolve } })

	return resolve
}

beforeEach(() => {
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — settling a waiting sign-out", () => {
	it("prompts as soon as a sign-out is waiting on a dirty buffer", () => {
		armLogoutRequest()
		renderOverlay()

		expect(screen.getByRole("alertdialog")).toBeDefined()
	})

	it("Discard resolves the sign-out with 'proceed', clears the request and closes the overlay", () => {
		const resolve = armLogoutRequest()
		const { onClose } = renderOverlay()

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))

		expect(resolve).toHaveBeenCalledExactlyOnceWith(true)
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		// Closing is what makes the wipe deterministic: the editor unmounts, so nothing can re-dirty the
		// buffer during the teardown that follows.
		expect(onClose).toHaveBeenCalled()
	})

	it("Cancel resolves it with 'do not proceed' and clears the request — neither promise may strand", () => {
		const resolve = armLogoutRequest()
		const { onClose } = renderOverlay()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(resolve).toHaveBeenCalledExactlyOnceWith(false)
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("unmounting with a request still pending settles it rather than stranding the sign-out", () => {
		const resolve = armLogoutRequest()
		const { unmount } = renderOverlay()

		unmount()

		expect(resolve).toHaveBeenCalledExactlyOnceWith(true)
		expect(usePreviewUnsavedGuardStore.getState().logoutRequest).toBeNull()
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
	})
})
