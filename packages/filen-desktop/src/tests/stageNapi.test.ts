import { readFileSync, realpathSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isCurrent, stampOf } from "../../scripts/stageNapi.ts"

let directory: string

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "filen-stage-napi-"))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

describe("stageNapi", () => {
	// A build packages every architecture's addon from the install, so the lockfile must name them all. One resolved
	// before a platform package reached the registry lacks it, and only that platform's packaging fails, at night.
	it("has every platform addon of @filen/sdk-rs in the lockfile", () => {
		const sdk = realpathSync(path.join(import.meta.dirname, "../../node_modules/@filen/sdk-rs"))
		const manifest = JSON.parse(readFileSync(path.join(sdk, "package.json"), "utf8")) as {
			readonly optionalDependencies?: Readonly<Record<string, string>>
		}
		const lock = readFileSync(path.join(import.meta.dirname, "../../../../pnpm-lock.yaml"), "utf8")
		const addons = Object.entries(manifest.optionalDependencies ?? {})

		expect(addons.length).toBeGreaterThan(0)
		expect(addons.filter(([name, version]) => !lock.includes(`\n  '${name}@${version}':\n`)).map(([name]) => name)).toEqual([])
	})

	it("keeps a staged addon only while it comes from the same unchanged source", async () => {
		const source = path.join(directory, "sdk-rs.node")

		await writeFile(source, "addon")

		const stamp = stampOf(source)

		expect(isCurrent(JSON.parse(JSON.stringify(stamp)), stampOf(source))).toBe(true)
		expect(isCurrent({ ...stamp, source: path.join(directory, "other.node") }, stamp)).toBe(false)
		expect(isCurrent({ ...stamp, mtimeMs: stamp.mtimeMs - 1 }, stamp)).toBe(false)

		await writeFile(source, "a newer addon")
		expect(isCurrent(stamp, stampOf(source))).toBe(false)

		expect(isCurrent(null, stamp)).toBe(false)
		expect(isCurrent({ source }, stamp)).toBe(false)
	})
})
