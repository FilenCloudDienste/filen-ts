import { vi, describe, it, expect } from "vitest"

// driveHiddenItems.ts exposes secureStore-backed accessors alongside its pure helpers; only the
// helpers are under test here, so no hook rendering and no store are needed.
vi.mock("@/lib/secureStore", () => ({
	default: { get: vi.fn() },
	useSecureStore: vi.fn()
}))

import { isHiddenDriveItem, DEFAULT_HIDE_HIDDEN_ITEMS, HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY } from "@/features/drive/driveHiddenItems"
import type { DriveItem } from "@/types"

function file(uuid: string, name: string | null, undecryptable = false): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			undecryptable,
			decryptedMeta: name === null ? null : ({ name } as DriveItem["data"]["decryptedMeta"])
		} as DriveItem["data"]
	} as DriveItem
}

function dir(uuid: string, name: string): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name } as DriveItem["data"]["decryptedMeta"]
		} as DriveItem["data"]
	} as DriveItem
}

// The shared variants carry their decrypted name in the same place (unwrapDirMeta / unwrapFileMeta
// stamp `decryptedMeta` on every variant), so the rule has to hold for them too — they reach the
// listing through sharedIn / sharedOut / links.
function variant(type: DriveItem["type"], uuid: string, name: string): DriveItem {
	return {
		type,
		data: {
			uuid,
			undecryptable: false,
			decryptedMeta: { name } as DriveItem["data"]["decryptedMeta"]
		} as DriveItem["data"]
	} as DriveItem
}

describe("hidden-item preference defaults", () => {
	it("defaults to showing hidden items", () => {
		expect(DEFAULT_HIDE_HIDDEN_ITEMS).toBe(false)
	})

	it("keys off a stable, namespaced secure-store key", () => {
		expect(HIDE_HIDDEN_ITEMS_SECURE_STORE_KEY).toBe("drive.hideHiddenItems")
	})
})

describe("isHiddenDriveItem", () => {
	it("treats a leading dot as hidden, for files and directories alike", () => {
		expect(isHiddenDriveItem(file("f1", ".env"))).toBe(true)
		expect(isHiddenDriveItem(dir("d1", ".thumb"))).toBe(true)
	})

	it("applies to every shared variant too", () => {
		for (const type of ["sharedFile", "sharedRootFile", "sharedDirectory", "sharedRootDirectory"] as const) {
			expect(isHiddenDriveItem(variant(type, "u1", ".secret"))).toBe(true)
			expect(isHiddenDriveItem(variant(type, "u2", "Reports"))).toBe(false)
		}
	})

	it("does not treat a dot elsewhere in the name as hidden", () => {
		expect(isHiddenDriveItem(file("f1", "notes.txt"))).toBe(false)
		expect(isHiddenDriveItem(dir("d1", "v1.2"))).toBe(false)
	})

	it("keeps an undecryptable item visible — its real name is unknown and its placeholder is not dotted", () => {
		expect(isHiddenDriveItem(file("f1", null, true))).toBe(false)
	})

	it("keeps an item with no decrypted name visible rather than guessing", () => {
		expect(isHiddenDriveItem(file("f1", null))).toBe(false)
	})
})
