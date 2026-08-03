// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react"
import { useContactsListSelection } from "@/features/contacts/hooks/useContactsListSelection"

const UUIDS = ["a", "b", "c", "d", "e"]

function clickEvent(modifiers: Partial<Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">> = {}): ReactMouseEvent {
	return { shiftKey: false, metaKey: false, ctrlKey: false, ...modifiers } as ReactMouseEvent
}

function optionTarget(): HTMLElement {
	const element = document.createElement("div")
	element.setAttribute("role", "option")

	return element
}

function keyEvent(
	key: string,
	options: { target?: HTMLElement; shiftKey?: boolean } = {}
): { event: ReactKeyboardEvent<HTMLDivElement>; preventDefault: ReturnType<typeof vi.fn> } {
	const preventDefault = vi.fn()
	const event = {
		key,
		shiftKey: options.shiftKey ?? false,
		target: options.target ?? optionTarget(),
		preventDefault
	} as unknown as ReactKeyboardEvent<HTMLDivElement>

	return { event, preventDefault }
}

describe("useContactsListSelection — pointer model", () => {
	it("plain click selects only that row", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 2, clickEvent())
		})

		expect([...result.current.selection.contacts]).toEqual(["c"])
		expect(result.current.selectedCount).toBe(1)
	})

	it("ctrl/cmd click builds a multi-selection", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 3, clickEvent({ metaKey: true }))
		})

		expect([...result.current.selection.contacts]).toEqual(["a", "d"])
	})

	it("shift click extends an inclusive range from the anchor", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 1, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 3, clickEvent({ shiftKey: true }))
		})

		expect([...result.current.selection.contacts]).toEqual(["b", "c", "d"])
	})

	it("clearSelection empties every bucket", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect("requests", ["r1"], 0, clickEvent({ ctrlKey: true }))
		})
		act(() => {
			result.current.clearSelection()
		})

		expect(result.current.selectedCount).toBe(0)
	})

	it("pruneSelection drops only the given uuids from the given section", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 0, clickEvent())
		})
		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 1, clickEvent({ metaKey: true }))
		})
		act(() => {
			result.current.pruneSelection("contacts", ["a"])
		})

		expect([...result.current.selection.contacts]).toEqual(["b"])
	})

	it("a resetKey change clears the selection, the anchor and every cursor", () => {
		const { result, rerender } = renderHook(({ resetKey }) => useContactsListSelection({ resetKey }), {
			initialProps: { resetKey: "all" }
		})

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 3, clickEvent())
		})

		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(3)

		rerender({ resetKey: "blocked" })

		expect(result.current.selectedCount).toBe(0)
		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(0)

		// A shift click after the reset has no anchor left to range from — it collapses to a plain select.
		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 2, clickEvent({ shiftKey: true }))
		})

		expect([...result.current.selection.contacts]).toEqual(["c"])
	})
})

describe("useContactsListSelection — roving cursor", () => {
	it("starts at the first row of every section", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(0)
		expect(result.current.activeIndexFor("blocked", UUIDS)).toBe(0)
	})

	it("follows a pointer select and resolves by uuid after a reorder", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 1, clickEvent())
		})

		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(1)
		expect(result.current.activeIndexFor("contacts", ["e", "d", "c", "b", "a"])).toBe(3)
	})

	it("falls back to the top of the section when the cursor row disappears", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 4, clickEvent())
		})

		expect(result.current.activeIndexFor("contacts", ["a", "b"])).toBe(0)
	})

	it("ArrowDown moves the cursor without changing the selection", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 0, clickEvent())
		})

		const { event, preventDefault } = keyEvent("ArrowDown")

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect(preventDefault).toHaveBeenCalledOnce()
		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(1)
		expect([...result.current.selection.contacts]).toEqual(["a"])
	})

	it("ArrowUp clamps at the top rather than wrapping", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		const { event } = keyEvent("ArrowUp")

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect(result.current.activeIndexFor("contacts", UUIDS)).toBe(0)
	})

	it("Space toggles the cursor row", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		const { event, preventDefault } = keyEvent(" ")

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect(preventDefault).toHaveBeenCalledOnce()
		expect([...result.current.selection.contacts]).toEqual(["a"])
	})

	it("Shift+ArrowDown extends the range through the same path a shift click takes", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		act(() => {
			result.current.handlePointerSelect("contacts", UUIDS, 1, clickEvent())
		})

		const { event } = keyEvent("ArrowDown", { shiftKey: true })

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect([...result.current.selection.contacts]).toEqual(["b", "c"])
	})

	it("leaves a key the listbox does not own alone", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		const { event, preventDefault } = keyEvent("a")

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect(preventDefault).not.toHaveBeenCalled()
		expect(result.current.selectedCount).toBe(0)
	})

	it("ignores a keypress that originated inside a row's own action button", () => {
		const { result } = renderHook(() => useContactsListSelection({ resetKey: "all" }))

		const { event, preventDefault } = keyEvent(" ", { target: document.createElement("button") })

		act(() => {
			result.current.handleKeyDown("contacts", UUIDS, event)
		})

		expect(preventDefault).not.toHaveBeenCalled()
		expect(result.current.selectedCount).toBe(0)
	})
})
