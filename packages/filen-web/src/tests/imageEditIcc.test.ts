import { describe, expect, it } from "vitest"
import { isWideGamutIcc } from "@/features/preview/imageEdit/lib/icc"

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
