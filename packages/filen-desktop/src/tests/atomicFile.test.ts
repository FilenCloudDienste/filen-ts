import { existsSync } from "node:fs"
import { mkdtemp, readFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { atomicFile, type AtomicFileDeps, RENAME_RETRY_DELAYS_MS } from "../main/atomicFile.ts"

let directory: string

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "filen-atomic-file-"))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

function coded(code: string): Error {
	return Object.assign(new Error(code), { code })
}

// A rename that fails with `code` the first `failures` times, then renames for real.
function failingRename(code: string, failures: number, platform: NodeJS.Platform) {
	let calls = 0
	const delay = vi.fn((_ms: number) => Promise.resolve())
	const deps: AtomicFileDeps = {
		rename: (from, to) => (++calls <= failures ? Promise.reject(coded(code)) : rename(from, to)),
		platform,
		delay
	}

	return { deps, delay, calls: () => calls }
}

describe("atomicFile.write", () => {
	it("retries a rename Windows refused with EPERM and writes on the third try", async () => {
		const file = path.join(directory, "prefs.json")
		const { deps, delay, calls } = failingRename("EPERM", 2, "win32")

		await atomicFile(file, deps).write(Buffer.from("next"))

		expect(calls()).toBe(3)
		expect(delay.mock.calls.map(([ms]) => ms)).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2))
		expect(await readFile(file, "utf8")).toBe("next")
		expect(existsSync(`${file}.tmp`)).toBe(false)
	})

	it.each([
		["a code that is not retried", "ENOENT", "win32"],
		["another platform", "EPERM", "darwin"]
	] as const)("fails at once on %s and removes the temp file", async (_name, code, platform) => {
		const file = path.join(directory, "prefs.json")
		const { deps, delay, calls } = failingRename(code, 1, platform)

		await expect(atomicFile(file, deps).write(Buffer.from("next"))).rejects.toMatchObject({ code })
		expect(calls()).toBe(1)
		expect(delay).not.toHaveBeenCalled()
		expect(existsSync(`${file}.tmp`)).toBe(false)
		expect(existsSync(file)).toBe(false)
	})

	it("gives up after its budget, rethrows and removes the temp file", async () => {
		const file = path.join(directory, "prefs.json")
		const { deps, delay, calls } = failingRename("EBUSY", Infinity, "win32")

		await expect(atomicFile(file, deps).write(Buffer.from("next"))).rejects.toMatchObject({ code: "EBUSY" })
		expect(calls()).toBe(RENAME_RETRY_DELAYS_MS.length + 1)
		expect(delay.mock.calls.reduce((total, [ms]) => total + ms, 0)).toBeLessThanOrEqual(1100)
		expect(existsSync(`${file}.tmp`)).toBe(false)
	})

	it("writes with the real rename by default", async () => {
		const file = path.join(directory, "prefs.json")

		await atomicFile(file).write(Buffer.from("a"))

		expect(await atomicFile(file).read()).toEqual(Buffer.from("a"))
	})
})
