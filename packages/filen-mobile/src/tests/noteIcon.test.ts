import { vi, describe, it, expect } from "vitest"

// icon.tsx imports NoteType from @filen/sdk-rs and Ionicons from @expo/vector-icons
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

import { NoteTypeExtended } from "@/features/notes/components/note/icon"
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
