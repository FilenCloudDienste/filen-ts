import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createDragTemp, type DragTempDeps } from "../main/dragOut/temp.ts"

const posix = process.platform !== "win32"
const HOUR = 3_600_000

let base: string
let root: string

beforeEach(async () => {
	base = await mkdtemp(path.join(tmpdir(), "filen-drag-temp-"))
	root = path.join(base, "drag-out")
})

afterEach(async () => {
	await chmod(base, 0o700)
	await rm(base, { recursive: true, force: true })
})

function deps(overrides: Partial<DragTempDeps> = {}): DragTempDeps & { warnings: string[] } {
	const warnings: string[] = []

	return {
		root,
		uid: process.getuid?.() ?? null,
		now: () => Date.now(),
		setTimer: (run, ms) => {
			const timer = setTimeout(run, ms)

			return () => {
				clearTimeout(timer)
			}
		},
		log: {
			warn: message => {
				warnings.push(message)
			}
		},
		warnings,
		...overrides
	}
}

async function aged(dir: string, ms: number): Promise<void> {
	const at = new Date(Date.now() - ms)

	await utimes(dir, at, at)
}

describe("drag temp", () => {
	it.skipIf(!posix)("session directories are 0700, under a 0700 root", async () => {
		const temp = createDragTemp(deps())
		const dir = await temp.sessionDir("one")

		expect(path.dirname(dir)).toBe(root)
		expect(path.basename(dir)).toMatch(/^s-/)
		expect((await stat(root)).mode & 0o777).toBe(0o700)
		expect((await stat(dir)).mode & 0o777).toBe(0o700)
	})

	it("a second sessionDir for one id answers the same directory", async () => {
		const temp = createDragTemp(deps())

		expect(await temp.sessionDir("one")).toBe(await temp.sessionDir("one"))
	})

	it.skipIf(!posix)("a root that is a symlink, another uid's or group-writable is refused", async () => {
		const elsewhere = path.join(base, "elsewhere")

		await mkdir(elsewhere, { mode: 0o700 })
		await symlink(elsewhere, root)
		await expect(createDragTemp(deps()).sessionDir("one")).rejects.toThrow()
		expect(await readdir(elsewhere)).toEqual([])

		await rm(root)
		await mkdir(root, { mode: 0o700 })
		await expect(createDragTemp(deps({ uid: (process.getuid?.() ?? 0) + 1 })).sessionDir("one")).rejects.toThrow()

		await chmod(root, 0o770)
		await expect(createDragTemp(deps()).sessionDir("one")).rejects.toThrow()
		expect(await readdir(root)).toEqual([])
	})

	it("sweep removes only s- entries older than an hour and never follows a symlink", async () => {
		await mkdir(root, { mode: 0o700 })

		const old = path.join(root, "s-old123")
		const fresh = path.join(root, "s-new123")
		const foreign = path.join(root, "keep-me")
		const target = path.join(base, "target")
		const link = path.join(root, "s-link12")

		for (const dir of [old, fresh, foreign, target]) {
			await mkdir(dir, { mode: 0o700 })
			await writeFile(path.join(dir, "file"), "x")
		}

		await symlink(target, link)
		await aged(old, 2 * HOUR)
		await aged(foreign, 2 * HOUR)

		const temp = createDragTemp(deps())

		await temp.sweep(HOUR)

		expect((await readdir(root)).sort()).toEqual(["keep-me", "s-link12", "s-new123"])
		expect(await readdir(target)).toEqual(["file"])
	})

	it("sweep keeps this run's own sessions", async () => {
		const temp = createDragTemp(deps({ now: () => Date.now() + 2 * HOUR }))
		const dir = await temp.sessionDir("one")

		await temp.sweep(HOUR)

		expect(await readdir(root)).toEqual([path.basename(dir)])
	})

	it("removeAllSync removes only this run's sessions and survives a failing entry", async () => {
		const temp = createDragTemp(deps())
		const one = await temp.sessionDir("one")
		const two = await temp.sessionDir("two")
		const other = path.join(root, "s-other1")

		await mkdir(other, { mode: 0o700 })
		await writeFile(path.join(one, "file"), "x")
		// Replaced by a symlink: refused and kept, the next entry still removed.
		await rm(two, { recursive: true })
		await symlink(other, two)

		temp.removeAllSync()

		expect((await readdir(root)).sort()).toEqual([path.basename(two), "s-other1"].sort())
	})

	it("deleteNow removes the session directory and deleteLater waits", async () => {
		const timers: { run: () => void; ms: number }[] = []
		const temp = createDragTemp(
			deps({
				setTimer: (run, ms) => {
					timers.push({ run, ms })

					return () => undefined
				}
			})
		)
		const one = await temp.sessionDir("one")
		const two = await temp.sessionDir("two")

		await temp.deleteNow("one")
		temp.deleteLater("two", 30 * 60_000)

		expect(await readdir(root)).toEqual([path.basename(two)])
		expect(timers.map(timer => timer.ms)).toEqual([30 * 60_000])

		timers[0]?.run()

		await expect.poll(() => readdir(root)).toEqual([])
		expect(path.basename(one)).toMatch(/^s-/)
	})
})
