// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

interface TestDialog {
	kind: string
	index?: number
}

let currentHref = "/drive"

vi.mock("@tanstack/react-router", () => ({
	useRouterState: ({ select }: { select: (state: { location: { href: string } }) => string }) =>
		select({ location: { href: currentHref } })
}))

const { useDialogHost } = await import("@/lib/useDialogHost")
const { resolveDialogNavigationClose } = await import("@/lib/useDialogHost.logic")

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
	it("holds the close while the mutation is in flight, then applies it once it settles", () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "trash" })
			result.current.setDialogPending(true)
		})

		currentHref = "/drive/sub"
		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "trash" })

		act(() => {
			result.current.setDialogPending(false)
		})

		rerender()

		expect(result.current.activeDialog).toBeNull()
	})

	it("a dialog opened without a navigation still survives a mutation settling", () => {
		const { result, rerender } = renderHook(() => useDialogHost<TestDialog>())

		act(() => {
			result.current.setActiveDialog({ kind: "rename" })
			result.current.setDialogPending(true)
		})

		rerender()

		act(() => {
			result.current.setDialogPending(false)
		})

		rerender()

		expect(result.current.activeDialog).toEqual({ kind: "rename" })
	})

	it("a keepOpen kind is never closed retroactively either", () => {
		const { result, rerender } = renderHook(() =>
			useDialogHost<TestDialog>({ keepOpenOnNavigate: dialog => dialog.kind === "preview" })
		)

		act(() => {
			result.current.setActiveDialog({ kind: "preview" })
			result.current.setDialogPending(true)
		})

		currentHref = "/drive/sub"
		rerender()

		act(() => {
			result.current.setDialogPending(false)
		})

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
})
