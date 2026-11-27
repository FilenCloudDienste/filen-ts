import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem } from "@/features/drive/lib/item"
import { extensionChange, nameHolder } from "@/features/drive/hooks/useNameFieldCheck"

function file(name: string) {
	return narrowItem({
		uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "home-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

describe("nameHolder", () => {
	it("finds the item holding a name case-insensitively and across NFC/NFD, the renamed item aside", () => {
		const own = file("notes.txt")
		const other = file("Café.md")

		expect(nameHolder([own, other], "café.MD")).toBe(other)
		expect(nameHolder([own, other], "NOTES.txt", own.data.uuid)).toBeUndefined()
		expect(nameHolder([own, other], "NOTES.txt")).toBe(own)
		expect(nameHolder(undefined, "notes.txt")).toBeUndefined()
	})
})

describe("extensionChange", () => {
	it("warns only when the extension itself changes", () => {
		expect(extensionChange("photo.JPG", "holiday.jpg")).toBeNull()
		expect(extensionChange("notes.txt", "notes.md")).toEqual({ from: "txt", to: "md" })
		expect(extensionChange("notes.txt", "notes")).toEqual({ from: "txt", to: "" })
		expect(extensionChange("Makefile", "Makefile.bak")).toEqual({ from: "", to: "bak" })
	})
})
