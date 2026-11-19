import { describe, expect, it } from "vitest"
import { fourCC, uint16be, uint16le, uint24be, uint32be, uint32le } from "@filen/shared/bytes"

const HIGH = Uint8Array.from([0xff, 0xfe, 0xfd, 0xfc])

describe("byte readers", () => {
	it("read a value with the top bit set as unsigned", () => {
		expect(uint16le(HIGH, 0)).toBe(0xfeff)
		expect(uint16be(HIGH, 0)).toBe(0xfffe)
		expect(uint24be(HIGH, 0)).toBe(0xfffefd)
		expect(uint32le(HIGH, 0)).toBe(0xfcfdfeff)
		expect(uint32be(HIGH, 0)).toBe(0xfffefdfc)
	})

	it("read a missing byte past the end as zero", () => {
		const short = Uint8Array.from([0x80, 0x01])

		expect(uint16le(short, 1)).toBe(0x01)
		expect(uint16be(short, 1)).toBe(0x0100)
		expect(uint24be(short, 0)).toBe(0x800100)
		expect(uint32le(short, 0)).toBe(0x0180)
		expect(uint32be(short, 0)).toBe(0x80010000)
		expect(uint32be(short, 8)).toBe(0)
	})

	it("read a FourCC, with zeros past the end", () => {
		expect(fourCC(new TextEncoder().encode("RIFFxxxx"), 0)).toBe("RIFF")
		expect(fourCC(new TextEncoder().encode("MT"), 0)).toBe("MT\0\0")
	})
})
