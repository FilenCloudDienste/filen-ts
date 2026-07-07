import { describe, expect, it } from "vitest"
import { FileIcon, FolderIcon } from "lucide-react"
import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem } from "@/lib/drive/item"
import { fileIconFor } from "@/lib/drive/icon"

function mockDir(overrides: Partial<Dir> = {}): Dir {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		parent: "22222222-2222-2222-2222-222222222222",
		color: "default",
		timestamp: 1_700_000_000_000n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Documents" } },
		...overrides
	}
}

function mockFile(overrides: Partial<File> = {}): File {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
		},
		...overrides
	}
}

describe("fileIconFor", () => {
	it("returns the generic directory icon for a directory", () => {
		expect(fileIconFor(narrowItem(mockDir()))).toBe(FolderIcon)
	})

	it("returns the generic file icon for a file", () => {
		expect(fileIconFor(narrowItem(mockFile()))).toBe(FileIcon)
	})
})
