// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { act, renderHook } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File } from "@filen/sdk-rs"
import type { Virtualizer } from "@tanstack/react-virtual"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import {
	startsWithTypeAhead,
	TYPE_AHEAD_RESET_MS,
	typeAheadBuffering,
	typeAheadCharacter,
	typeAheadIndex,
	type TypeAheadKeyEvent
} from "@/features/drive/lib/listbox"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useDriveListboxNav } from "@/features/drive/hooks/useDriveListboxNav"
import type { DriveVirtualizer } from "@/features/drive/hooks/useDriveVirtualizer"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import { usePhotosStore } from "@/features/photos/store/usePhotosStore"
import { usePhotosGridNav } from "@/features/photos/hooks/usePhotosGridNav"
import { buildPhotosTimeline } from "@/features/photos/lib/timeline"
import { testUuid } from "@/tests/support/uuid"

function plainKey(key: string, overrides: Partial<TypeAheadKeyEvent> = {}): TypeAheadKeyEvent {
	return { key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...overrides }
}

describe("typeAheadCharacter", () => {
	it("takes a printable key, Shift picking the character", () => {
		expect(typeAheadCharacter(plainKey("a"), false)).toBe("a")
		expect(typeAheadCharacter(plainKey("A"), false)).toBe("A")
		expect(typeAheadCharacter(plainKey("7"), false)).toBe("7")
		expect(typeAheadCharacter(plainKey("😀"), false)).toBe("😀")
	})

	it("leaves named keys alone", () => {
		for (const key of ["Enter", "F2", "ArrowDown", "Home", "Delete", "Backspace", "Escape", "Tab", "Dead"]) {
			expect(typeAheadCharacter(plainKey(key), false), key).toBeNull()
		}
	})

	it("leaves a chord with Ctrl, Cmd or Alt to its shortcut", () => {
		for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
			expect(typeAheadCharacter(plainKey("a", { [modifier]: true }), false), modifier).toBeNull()
		}
	})

	it("leaves a key an input method is composing with", () => {
		expect(typeAheadCharacter(plainKey("a", { isComposing: true }), false)).toBeNull()
		expect(typeAheadCharacter(plainKey("Process"), false)).toBeNull()
		expect(typeAheadCharacter(plainKey("a", { keyCode: 229 }), false)).toBeNull()
	})

	it("leaves a key typed into an editable", () => {
		const editable = document.createElement("div")

		editable.contentEditable = "true"
		// jsdom does not compute isContentEditable.
		Object.defineProperty(editable, "isContentEditable", { value: true })

		expect(typeAheadCharacter(plainKey("a", { target: editable }), false)).toBeNull()
	})

	it("continues a prefix with Space but never starts one", () => {
		expect(typeAheadCharacter(plainKey(" "), false)).toBeNull()
		expect(typeAheadCharacter(plainKey(" "), true)).toBe(" ")
	})
})

describe("typeAheadBuffering", () => {
	it("holds a prefix for TYPE_AHEAD_RESET_MS after its last key", () => {
		expect(typeAheadBuffering("", 0, 0)).toBe(false)
		expect(typeAheadBuffering("a", 1_000, 1_000 + TYPE_AHEAD_RESET_MS - 1)).toBe(true)
		expect(typeAheadBuffering("a", 1_000, 1_000 + TYPE_AHEAD_RESET_MS)).toBe(false)
	})
})

describe("startsWithTypeAhead", () => {
	it("ignores case and accents, composed or decomposed", () => {
		expect(startsWithTypeAhead("Report.pdf", "rep")).toBe(true)
		expect(startsWithTypeAhead("École", "eco")).toBe(true)
		expect(startsWithTypeAhead("École", "éc")).toBe(true)
		expect(startsWithTypeAhead("Report.pdf", "rx")).toBe(false)
		expect(startsWithTypeAhead("Re", "rep")).toBe(false)
	})
})

describe("typeAheadIndex", () => {
	const names = ["alpha", "beta", "apple", "Banana", "cherry"]
	const nameOf = (name: string) => name

	it("finds a fresh prefix after the cursor, wrapping past the end", () => {
		expect(typeAheadIndex(names, nameOf, 0, "a", true)).toBe(2)
		expect(typeAheadIndex(names, nameOf, 2, "a", true)).toBe(0)
		expect(typeAheadIndex(names, nameOf, 4, "b", true)).toBe(1)
	})

	it("keeps the cursor while a longer prefix still matches it", () => {
		expect(typeAheadIndex(names, nameOf, 1, "ba", false)).toBe(3)
		expect(typeAheadIndex(names, nameOf, 2, "ap", false)).toBe(2)
	})

	it("is -1 when nothing matches, or nothing is listed", () => {
		expect(typeAheadIndex(names, nameOf, 0, "z", true)).toBe(-1)
		expect(typeAheadIndex([], nameOf, 0, "a", true)).toBe(-1)
	})
})

function keyDown(key: string, target: HTMLElement, listbox: HTMLElement, overrides: Record<string, unknown> = {}) {
	return {
		key,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		target,
		currentTarget: listbox,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		...overrides
	} as unknown as ReactKeyboardEvent<HTMLDivElement>
}

