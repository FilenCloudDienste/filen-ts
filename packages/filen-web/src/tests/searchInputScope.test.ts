import { describe, expect, it } from "vitest"
import { searchInputScope } from "@/features/drive/components/directoryListing.logic"
import { drive } from "@/locales/en/drive"

const ROOT_LABEL = "Cloud Drive"

describe("searchInputScope", () => {
	it("names the root at the root of Cloud Drive", () => {
		expect(searchInputScope({ variant: "drive", uuid: null, rootLabel: ROOT_LABEL, names: undefined })).toBe(ROOT_LABEL)
	})

	it("names the open directory once its name is known", () => {
		expect(searchInputScope({ variant: "drive", uuid: "d1", rootLabel: ROOT_LABEL, names: { d1: "Docs" } })).toBe("Docs")
		expect(searchInputScope({ variant: "drive", uuid: "d1", rootLabel: ROOT_LABEL, names: undefined })).toBeNull()
	})

	it("names nothing for the other listings' local filter", () => {
		expect(searchInputScope({ variant: "trash", uuid: null, rootLabel: ROOT_LABEL, names: undefined })).toBeNull()
		expect(searchInputScope({ variant: "sharedIn", uuid: "d1", rootLabel: ROOT_LABEL, names: { d1: "Docs" } })).toBeNull()
	})

	it("renders as the placeholder copy", () => {
		expect(drive.driveSearchIn.replace("{{directory}}", ROOT_LABEL)).toBe("Search in Cloud Drive")
		expect(drive.driveSearch).toBe("Search")
	})
})
