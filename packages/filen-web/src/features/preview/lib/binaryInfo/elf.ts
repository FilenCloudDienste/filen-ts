import { cString, u16, u32, u64 } from "@/features/preview/lib/binaryInfo/bytes"
import type { BinarySource, ElfInfo } from "@/features/preview/lib/binaryInfo/types"

// An ELF object ("\x7fELF"): its identification, type and machine, and the interpreter a dynamic executable asks for
// (System V ABI, ELF gABI).

const PT_INTERP = 3
const MAX_PROGRAM_HEADERS = 256
// A program header is 32 (ELF32) or 56 (ELF64) bytes; a larger entry size is no real file's.
const MAX_PROGRAM_HEADER_SIZE = 64
const MAX_INTERPRETER = 256

const MACHINES: ReadonlyMap<number, string> = new Map([
	[2, "SPARC"],
	[3, "x86"],
	[8, "MIPS"],
	[20, "PowerPC"],
	[21, "PowerPC 64"],
	[22, "S/390"],
	[40, "ARM"],
	[43, "SPARC V9"],
	[50, "Itanium"],
	[62, "x86-64"],
	[183, "ARM64"],
	[243, "RISC-V"],
	[247, "BPF"],
	[258, "LoongArch"]
])

const ABIS: ReadonlyMap<number, string> = new Map([
	[0, "System V"],
	[1, "HP-UX"],
	[2, "NetBSD"],
	[3, "Linux"],
	[6, "Solaris"],
	[9, "FreeBSD"],
	[12, "OpenBSD"],
	[97, "ARM"],
	[255, "Standalone"]
])

// e_type; a shared object with an interpreter is a position-independent executable.
function kindOf(type: number, interpreter: string | null): ElfInfo["kind"] {
	switch (type) {
		case 1:
			return "relocatable"
		case 2:
			return "executable"
		case 3:
			return interpreter === null ? "sharedObject" : "pie"
		case 4:
			return "core"
		default:
			return "other"
	}
}

export async function readElf(source: BinarySource, head: Uint8Array, signal?: AbortSignal): Promise<ElfInfo | null> {
	const elfClass = head[4]
	const data = head[5]

	if ((elfClass !== 1 && elfClass !== 2) || (data !== 1 && data !== 2)) {
		return null
	}

	const wide = elfClass === 2
	const little = data === 1
	const type = u16(head, 16, little)
	const machine = u16(head, 18, little)
	const programHeaders = wide ? u64(head, 32, little) : u32(head, 28, little)
	const entrySize = u16(head, wide ? 54 : 42, little)
	const count = Math.min(u16(head, wide ? 56 : 44, little), MAX_PROGRAM_HEADERS)
	let interpreter: string | null = null

	if (
		programHeaders !== null &&
		programHeaders > 0 &&
		entrySize >= (wide ? 56 : 32) &&
		entrySize <= MAX_PROGRAM_HEADER_SIZE &&
		programHeaders < source.size
	) {
		const table = await source.read(programHeaders, count * entrySize, signal)

		for (let index = 0; index < count; index++) {
			const at = index * entrySize

			if (u32(table, at, little) === PT_INTERP) {
				const offset = wide ? u64(table, at + 8, little) : u32(table, at + 4, little)
				const size = wide ? u64(table, at + 32, little) : u32(table, at + 16, little)

				if (offset !== null && size !== null) {
					interpreter = cString(await source.read(offset, Math.min(size, MAX_INTERPRETER), signal), 0, MAX_INTERPRETER)
				}

				break
			}
		}
	}

	return {
		format: "elf",
		bits: wide ? 64 : 32,
		endian: little ? "little" : "big",
		kind: kindOf(type, interpreter),
		machine: MACHINES.get(machine) ?? `#${String(machine)}`,
		abi: ABIS.get(head[7] ?? 0) ?? `#${String(head[7] ?? 0)}`,
		interpreter
	}
}
