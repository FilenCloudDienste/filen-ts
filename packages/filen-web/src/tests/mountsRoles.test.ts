import { describe, expect, it } from "vitest"
import { isOfferedRole, offeredProtocols, primaryRoles } from "@/features/mounts/lib/mountsRoles"

describe("offeredProtocols", () => {
	it("nfs not offered on win32", () => {
		expect(offeredProtocols("win32")).not.toContain("nfs")
		expect(offeredProtocols("darwin")).toContain("nfs")
		expect(offeredProtocols("linux")).toContain("nfs")
	})
})

describe("primaryRoles", () => {
	it("puts Filen in Finder before the network drive where offered", () => {
		expect(primaryRoles(true)).toEqual(["finder", "drive"])
		expect(primaryRoles(false)).toEqual(["drive"])
	})
})

describe("isOfferedRole", () => {
	it("accepts the drive and every offered protocol, nothing else", () => {
		expect(isOfferedRole("drive", { platform: "win32", finder: false })).toBe(true)
		expect(isOfferedRole("webdav", { platform: "linux", finder: false })).toBe(true)
		expect(isOfferedRole("nfs", { platform: "darwin", finder: false })).toBe(true)
		expect(isOfferedRole("nfs", { platform: "win32", finder: false })).toBe(false)
		expect(isOfferedRole("dlna", { platform: "linux", finder: false })).toBe(false)
		expect(isOfferedRole("", { platform: "linux", finder: false })).toBe(false)
	})

	it("accepts Filen in Finder only where the shell supports it", () => {
		expect(isOfferedRole("finder", { platform: "darwin", finder: true })).toBe(true)
		expect(isOfferedRole("finder", { platform: "darwin", finder: false })).toBe(false)
		expect(isOfferedRole("finder", { platform: "linux", finder: false })).toBe(false)
		expect(isOfferedRole("finder", { platform: undefined, finder: false })).toBe(false)
	})
})
