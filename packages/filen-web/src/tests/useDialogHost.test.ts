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
const { shouldCloseDialogOnNavigate } = await import("@/lib/useDialogHost.logic")

describe("shouldCloseDialogOnNavigate", () => {
	it("closes an idle dialog", () => {
		expect(shouldCloseDialogOnNavigate({ hasDialog: true, pending: false, keepOpen: false })).toBe(true)
	})

	it("does nothing when no dialog is open", () => {
		expect(shouldCloseDialogOnNavigate({ hasDialog: false, pending: false, keepOpen: false })).toBe(false)
	})

	it("keeps a dialog whose mutation is still in flight", () => {
		expect(shouldCloseDialogOnNavigate({ hasDialog: true, pending: true, keepOpen: false })).toBe(false)
	})

	it("keeps a dialog whose host owns its navigation semantics", () => {
		expect(shouldCloseDialogOnNavigate({ hasDialog: true, pending: false, keepOpen: true })).toBe(false)
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

	it("does not close retroactively once a pending mutation settles", () => {
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

		expect(result.current.activeDialog).toEqual({ kind: "trash" })
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
