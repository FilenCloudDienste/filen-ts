import { describe, expect, it } from "vitest"
import { isOfferedRole, offeredProtocols } from "@/features/mounts/lib/mountsRoles"

describe("offeredProtocols", () => {
	it("nfs not offered on win32", () => {
		expect(offeredProtocols("win32")).not.toContain("nfs")
		expect(offeredProtocols("darwin")).toContain("nfs")
		expect(offeredProtocols("linux")).toContain("nfs")
	})
})

describe("isOfferedRole", () => {
	it("accepts the drive and every offered protocol, nothing else", () => {
		expect(isOfferedRole("drive", "win32")).toBe(true)
		expect(isOfferedRole("webdav", "linux")).toBe(true)
		expect(isOfferedRole("nfs", "darwin")).toBe(true)
		expect(isOfferedRole("nfs", "win32")).toBe(false)
		expect(isOfferedRole("dlna", "linux")).toBe(false)
		expect(isOfferedRole("", "linux")).toBe(false)
	})
})
