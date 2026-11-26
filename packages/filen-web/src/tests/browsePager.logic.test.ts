import { describe, expect, it } from "vitest"
import type { File as SdkFile, LinkedDir } from "@filen/sdk-rs"
import { entryKey, entryName, toBrowseEntries, type BrowseEntry } from "@/features/publicLinks/lib/browse.logic"
import { pagerEntries, stepEntry, treeEntries } from "@/features/publicLinks/lib/browsePager.logic"
import { narrowItem } from "@/features/drive/lib/item"

function makeFile(uuid: `${string}-${string}-${string}-${string}`, name: string, mime: string): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime, size: 1024n, key: "k", version: 2, modified: 1n } },
		parent: "00000000-0000-0000-0000-000000000000",
		size: 1024n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

const SUB: LinkedDir = {
	inner: {
		uuid: "d0000000-0000-0000-0000-000000000001",
		parent: "00000000-0000-0000-0000-000000000000",
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "Sub" } }
	},
	linkedTag: true
}

const ENTRIES: BrowseEntry[] = toBrowseEntries({
	dirs: [SUB],
	files: [
		makeFile("f0000000-0000-0000-0000-000000000001", "b.jpg", "image/jpeg"),
		makeFile("f0000000-0000-0000-0000-000000000002", "a.pdf", "application/pdf"),
		makeFile("f0000000-0000-0000-0000-000000000003", "song.mp3", "audio/mpeg"),
		makeFile("f0000000-0000-0000-0000-000000000004", "bundle.zip", "application/zip"),
		makeFile("f0000000-0000-0000-0000-000000000005", "blob.bin", "application/octet-stream"),
		makeFile("f0000000-0000-0000-0000-000000000006", "clip.mp4", "video/mp4")
	]
})

function names(entries: readonly BrowseEntry[]): string[] {
	return entries.map(entryName)
}

describe("pagerEntries", () => {
	it("keeps admitted pageable files in the browser's order", () => {
		// No directory, no audio (its pager flag), nothing without a viewer; an archive only where its card downloads it.
		expect(names(pagerEntries(ENTRIES, false))).toEqual(["b.jpg", "a.pdf", "clip.mp4"])
		expect(names(pagerEntries(ENTRIES, true))).toEqual(["b.jpg", "a.pdf", "bundle.zip", "clip.mp4"])
		expect(names(pagerEntries([...ENTRIES].reverse(), false))).toEqual(["clip.mp4", "a.pdf", "b.jpg"])
	})
})

describe("stepEntry", () => {
	const pager = pagerEntries(ENTRIES, false)
	const [first, second, third] = pager

	it("clamps at both ends and never wraps", () => {
		if (first === undefined || second === undefined || third === undefined) {
			throw new Error("three entries expected")
		}

		expect(stepEntry(pager, entryKey(first), 1)).toBe(second)
		expect(stepEntry(pager, entryKey(second), -1)).toBe(first)
		expect(stepEntry(pager, entryKey(first), -1)).toBe(first)
		expect(stepEntry(pager, entryKey(third), 1)).toBe(third)
		expect(stepEntry(pager, entryKey(third), -2)).toBe(first)
		expect(stepEntry(pager, entryKey(first), 10)).toBe(third)
	})

	it("resolves nothing for a file the list does not hold", () => {
		expect(stepEntry(pager, "f0000000-0000-0000-0000-00000000ffff", 1)).toBeNull()
		expect(stepEntry([], "f0000000-0000-0000-0000-000000000001", 1)).toBeNull()
	})
})

describe("treeEntries", () => {
	it("wraps a slideshow's tree items as file entries over their own file", () => {
		const file = makeFile("f0000000-0000-0000-0000-000000000007", "deep.png", "image/png")
		const item = narrowItem(file)
		const [entry] = treeEntries([item])

		expect(entry?.kind).toBe("file")
		expect(entry?.item).toBe(item)
		expect(entry?.file.uuid).toBe(file.uuid)
	})
})
