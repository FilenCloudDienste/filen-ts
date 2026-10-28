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