function dirItem(name: string): DriveItem {
	const dir: Dir = {
		uuid: testUuid(name),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(dir)
}

describe("useDriveListboxNav — type-ahead", () => {
	const items = ["Archive", "Budget", "budget 2025", "Camera", "Notes"].map(dirItem)
	let listbox: HTMLElement
	let row: HTMLElement

	function renderNav() {
		const virtualizer = { scrollToIndex: vi.fn() } as unknown as DriveVirtualizer["activeVirtualizer"]
		const itemRefs: DriveVirtualizer["itemRefs"] = { registerRef: vi.fn(), focusItem: vi.fn() }

		return renderHook(() =>
			useDriveListboxNav({ items, viewMode: "list", columns: 1, virtualizer, itemRefs, variant: "drive", splat: "", onOpen: vi.fn() })
		).result
	}

	function type(result: ReturnType<typeof renderNav>, key: string, overrides: Record<string, unknown> = {}) {
		const preventDefault = vi.fn()
		const stopPropagation = vi.fn()
		const event = keyDown(key, row, listbox, { ...overrides, preventDefault, stopPropagation })

		act(() => {
			result.current.handleKeyDown(event)
		})

		return { preventDefault, stopPropagation }
	}

	beforeEach(() => {
		vi.useFakeTimers()
		useDriveStore.setState({ selectedItems: [], pendingReveal: null })
		listbox = document.createElement("div")
		row = listbox.appendChild(document.createElement("div"))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("jumps to the next name starting with what was typed, and cancels and stops the key", () => {
		const result = renderNav()
		const event = type(result, "b")

		expect(result.current.safeActiveIndex).toBe(1)
		expect(event.preventDefault).toHaveBeenCalled()
		expect(event.stopPropagation).toHaveBeenCalled()

		type(result, "u")
		type(result, "d")
		type(result, "g")
		type(result, "e")
		type(result, "t")
		type(result, " ")

		expect(result.current.safeActiveIndex).toBe(2)
		// Space continued the prefix: nothing was toggled.
		expect(useDriveStore.getState().selectedItems).toEqual([])
	})

	it("starts a new prefix after a pause, stepping on through the same letter, and wraps", () => {
		const result = renderNav()

		type(result, "b")
		vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS)
		type(result, "b")

		expect(result.current.safeActiveIndex).toBe(2)

		vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS)
		type(result, "a")

		expect(result.current.safeActiveIndex).toBe(0)
	})

	it("keeps the cursor where it is when nothing matches, still owning the key", () => {
		const result = renderNav()
		const event = type(result, "z")

		expect(result.current.safeActiveIndex).toBe(0)
		expect(event.preventDefault).toHaveBeenCalled()
	})

	it("leaves chords, composition and Space alone, Space toggling as before", () => {
		const result = renderNav()

		for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
			const event = type(result, "n", overrides)

			expect(event.stopPropagation, JSON.stringify(overrides)).not.toHaveBeenCalled()
		}

		expect(result.current.safeActiveIndex).toBe(0)

		type(result, " ")

		expect(useDriveStore.getState().selectedItems.map(item => item.data.uuid)).toEqual([testUuid("Archive")])
	})

	it("leaves keys typed in a control inside the row alone", () => {
		const result = renderNav()
		const input = row.appendChild(document.createElement("input"))
		const preventDefault = vi.fn()
		const event = keyDown("n", input, listbox, { preventDefault })

		act(() => {
			result.current.handleKeyDown(event)
		})

		expect(result.current.safeActiveIndex).toBe(0)
		expect(preventDefault).not.toHaveBeenCalled()
	})
})

function photoItem(name: string): PhotoItem {
	const file: File = {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: testUuid("root"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime: "image/jpeg", modified: 1n, size: 1n, key: "k", version: 2 } }
	}
	const item = narrowItem(file)

	if (item.type !== "file") {
		throw new Error("test fixture narrowed to a non-file arm")
	}

	return item
}

describe("usePhotosGridNav — type-ahead", () => {
	const items = ["IMG_0001.jpg", "beach.jpg", "IMG_0002.jpg", "sunset.jpg"].map(photoItem)

	beforeEach(() => {
		vi.useFakeTimers()
		usePhotosStore.setState({ selectedItems: [] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("jumps to the next photo whose name starts with what was typed, moving the anchor with it", () => {
		const listbox = document.createElement("div")
		const tile = listbox.appendChild(document.createElement("div"))
		const anchor = { uuid: null as string | null }
		const virtualizer = { scrollToIndex: vi.fn() } as unknown as Virtualizer<HTMLDivElement, Element>
		const { result } = renderHook(() =>
			usePhotosGridNav({
				items,
				timeline: buildPhotosTimeline(
					items.map(() => ({ year: 2023, month: 10 })),
					4,
					100,
					2
				),
				virtualizer,
				anchorUuid: anchor.uuid,
				setAnchorUuid: next => {
					anchor.uuid = next
				}
			})
		)

		act(() => {
			result.current.handleKeyDown(keyDown("s", tile, listbox))
		})

		expect(result.current.safeActiveIndex).toBe(3)
		expect(anchor.uuid).toBe(testUuid("sunset.jpg"))

		vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS)

		for (const key of ["i", "m", "g", "_", "0", "0", "0", "2"]) {
			act(() => {
				result.current.handleKeyDown(keyDown(key, tile, listbox))
			})
		}

		expect(result.current.safeActiveIndex).toBe(2)

		// Shift with a letter types it.
		vi.advanceTimersByTime(TYPE_AHEAD_RESET_MS)

		act(() => {
			result.current.handleKeyDown(keyDown("B", tile, listbox, { shiftKey: true }))
		})

		expect(result.current.safeActiveIndex).toBe(1)
		expect(usePhotosStore.getState().selectedItems).toEqual([])
	})
})
