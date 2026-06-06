import { vi, describe, it, expect } from "vitest"

// icon.tsx imports NoteType from @filen/sdk-rs (native uniffi build).
// The native binding generates a numeric TypeScript enum: Text=0, Md=1, Code=2, Rich=3, Checklist=4.
// These values match the real filen_types.ts generated enum and are correct for ICON_PROPS key indexing.
vi.mock("@filen/sdk-rs", () => {
	const NoteType = {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}

	return { NoteType }
})

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("@expo/vector-icons/Ionicons", () => ({
	default: () => null
}))

vi.mock("uniwind", () => ({
	withUniwind: (c: unknown) => c,
	useResolveClassNames: () => ({ color: "#000000" }),
	useUniwind: () => ({ theme: "dark" })
}))

vi.mock("react", () => ({
	memo: (c: unknown) => c
}))

import { NoteTypeExtended, ICON_PROPS } from "@/features/notes/components/note/icon"
import { NoteType } from "@filen/sdk-rs"

// The ICON_PROPS map and selection IIFE inside the Icon component body are not exported
// and cannot be unit-tested without rendering native components. Those cases are deferred.
// We test the exported NoteTypeExtended enum and its relationship to NoteType values.

describe("NoteTypeExtended", () => {
	it("Trash has a value distinct from all NoteType values", () => {
		const noteTypeValues = [NoteType.Text, NoteType.Md, NoteType.Code, NoteType.Rich, NoteType.Checklist]

		expect(noteTypeValues).not.toContain(NoteTypeExtended.Trash)
	})

	it("Archive has a value distinct from all NoteType values", () => {
		const noteTypeValues = [NoteType.Text, NoteType.Md, NoteType.Code, NoteType.Rich, NoteType.Checklist]

		expect(noteTypeValues).not.toContain(NoteTypeExtended.Archive)
	})

	it("Trash and Archive have different values (both icon states are distinct)", () => {
		expect(NoteTypeExtended.Trash).not.toBe(NoteTypeExtended.Archive)
	})

	it("Trash enum value is 101", () => {
		expect(NoteTypeExtended.Trash).toBe(101)
	})

	it("Archive enum value is 102", () => {
		expect(NoteTypeExtended.Archive).toBe(102)
	})
})

describe("ICON_PROPS — NoteType key indexing", () => {
	it("NoteType.Text maps to text-outline icon with blue color", () => {
		const props = ICON_PROPS[NoteType.Text]

		expect(props.name).toBe("text-outline")
		expect(props.color).toBe("#3b82f6")
	})

	it("NoteType.Md maps to logo-markdown icon with indigo color", () => {
		const props = ICON_PROPS[NoteType.Md]

		expect(props.name).toBe("logo-markdown")
		expect(props.color).toBe("#6366f1")
	})

	it("NoteType.Code maps to code-outline icon with red color", () => {
		const props = ICON_PROPS[NoteType.Code]

		expect(props.name).toBe("code-outline")
		expect(props.color).toBe("#ef4444")
	})

	it("NoteType.Rich maps to document-text-outline icon with cyan color", () => {
		const props = ICON_PROPS[NoteType.Rich]

		expect(props.name).toBe("document-text-outline")
		expect(props.color).toBe("#06b6d4")
	})

	it("NoteType.Checklist maps to checkmark-circle-outline icon with purple color", () => {
		const props = ICON_PROPS[NoteType.Checklist]

		expect(props.name).toBe("checkmark-circle-outline")
		expect(props.color).toBe("#a855f7")
	})

	it("NoteTypeExtended.Trash maps to trash-outline icon with red color", () => {
		const props = ICON_PROPS[NoteTypeExtended.Trash]

		expect(props.name).toBe("trash-outline")
		expect(props.color).toBe("#ef4444")
	})

	it("NoteTypeExtended.Archive maps to archive-outline icon with yellow color", () => {
		const props = ICON_PROPS[NoteTypeExtended.Archive]

		expect(props.name).toBe("archive-outline")
		expect(props.color).toBe("#eab308")
	})

	it("every NoteType key has a defined entry in ICON_PROPS", () => {
		const noteTypeValues = [NoteType.Text, NoteType.Md, NoteType.Code, NoteType.Rich, NoteType.Checklist]

		for (const key of noteTypeValues) {
			const props = ICON_PROPS[key as keyof typeof ICON_PROPS]

			expect(props).toBeDefined()
			expect(typeof props.name).toBe("string")
			expect(typeof props.color).toBe("string")
		}
	})
})
