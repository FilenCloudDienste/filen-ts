import { describe, expect, it } from "vitest"
import { nativeArch } from "../../scripts/nativeArch.ts"

function machO(cpuType: number, magic = 0xfeedfacf): Buffer {
	const head = Buffer.alloc(64)

	head.writeUInt32LE(magic, 0)
	head.writeUInt32LE(cpuType, 4)

	return head
}

// A DOS header whose e_lfanew points right behind it.
function pe(machine: number): Buffer {
	const head = Buffer.alloc(0x48)

	head.write("MZ", 0, "latin1")
	head.writeUInt32LE(0x40, 0x3c)
	head.write("PE\0\0", 0x40, "latin1")
	head.writeUInt16LE(machine, 0x44)

	return head
}

function elf(machine: number, littleEndian = true): Buffer {
	const head = Buffer.alloc(64)

	head.write("\x7fELF", 0, "latin1")
	head[4] = 2
	head[5] = littleEndian ? 1 : 2
	head.writeUInt16LE(machine, 18)

	return head
}

describe("nativeArch", () => {
	it("reads Mach-O, PE and ELF headers", () => {
		expect(nativeArch(machO(0x0100000c))).toBe("arm64")
		expect(nativeArch(machO(0x01000007))).toBe("x64")
		expect(nativeArch(pe(0xaa64))).toBe("arm64")
		expect(nativeArch(pe(0x8664))).toBe("x64")
		expect(nativeArch(elf(0xb7))).toBe("arm64")
		expect(nativeArch(elf(0x3e))).toBe("x64")
	})

	it("places nothing it cannot read", () => {
		// A universal binary holds several architectures.
		expect(nativeArch(machO(0x0100000c, 0xbebafeca))).toBeNull()
		expect(nativeArch(machO(0x00000007))).toBeNull()
		expect(nativeArch(pe(0x014c))).toBeNull()
		expect(nativeArch(pe(0x8664).subarray(0, 0x44))).toBeNull()
		expect(nativeArch(elf(0x3e, false))).toBeNull()
		expect(nativeArch(Buffer.alloc(64))).toBeNull()
		expect(nativeArch(Buffer.alloc(0))).toBeNull()
	})
})
