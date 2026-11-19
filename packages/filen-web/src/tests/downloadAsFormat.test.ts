import { describe, expect, it } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { downloadAsFormat } from "@/features/drive/lib/downloadAs.logic"

// A file's Download as format comes from the table's own rows only, never from a key every object inherits.

function file(name: string): DriveItem {
	return narrowItem({
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		}
	} satisfies File)
}

describe("downloadAsFormat", () => {
	it("reads the format from the extension, case-insensitively", () => {
		expect(downloadAsFormat(file("a.DOTM"))).toBe("docx")
		expect(downloadAsFormat(file("a.ott"))).toBe("odt")
		expect(downloadAsFormat(file("a.dot"))).toBe("doc")
		expect(downloadAsFormat(file("a.txt"))).toBeNull()
	})

	it("names no format for an extension that is an inherited object key", () => {
		for (const name of ["a.constructor", "a.__proto__"]) {
			expect(downloadAsFormat(file(name)), name).toBeNull()
		}
	})
})
