import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { pinned, rcloneFromZip, readVersions, sha256Hex } from "../../scripts/stageRclone.ts"

function machO(cpuType: number): Buffer {
	const head = Buffer.alloc(64)

	head.writeUInt32LE(0xfeedfacf, 0)
	head.writeUInt32LE(cpuType, 4)

	return head
}

const ARM64 = 0x0100000c
const X64 = 0x01000007
const ENTRY = "rclone-v1.74.3-osx-arm64/rclone"

describe("stageRclone", () => {
	it("refuses a zip with the wrong sha256", () => {
		const zip = zipSync({ [ENTRY]: machO(ARM64) })

		expect(pinned(zip, sha256Hex(zip), "zip")).toBe(zip)
		expect(() => pinned(zip, "0".repeat(64), "zip")).toThrow(/does not match the pinned/)
	})

	it("refuses a wrong-arch binary", () => {
		const zip = zipSync({ [ENTRY]: machO(X64), "rclone-v1.74.3-osx-arm64/README.txt": new Uint8Array([1]) })

		expect(() => rcloneFromZip(zip, ENTRY, "arm64")).toThrow(/built for x64, not arm64/)
		expect(Buffer.from(rcloneFromZip(zip, ENTRY, "x64")).equals(machO(X64))).toBe(true)
	})

	it("refuses a zip without the binary", () => {
		expect(() => rcloneFromZip(zipSync({ "other/rclone": machO(ARM64) }), ENTRY, "arm64")).toThrow(/has no/)
	})

	it("pins every os and arch", () => {
		const versions = readVersions()

		expect(Object.keys(versions.rcloneSha256).sort()).toEqual([
			"linux-arm64",
			"linux-x64",
			"mac-arm64",
			"mac-x64",
			"win-arm64",
			"win-x64"
		])
	})
})
