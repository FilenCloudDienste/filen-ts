import { describe, expect, it, vi } from "vitest"
import type { DesktopTransferResult, DesktopUploadStart } from "@filen/shared/desktop"
import { directoryRootOf, uploadInCalls, uploadPaths } from "../preload/uploadPaths.ts"
import { TRANSFER_ITEMS_MAX } from "../shared/channels.ts"

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

describe("uploadInCalls", () => {
	const started = (ids: string[], skipped: number[] = []): DesktopTransferResult<DesktopUploadStart> => ({
		ok: true,
		value: { status: "started", ids, skipped }
	})
	const paths = Array.from({ length: TRANSFER_ITEMS_MAX * 2 + 1 }, (_, index) => `/d/${String(index)}`)

	it("sends one call per TRANSFER_ITEMS_MAX paths and joins their ids and skipped indexes", async () => {
		const call = vi.fn((chunk: string[]) => Promise.resolve(started([chunk[0] ?? ""], [0])))
		const cancel = vi.fn()

		expect(await uploadInCalls(paths, call, cancel)).toEqual(
			started(
				["/d/0", `/d/${String(TRANSFER_ITEMS_MAX)}`, `/d/${String(TRANSFER_ITEMS_MAX * 2)}`],
				[0, TRANSFER_ITEMS_MAX, TRANSFER_ITEMS_MAX * 2]
			)
		)
		expect(call.mock.calls.map(([chunk]) => chunk.length)).toEqual([TRANSFER_ITEMS_MAX, TRANSFER_ITEMS_MAX, 1])
		expect(cancel).not.toHaveBeenCalled()
	})

	it("a failed call cancels what the earlier calls started and answers its failure", async () => {
		const failure: DesktopTransferResult<DesktopUploadStart> = { ok: false, error: { code: "hostUnavailable" } }
		const call = vi
			.fn()
			.mockResolvedValueOnce(started(["a", "b"]))
			.mockResolvedValueOnce(failure)
		const cancel = vi.fn()

		expect(await uploadInCalls(paths, call, cancel)).toEqual(failure)
		expect(call).toHaveBeenCalledTimes(2)
		expect(cancel).toHaveBeenCalledWith(["a", "b"])
	})
})
