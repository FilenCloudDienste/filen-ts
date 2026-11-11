import { describe, expect, it, vi } from "vitest"
import { createQuarantine, ZONE_IDENTIFIER, zoneIdentifierPath } from "../native/quarantine.ts"

function setup(platform: NodeJS.Platform, options: { addon?: boolean; fail?: string } = {}) {
	const macAddon = { quarantine: vi.fn((_paths: string[]) => undefined) }
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

	it("darwin rejects with what the addon threw", async () => {
		const { quarantine, macAddon } = setup("darwin")

		macAddon.quarantine.mockImplementation(() => {
			throw new Error("/d/x.txt: denied")
		})

		await expect(quarantine.mark(["/d/x.txt"], [])).rejects.toThrow("/d/x.txt: denied")
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
