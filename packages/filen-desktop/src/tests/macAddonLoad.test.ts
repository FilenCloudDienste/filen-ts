import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { macAddonOutput } from "../../scripts/buildMacAddon.ts"
import type { MacAddon } from "../native/quarantine.ts"

// The built addon for this machine, loaded for real: run `node scripts/buildMacAddon.ts --dev` first.
const output = process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64") ? macAddonOutput(process.arch) : null
const built = output !== null && existsSync(output)

const QUARANTINE = /^[0-9a-f]{4};[0-9a-f]{8};[^;]*;[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\n?$/

let directory: string

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "filen-mac-addon-"))
})

afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

function quarantineOf(file: string): string {
	return execFileSync("xattr", ["-p", "com.apple.quarantine", file], { encoding: "utf8" })
}

describe.skipIf(!built)("filen-mac.node", () => {
	const addon = (): MacAddon => createRequire(import.meta.url)(output ?? "") as MacAddon

	it("quarantine marks a temp file and a directory", async () => {
		const file = path.join(directory, "a.txt")
		const dir = path.join(directory, "sub")

		await writeFile(file, "a")
		await mkdir(dir)
		addon().quarantine([file, dir])

		// flags;hex timestamp;agent;event id, written by LaunchServices. It fills the agent field from the signed app it
		// knows (empty for a bare node), and keeps the "Filen" agent name with the event.
		expect(quarantineOf(file)).toMatch(QUARANTINE)
		expect(quarantineOf(dir)).toMatch(QUARANTINE)
	})

	it("marks every other path when one fails, then throws naming the first failure", async () => {
		const file = path.join(directory, "a.txt")
		const missing = path.join(directory, "missing.txt")

		await writeFile(file, "a")

		expect(() => {
			addon().quarantine([missing, file])
		}).toThrow(missing)
		expect(quarantineOf(file)).toMatch(QUARANTINE)
	})

	it("rejects anything but an array of non-empty strings", () => {
		const invalid = (value: unknown) => () => {
			;(addon().quarantine as (paths: unknown) => void)(value)
		}

		expect(invalid("/a")).toThrow(expect.objectContaining({ code: "invalidArgument" }))
		expect(invalid([""])).toThrow(expect.objectContaining({ code: "invalidArgument" }))
		expect(invalid([1])).toThrow(expect.objectContaining({ code: "invalidArgument" }))
	})
})
