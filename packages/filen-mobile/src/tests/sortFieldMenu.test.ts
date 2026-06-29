import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"

// Hoisted mock for the actionSheet façade so we can assert show() calls.
const { mockShow } = vi.hoisted(() => ({ mockShow: vi.fn() }))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@/providers/actionSheet.provider", () => ({ actionSheet: { show: mockShow } }))

import { buildSortFieldButton } from "@/components/ui/sortFieldMenu"
import { Platform } from "react-native"

// t() stub returning the key verbatim for structural assertions.
const t = (key: string) => key

// Three string values so the "different field" case can pass a value outside this field's pair.
type Dir = "nameAsc" | "nameDesc" | "sizeAsc"

function makeOptions(): { id: string; title: string; value: Dir }[] {
	return [
		{ id: "field.asc", title: "Ascending", value: "nameAsc" },
		{ id: "field.desc", title: "Descending", value: "nameDesc" }
	]
}

describe("buildSortFieldButton", () => {
	beforeEach(() => {
		mockShow.mockClear()
		Platform.OS = "ios"
	})

	afterEach(() => {
		Platform.OS = "ios"
	})

	describe("iOS / non-Android (nested submenu, unchanged behavior)", () => {
		it("returns a field submenu of direction leaves with no onPress on the field", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				icon: "text",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			expect(btn.id).toBe("field")
			expect(btn.title).toBe("Name")
			expect(btn.subButtons).toHaveLength(2)
			expect(btn.onPress).toBeUndefined()
		})

		it("marks the current direction leaf checked and the others unchecked", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			expect(btn.subButtons?.[0]?.checked).toBe(true)
			expect(btn.subButtons?.[1]?.checked).toBe(false)
		})

		it("leaf carries no subButtons key (iOS leaf-vs-submenu discriminator)", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})
			const leaf = btn.subButtons?.[0]

			expect(leaf && "subButtons" in leaf).toBe(false)
		})

		it("leaf onPress calls setSort with its own value", () => {
			const setSort = vi.fn()
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort,
				t: t as never
			})

			btn.subButtons?.[1]?.onPress?.()

			expect(setSort).toHaveBeenCalledTimes(1)
			expect(setSort).toHaveBeenCalledWith("nameDesc")
		})

		it("does not open an action sheet on iOS", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			btn.onPress?.()

			expect(mockShow).not.toHaveBeenCalled()
		})
	})

	describe("Android (collapsed to an action sheet)", () => {
		beforeEach(() => {
			Platform.OS = "android"
		})

		it("returns a leaf field button with no nested subButtons key, but an onPress", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				icon: "text",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			expect("subButtons" in btn).toBe(false)
			expect(typeof btn.onPress).toBe("function")
		})

		it("checks the field when the current sort is one of its directions", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameDesc",
				setSort: vi.fn(),
				t: t as never
			})

			expect(btn.checked).toBe(true)
		})

		it("does not check the field when the current sort belongs to a different field", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "sizeAsc",
				setSort: vi.fn(),
				t: t as never
			})

			expect(btn.checked).toBe(false)
		})

		it("onPress opens an action sheet titled with the field, listing the directions then cancel", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			btn.onPress?.()

			expect(mockShow).toHaveBeenCalledTimes(1)

			const opts = mockShow.mock.calls[0]?.[0]

			expect(opts.title).toBe("Name")
			expect(opts.buttons.map((b: { title: string }) => b.title)).toEqual(["Ascending (current)", "Descending", "cancel"])
			expect(opts.buttons.at(-1).cancel).toBe(true)
		})

		it("marks the current direction with (current) and leaves the other unmarked", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameDesc",
				setSort: vi.fn(),
				t: t as never
			})

			btn.onPress?.()

			const opts = mockShow.mock.calls[0]?.[0]

			expect(opts.buttons[0].title).toBe("Ascending")
			expect(opts.buttons[1].title).toBe("Descending (current)")
		})

		it("tapping a direction in the action sheet calls setSort with that value", () => {
			const setSort = vi.fn()
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort,
				t: t as never
			})

			btn.onPress?.()

			const opts = mockShow.mock.calls[0]?.[0]

			opts.buttons[1].onPress()

			expect(setSort).toHaveBeenCalledTimes(1)
			expect(setSort).toHaveBeenCalledWith("nameDesc")
		})

		it("the cancel button has no onPress (pure dismiss)", () => {
			const btn = buildSortFieldButton({
				id: "field",
				title: "Name",
				options: makeOptions(),
				current: "nameAsc",
				setSort: vi.fn(),
				t: t as never
			})

			btn.onPress?.()

			const opts = mockShow.mock.calls[0]?.[0]

			expect(opts.buttons.at(-1).onPress).toBeUndefined()
		})
	})
})
