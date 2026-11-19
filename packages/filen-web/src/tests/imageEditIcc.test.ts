import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { isWideGamutIcc, isWideGamutPngIccp } from "@/features/preview/imageEdit/lib/icc"

// A minimal profile: 128-byte header with "acsp" at 36, a one-entry tag table, and an rXYZ XYZType.
function profile(redX: number): Uint8Array {
	const bytes = new Uint8Array(132 + 12 + 20)
	const view = new DataView(bytes.buffer)

	bytes.set([0x61, 0x63, 0x73, 0x70], 36)
	view.setUint32(128, 1)
	bytes.set([0x72, 0x58, 0x59, 0x5a], 132)
	view.setUint32(136, 144)
	view.setUint32(140, 20)
	bytes.set([0x58, 0x59, 0x5a, 0x20], 144)
	view.setInt32(152, Math.round(redX * 65536))

	return bytes
}

describe("isWideGamutIcc", () => {
	it("tells Display P3 and Adobe RGB from sRGB by the red primary", () => {
		expect(isWideGamutIcc(profile(0.4361))).toBe(false)
		expect(isWideGamutIcc(profile(0.5151))).toBe(true)
		expect(isWideGamutIcc(profile(0.6097))).toBe(true)
	})

	it("answers false for anything that is not a raw profile", () => {
		expect(isWideGamutIcc(null)).toBe(false)
		expect(isWideGamutIcc(new Uint8Array(200))).toBe(false)
		expect(isWideGamutIcc(profile(0.5151).subarray(0, 140))).toBe(false)
	})
})

// A PNG iCCP chunk's data: the profile name, its terminator, compression method 0, then the zlib stream.
function iccp(stream: Uint8Array, name = "Display P3"): Uint8Array {
	const out = new Uint8Array(name.length + 2 + stream.length)

	out.set(Array.from(name, c => c.charCodeAt(0)))
	out.set(stream, name.length + 2)

	return out
}

describe("isWideGamutPngIccp", () => {
	it("inflates the iCCP stream and reads the profile inside", async () => {
		expect(await isWideGamutPngIccp(iccp(deflateSync(profile(0.5151))))).toBe(true)
		expect(await isWideGamutPngIccp(iccp(deflateSync(profile(0.4361)), "sRGB"))).toBe(false)
	})

	it("answers false for a corrupt stream, a stream past the cap, and a malformed header", async () => {
		const p3 = profile(0.5151)

		expect(await isWideGamutPngIccp(iccp(Uint8Array.from([0x78, 0x9c, 1, 2, 3, 4, 5])))).toBe(false)
		expect(await isWideGamutPngIccp(iccp(deflateSync(p3)), p3.length - 1)).toBe(false)
		expect(await isWideGamutPngIccp(iccp(deflateSync(p3), ""))).toBe(false)

		const wrongMethod = iccp(deflateSync(p3))

		wrongMethod[11] = 1
		expect(await isWideGamutPngIccp(wrongMethod)).toBe(false)
	})
})
