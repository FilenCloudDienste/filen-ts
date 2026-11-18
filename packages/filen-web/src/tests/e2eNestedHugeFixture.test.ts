import { describe, expect, it } from "vitest"
import { createInflateRaw, crc32 } from "node:zlib"
import { NESTED_INFLATE_CONFIRM_BYTES, nestedOpening } from "@/features/archive/lib/entryAccess.logic"

const { nestedHugeZip, NESTED_HUGE_ZEROS_BYTES } = await import("../../e2e/helpers/archiveFixtures")

// The nested-archive e2e's inflate-confirm subject: uploaded small, built without holding its inner zip, yet declaring an
// inner zip above the 256 MiB confirm, and inflating to exactly what it declares.
describe("the huge nested zip fixture", () => {
	it("is a few hundred KiB that declare more than 256 MiB, and inflates to them, its CRC matching", async () => {
		const zip = nestedHugeZip()
		const crc = zip.readUInt32LE(14)
		const compressed = zip.readUInt32LE(18)
		const declared = zip.readUInt32LE(22)
		const nameLength = zip.readUInt16LE(26)

		expect(zip.length).toBeLessThan(512 * 1024)
		expect(zip.readUInt16LE(8)).toBe(8)
		expect(declared).toBeGreaterThan(NESTED_HUGE_ZEROS_BYTES)
		expect(nestedOpening("seekable", declared)).toBe("confirm")
		expect(declared).toBeGreaterThan(NESTED_INFLATE_CONFIRM_BYTES)

		const data = zip.subarray(30 + nameLength, 30 + nameLength + compressed)
		const inflate = createInflateRaw()
		let length = 0
		let running = 0
		const done = new Promise<void>((resolve, reject) => {
			inflate.on("data", (chunk: Buffer) => {
				length += chunk.length
				running = crc32(chunk, running)
			})
			inflate.on("end", resolve)
			inflate.on("error", reject)
		})

		inflate.end(data)
		await done
		expect(length).toBe(declared)
		expect(running).toBe(crc)
	})
})
