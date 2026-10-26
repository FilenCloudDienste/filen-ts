import { closeSync, openSync, readSync } from "node:fs"

// The CPU a native binary is built for, read from its header: Mach-O (64-bit), PE or ELF. null for anything else,
// a universal Mach-O among them, so a check never passes a binary it cannot place.
export type NativeArch = "x64" | "arm64"

// Enough for a PE header behind a long DOS stub.
const HEAD_BYTES = 4096

const MACHO: Partial<Record<number, NativeArch>> = { 0x01000007: "x64", 0x0100000c: "arm64" }
const PE: Partial<Record<number, NativeArch>> = { 0x8664: "x64", 0xaa64: "arm64" }
const ELF: Partial<Record<number, NativeArch>> = { 0x3e: "x64", 0xb7: "arm64" }

export function nativeArch(head: Buffer): NativeArch | null {
	if (head.length >= 8 && head.readUInt32LE(0) === 0xfeedfacf) {
		return MACHO[head.readUInt32LE(4)] ?? null
	}

	if (head.length >= 0x40 && head.toString("latin1", 0, 2) === "MZ") {
		const pe = head.readUInt32LE(0x3c)

		return pe + 6 <= head.length && head.toString("latin1", pe, pe + 4) === "PE\0\0" ? (PE[head.readUInt16LE(pe + 4)] ?? null) : null
	}

	if (head.length >= 20 && head.toString("latin1", 0, 4) === "\x7fELF") {
		// EI_DATA 1: little-endian, which both architectures use.
		return head[5] === 1 ? (ELF[head.readUInt16LE(18)] ?? null) : null
	}

	return null
}

export function nativeArchOf(file: string): NativeArch | null {
	const head = Buffer.alloc(HEAD_BYTES)
	const fd = openSync(file, "r")

	try {
		return nativeArch(head.subarray(0, readSync(fd, head, 0, HEAD_BYTES, 0)))
	} finally {
		closeSync(fd)
	}
}
