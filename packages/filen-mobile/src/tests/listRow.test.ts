import { vi, describe, it, expect } from "vitest"

// listRow.tsx imports several UI primitives at module scope; stub them so importing the module (for its
// pure className builders) doesn't pull native deps. `@filen/utils` (cn) is intentionally NOT mocked —
// the builders' real tailwind-merge output is what we assert on.
vi.mock("@/components/ui/view", () => ({ default: () => null }))
vi.mock("@/components/ui/text", () => ({ default: () => null }))
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: () => null }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }))
vi.mock("react-native-reanimated", () => ({ FadeIn: {}, FadeOut: {} }))
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }))

import { listRowOuterClassName, listRowInnerClassName, LIST_ROW_SELECTED_CLASS_NAME } from "@/components/ui/listRow"

describe("listRowOuterClassName", () => {
	it("emits the flat base layout classes", () => {
		const result = listRowOuterClassName({})

		expect(result).toContain("flex-row")
		expect(result).toContain("items-center")
		expect(result).toContain("px-4")
	})

	it("omits the selection tint when not selected", () => {
		expect(listRowOuterClassName({ selected: false })).not.toContain(LIST_ROW_SELECTED_CLASS_NAME)
	})

	it("applies the default selection tint when selected", () => {
		expect(listRowOuterClassName({ selected: true })).toContain(LIST_ROW_SELECTED_CLASS_NAME)
	})

	it("uses a custom selectedClassName instead of the default tint when provided", () => {
		const result = listRowOuterClassName({ selected: true, selectedClassName: "bg-background-secondary" })

		expect(result).toContain("bg-background-secondary")
		expect(result).not.toContain(LIST_ROW_SELECTED_CLASS_NAME)
	})

	it("does not apply a custom selectedClassName when not selected", () => {
		expect(listRowOuterClassName({ selected: false, selectedClassName: "bg-background-secondary" })).not.toContain(
			"bg-background-secondary"
		)
	})

	it("adds opacity-50 only when disabled", () => {
		expect(listRowOuterClassName({ disabled: true })).toContain("opacity-50")
		expect(listRowOuterClassName({ disabled: false })).not.toContain("opacity-50")
	})

	it("appends a caller className", () => {
		expect(listRowOuterClassName({ className: "list-row-marker" })).toContain("list-row-marker")
	})
})

describe("listRowInnerClassName", () => {
	it("emits the base inner layout classes", () => {
		const result = listRowInnerClassName({})

		expect(result).toContain("gap-4")
		expect(result).toContain("flex-1")
	})

	it("defaults to comfortable density (py-2)", () => {
		expect(listRowInnerClassName({})).toContain("py-2")
	})

	it("maps compact density to py-1.5", () => {
		const result = listRowInnerClassName({ density: "compact" })

		expect(result).toContain("py-1.5")
		expect(result).not.toContain("py-3")
	})

	it("maps relaxed density to py-3", () => {
		const result = listRowInnerClassName({ density: "relaxed" })

		expect(result).toContain("py-3")
		expect(result).not.toContain("py-1.5")
	})

	it("adds the inset separator only when requested", () => {
		expect(listRowInnerClassName({ separator: true })).toContain("border-border")
		expect(listRowInnerClassName({ separator: false })).not.toContain("border-border")
		expect(listRowInnerClassName({})).not.toContain("border-border")
	})

	it("appends a caller innerClassName", () => {
		expect(listRowInnerClassName({ innerClassName: "inner-marker" })).toContain("inner-marker")
	})
})
