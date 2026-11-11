import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createQuarantine, MAC_QUARANTINE_BATCH, ZONE_IDENTIFIER, ZONE_WRITES_IN_FLIGHT, zoneIdentifierPath } from "../native/quarantine.ts"
import { quietestStall } from "./eventLoop.ts"

// The addon's rejection: the first failure's message and how many paths of the call failed.
function quarantineFailed(message: string, failures: number): Error {
	return Object.assign(new Error(message), { code: "quarantineFailed", failures })
}

function setup(platform: NodeJS.Platform, options: { addon?: boolean; fail?: string } = {}) {
	const macAddon = { quarantine: vi.fn((_paths: string[]) => Promise.resolve()) }
	const writeFile = vi.fn((file: string, _data: string) =>
		file === options.fail ? Promise.reject(new Error(`EPERM: ${file}`)) : Promise.resolve()
	)
	const warn = vi.fn()
	const quarantine = createQuarantine({
		platform,
		macAddon: options.addon === false ? null : macAddon,
		fs: { writeFile },
		log: { warn }
	})

	return { quarantine, macAddon, writeFile, warn }
}

// "A few ms", with room for a loaded test machine.
const STALL_MS = 10

describe("createQuarantine", () => {
	it("win32 writes ZoneId=3 into each file's Zone.Identifier stream and skips directories", async () => {
		const { quarantine, writeFile, macAddon } = setup("win32")

		await quarantine.mark(["C:\\d\\a.txt", "C:\\d\\sub\\b.txt"], ["C:\\d\\sub"])

		expect(ZONE_IDENTIFIER).toBe("[ZoneTransfer]\r\nZoneId=3\r\n")
		expect(zoneIdentifierPath("C:\\d\\a.txt")).toBe("C:\\d\\a.txt:Zone.Identifier")
		expect(writeFile.mock.calls).toEqual([
			["C:\\d\\a.txt:Zone.Identifier", ZONE_IDENTIFIER],
			["C:\\d\\sub\\b.txt:Zone.Identifier", ZONE_IDENTIFIER]
		])
		expect(macAddon.quarantine).not.toHaveBeenCalled()
	})

	it("win32 marks every other file when one fails, then rejects naming it", async () => {
		const { quarantine, writeFile } = setup("win32", { fail: "C:\\a.txt:Zone.Identifier" })

		await expect(quarantine.mark(["C:\\a.txt", "C:\\b.txt"], [])).rejects.toThrow("C:\\a.txt")
		expect(writeFile).toHaveBeenCalledTimes(2)
	})

	it("darwin passes every path to the addon in one call", async () => {
		const { quarantine, macAddon, writeFile } = setup("darwin")

		await quarantine.mark(["/d/sub/x.txt"], ["/d/sub"])
		await quarantine.mark([], [])

		expect(macAddon.quarantine.mock.calls).toEqual([[["/d/sub/x.txt", "/d/sub"]]])
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("darwin rejects with what the addon rejected", async () => {
		const { quarantine, macAddon } = setup("darwin")

		macAddon.quarantine.mockRejectedValue(quarantineFailed("/d/x.txt: denied", 1))

		await expect(quarantine.mark(["/d/x.txt"], [])).rejects.toThrow(/^\/d\/x\.txt: denied$/)
	})

	it("darwin hands the addon one bounded batch at a time and names the first failure of all", async () => {
		const { quarantine, macAddon } = setup("darwin")
		const files = Array.from({ length: MAC_QUARANTINE_BATCH * 2 + 1 }, (_, index) => `/d/${String(index)}`)
		let inFlight = 0
		let mostInFlight = 0

		macAddon.quarantine.mockImplementation(async paths => {
			inFlight++
			mostInFlight = Math.max(mostInFlight, inFlight)
			await new Promise(resolve => setTimeout(resolve, 1))
			inFlight--

			if (paths.includes("/d/1")) {
				throw quarantineFailed("/d/1: denied", 2)
			}

			if (paths.includes(`/d/${String(MAC_QUARANTINE_BATCH * 2)}`)) {
				throw quarantineFailed("/d/last: denied", 1)
			}
		})

		await expect(quarantine.mark(files, ["/d"])).rejects.toThrow(/^\/d\/1: denied \(and 2 more\)$/)
		expect(macAddon.quarantine.mock.calls.map(([paths]) => paths.length)).toEqual([MAC_QUARANTINE_BATCH, MAC_QUARANTINE_BATCH, 2])
		expect(macAddon.quarantine.mock.calls.flatMap(([paths]) => paths)).toEqual([...files, "/d"])
		expect(mostInFlight).toBe(1)
	})

	it("win32 keeps a bounded number of writes in flight", async () => {
		const { quarantine, writeFile: write } = setup("win32")
		let inFlight = 0
		let mostInFlight = 0

		write.mockImplementation(async () => {
			inFlight++
			mostInFlight = Math.max(mostInFlight, inFlight)
			await new Promise(resolve => setTimeout(resolve, 1))
			inFlight--
		})

		await quarantine.mark(
			Array.from({ length: ZONE_WRITES_IN_FLIGHT * 4 }, (_, index) => `C:\\d\\${String(index)}`),
			[]
		)

		expect(write).toHaveBeenCalledTimes(ZONE_WRITES_IN_FLIGHT * 4)
		expect(mostInFlight).toBe(ZONE_WRITES_IN_FLIGHT)
	})

	it("win32 marks a 10k-file batch without blocking the event loop", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "filen-zone-"))

		try {
			// APFS and ext4 take the stream suffix as part of a file name, so real writes stand in for NTFS here.
			const quarantine = createQuarantine({ platform: "win32", macAddon: null, fs: { writeFile }, log: { warn: vi.fn() } })
			const files = Array.from({ length: 10_000 }, (_, index) => path.join(directory, String(index)))

			expect(await quietestStall(STALL_MS, () => quarantine.mark(files, []))).toBeLessThan(STALL_MS)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("linux marks nothing", async () => {
		const { quarantine, macAddon, writeFile } = setup("linux")

		await quarantine.mark(["/d/x.txt"], ["/d"])

		expect(macAddon.quarantine).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("a missing mac addon makes mark a logged no-op", async () => {
		const { quarantine, warn } = setup("darwin", { addon: false })

		await quarantine.mark(["/d/x.txt"], [])
		await quarantine.mark(["/d/y.txt"], [])

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("not quarantined"))
	})
})
