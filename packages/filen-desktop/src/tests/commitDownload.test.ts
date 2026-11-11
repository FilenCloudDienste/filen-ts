import path from "node:path"
import { describe, expect, it } from "vitest"
import { commitDownload, makeFreeDirectory, stagingPathOf } from "../native/commitDownload.ts"
import { TransferCommitError } from "../native/transferErrors.ts"
import { memoryFs } from "./fileFakes.ts"

const DIR = path.resolve("downloads")
const at = (name: string) => path.join(DIR, name)
const STAGING = at("0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b.filendl")

describe("stagingPathOf", () => {
	it("names a uuid .filendl beside the target", () => {
		expect(stagingPathOf(at("a.txt"), "0d3c6b1e-8f4a-4c2d-9b7e-5a1f3e2d4c6b")).toBe(STAGING)
	})
})

describe("commitDownload", () => {
	it("replace renames over an existing target", async () => {
		const { fs, state } = memoryFs([STAGING, at("a.txt")])

		await expect(commitDownload(fs, STAGING, at("a.txt"), "replace", "darwin")).resolves.toBe(at("a.txt"))
		expect([...state.files]).toEqual([at("a.txt")])
	})

	it("replace onto a target in use answers localInUse on win32", async () => {
		const { fs, state, error } = memoryFs([STAGING, at("a.txt")])

		state.fail = op => (op === "rename" ? error("EPERM", at("a.txt")) : undefined)

		const failure: unknown = await commitDownload(fs, STAGING, at("a.txt"), "replace", "win32").catch((caught: unknown) => caught)

		expect(failure).toBeInstanceOf(TransferCommitError)
		expect((failure as TransferCommitError).code).toBe("localInUse")
		await expect(commitDownload(fs, STAGING, at("a.txt"), "replace", "linux")).rejects.toMatchObject({ code: "EPERM" })
	})

	it("keepBoth takes the name when it is free", async () => {
		const { fs, state } = memoryFs([STAGING])

		await expect(commitDownload(fs, STAGING, at("a.txt"), "keepBoth", "darwin")).resolves.toBe(at("a.txt"))
		expect([...state.files]).toEqual([at("a.txt")])
	})

	it('keepBoth picks "a (1).txt" when a.txt appeared meanwhile', async () => {
		const { fs, state } = memoryFs([STAGING, at("a.txt")])

		await expect(commitDownload(fs, STAGING, at("a.txt"), "keepBoth", "darwin")).resolves.toBe(at("a (1).txt"))
		expect(state.files).toEqual(new Set([at("a.txt"), at("a (1).txt")]))
	})

	it("keepBoth falls back to a wx placeholder when link is unsupported", async () => {
		const { fs, state, error } = memoryFs([STAGING])
		const ops: string[] = []

		state.fail = (op, target) => {
			ops.push(`${op} ${path.basename(target)}`)

			return op === "link" ? error("ENOTSUP", target) : undefined
		}

		await expect(commitDownload(fs, STAGING, at("a.txt"), "keepBoth", "linux")).resolves.toBe(at("a.txt"))
		expect(ops).toEqual(["link a.txt", "open a.txt", "rename a.txt"])
		expect([...state.files]).toEqual([at("a.txt")])
	})

	it("the placeholder fallback skips a name created between tries", async () => {
		const { fs, state, error } = memoryFs([STAGING])

		state.fail = (op, target) => {
			if (op === "link") {
				// a.txt shows up after the link attempt, before the placeholder.
				state.files.add(at("a.txt"))

				return error("EXDEV", target)
			}

			return undefined
		}

		await expect(commitDownload(fs, STAGING, at("a.txt"), "keepBoth", "linux")).resolves.toBe(at("a (1).txt"))
		expect(state.files).toEqual(new Set([at("a.txt"), at("a (1).txt")]))
	})

	it("a failed rename over the placeholder leaves no empty file under the name", async () => {
		const { fs, state, error } = memoryFs([STAGING])

		state.fail = (op, target) => (op === "link" ? error("EPERM", target) : op === "rename" ? error("EIO", target) : undefined)

		await expect(commitDownload(fs, STAGING, at("a.txt"), "keepBoth", "linux")).rejects.toMatchObject({ code: "EIO" })
		expect([...state.files]).toEqual([STAGING])
	})
})

describe("makeFreeDirectory", () => {
	it('picks "dir (1)" on EEXIST', async () => {
		const { fs, state } = memoryFs([], [at("dir")])

		await expect(makeFreeDirectory(fs, at("dir"))).resolves.toBe(at("dir (1)"))
		expect(state.dirs.has(at("dir (1)"))).toBe(true)
	})

	it("rethrows anything but EEXIST", async () => {
		const { fs, state, error } = memoryFs()

		state.fail = (_op, target) => error("EACCES", target)

		await expect(makeFreeDirectory(fs, at("dir"))).rejects.toMatchObject({ code: "EACCES" })
	})
})
