// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { DialogHost } from "@/lib/useDialogHost"

interface TestDialog {
	kind: string
	index?: number
}

let currentHref = "/drive"

vi.mock("@tanstack/react-router", () => ({
	useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
		select({ location: { href: currentHref } })
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const { useDialogHost } = await import("@/lib/useDialogHost")
const { resolveDialogNavigationClose } = await import("@/lib/useDialogHost.logic")
const { toast } = await import("sonner")

// Starts a host-owned mutation that stays in flight until the returned settle is awaited.
function startPendingOp(host: DialogHost<TestDialog>): () => Promise<void> {
	const { promise, resolve } = Promise.withResolvers<undefined>()
	const running = host.runDialogPending(() => promise)

	return async () => {
		resolve(undefined)
		await running
	}
}

describe("resolveDialogNavigationClose", () => {
	it("closes an idle dialog", () => {
		expect(resolveDialogNavigationClose({ hasDialog: true, pending: false, keepOpen: false })).toBe("close")
	})

	it("does nothing when no dialog is open", () => {
		expect(resolveDialogNavigationClose({ hasDialog: false, pending: false, keepOpen: false })).toBe("ignore")
	})

	it("defers — never drops — the close while the mutation is still in flight", () => {
		expect(resolveDialogNavigationClose({ hasDialog: true, pending: true, keepOpen: false })).toBe("defer")
	})

	it("keeps a dialog whose host owns its navigation semantics, pending or not", () => {
		expect(resolveDialogNavigationClose({ hasDialog: true, pending: false, keepOpen: true })).toBe("ignore")
		expect(resolveDialogNavigationClose({ hasDialog: true, pending: true, keepOpen: true })).toBe("ignore")
	})
})

describe("useDialogHost", () => {
	beforeEach(() => {
		currentHref = "/drive"
		vi.mocked(toast.error).mockClear()
	})

	it("does not close a dialog opened without a navigation", () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "info" })
		})

		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "info" })
		expect(result.current.isDialogOpen).toBe(true)
	})

	it("closes the open dialog when the location changes", () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "info" })
		})

		currentHref = "/drive/sub"
		rerender()

		expect(result.current.activeDialog).toBeNull()
		expect(result.current.isDialogOpen).toBe(false)
	})

	// The strand this guards: the host's error arm keeps the dialog open for a retry, but the user has
	// already navigated away from the screen it belongs to.
	it("holds the close while the mutation is in flight, then applies it once it settles", async () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		let settle = (): Promise<void> => Promise.resolve()

		act(() => {
			result.current.setActiveDialog({ kind: "trash" })
			settle = startPendingOp(result.current)
		})

		currentHref = "/drive/sub"
		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "trash" })

		await act(settle)

		rerender()

		expect(result.current.activeDialog).toBeNull()
	})

	it("a dialog opened without a navigation still survives a mutation settling", async () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		let settle = (): Promise<void> => Promise.resolve()

		act(() => {
			result.current.setActiveDialog({ kind: "rename" })
			settle = startPendingOp(result.current)
		})

		rerender()

		await act(settle)

		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "rename" })
	})

	it("a keepOpen kind is never closed retroactively either", async () => {
		const { result, rerender } = renderHook(() =>
			useDialogHost<TestDialog>({ keepOpenOnNavigate: dialog => dialog.kind === "preview" })
		)

		let settle = (): Promise<void> => Promise.resolve()

		act(() => {
			result.current.setActiveDialog({ kind: "preview" })
			settle = startPendingOp(result.current)
		})

		currentHref = "/drive/sub"
		rerender()

		await act(settle)

		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "preview" })
	})

	it("hands keepOpenOnNavigate the live dialog and honours its opt-out per kind", () => {
		const keepOpenOnNavigate = vi.fn((dialog: TestDialog) => dialog.kind === "preview")
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>({ keepOpenOnNavigate }))

		act(() => {
			result.current.setActiveDialog({ kind: "preview", index: 3 })
		})

		currentHref = "/drive/sub"
		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "preview", index: 3 })
		expect(keepOpenOnNavigate).toHaveBeenLastCalledWith({ kind: "preview", index: 3 })

		act(() => {
			result.current.setActiveDialog({ kind: "info" })
		})

		currentHref = "/drive/sub/deeper"
		rerender()

		expect(result.current.activeDialog).toBeNull()
	})

	it("closes once per navigation, not on every later render", () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "info" })
		})

		currentHref = "/drive/sub"
		rerender()

		expect(result.current.activeDialog).toBeNull()

		act(() => {
			result.current.setActiveDialog({ kind: "rename" })
		})

		rerender()
		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "rename" })
	})

	it("runDialogOutcome closes on success and resolves true", async () => {
		const { result } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "rename" })
		})

		let succeeded = false

		await act(async () => {
			succeeded = await result.current.runDialogOutcome(() => Promise.resolve({ status: "success" }))
		})

		expect(succeeded).toBe(true)
		expect(result.current.activeDialog).toBeNull()
		expect(result.current.dialogPending).toBe(false)
		expect(toast.error).not.toHaveBeenCalled()
	})

	it("runDialogOutcome toasts on error and keeps the dialog open for a retry", async () => {
		const { result } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "rename" })
		})

		let succeeded = true

		await act(async () => {
			succeeded = await result.current.runDialogOutcome(() =>
				Promise.resolve({ status: "error", dto: { species: "plain", label: "", message: "boom" } })
			)
		})

		expect(succeeded).toBe(false)
		expect(result.current.activeDialog).toEqual({ kind: "rename" })
		expect(result.current.dialogPending).toBe(false)
		expect(toast.error).toHaveBeenCalledTimes(1)
	})
})
