import { describe, expect, it } from "vitest"
import { directoryRootOf, uploadPaths } from "../preload/uploadPaths.ts"

// A File as the preload sees it: `path` stands in for what webUtils.getPathForFile answers ("" when it has none).
interface TestFile {
	path: string | Error
	webkitRelativePath: string
}

function file(path: string | Error, webkitRelativePath = ""): TestFile {
	return { path, webkitRelativePath }
}

function pathOf(file: TestFile): string {
	if (file.path instanceof Error) {
		throw file.path
	}

	return file.path
}

describe("uploadPaths", () => {
	it("uploadPaths returns paths in order and the indexes of Files without one", () => {
		expect(uploadPaths([file("/a/x.txt"), file(""), file("/a/dir"), file("")], pathOf)).toEqual({
			paths: ["/a/x.txt", "/a/dir"],
			indexes: [0, 2],
			skipped: [1, 3]
		})
	})

	it("uploadPaths keeps duplicates", () => {
		expect(uploadPaths([file("/a/x.txt"), file("/a/x.txt")], pathOf)).toEqual({
			paths: ["/a/x.txt", "/a/x.txt"],
			indexes: [0, 1],
			skipped: []
		})
	})

	it("uploadPaths skips a File whose path lookup throws", () => {
		expect(uploadPaths([file(new Error("not a File")), file("/a/y.txt")], pathOf)).toEqual({
			paths: ["/a/y.txt"],
			indexes: [1],
			skipped: [0]
		})
	})
})

describe("directoryRootOf", () => {
	it("directoryRootOf returns the picked directory, not its parent", () => {
		expect(directoryRootOf([file("/x/dir/a/b.txt", "dir/a/b.txt"), file("/x/dir/c.txt", "dir/c.txt")], pathOf)).toBe("/x/dir")
		expect(directoryRootOf([file("C:\\x\\dir\\a\\b.txt", "dir/a/b.txt")], pathOf)).toBe("C:\\x\\dir")
	})

	it("directoryRootOf returns null for Files from two roots", () => {
		expect(directoryRootOf([file("/x/dir/a.txt", "dir/a.txt"), file("/y/dir/b.txt", "dir/b.txt")], pathOf)).toBeNull()
	})

	it("directoryRootOf returns null without Files, paths or relative paths that match", () => {
		expect(directoryRootOf([], pathOf)).toBeNull()
		expect(directoryRootOf([file("", "dir/a.txt")], pathOf)).toBeNull()
		expect(directoryRootOf([file(new Error("not a File"), "dir/a.txt")], pathOf)).toBeNull()
		expect(directoryRootOf([file("/x/a.txt", "")], pathOf)).toBeNull()
		expect(directoryRootOf([file("/x/a.txt", "a.txt")], pathOf)).toBeNull()
		expect(directoryRootOf([file("/x/other/a.txt", "dir/a.txt")], pathOf)).toBeNull()
		expect(directoryRootOf([file("/x/subdir/a.txt", "dir/a.txt")], pathOf)).toBeNull()
	})
})
