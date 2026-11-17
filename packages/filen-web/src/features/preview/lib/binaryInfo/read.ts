import { startsWith, u32 } from "@/features/preview/lib/binaryInfo/bytes"
import { readElf } from "@/features/preview/lib/binaryInfo/elf"
import { readDmg, readIso } from "@/features/preview/lib/binaryInfo/images"
import { readMachO } from "@/features/preview/lib/binaryInfo/macho"
import { readPe } from "@/features/preview/lib/binaryInfo/pe"
import type { BinaryInfo, BinarySource } from "@/features/preview/lib/binaryInfo/types"

// The file's headers, read by what its first bytes are, never by its name: a renamed file is read as what it is. A
// handful of small reads at most (the head, the headers each format points at, its signature or property list).

const HEAD_BYTES = 4096
const ELF = [0x7f, 0x45, 0x4c, 0x46]
const MZ = [0x4d, 0x5a]
const MACH_O_MAGICS: ReadonlySet<number> = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf])

// Whether a file's first bytes are an executable this reads: ELF, Mach-O (thin or universal) or MZ with a PE header
// inside them (a head of at least 0x40 bytes). For the text path's binary notice, which holds the head already.
export function isExecutableHead(head: Uint8Array): boolean {
	if (startsWith(head, ELF)) return true

	if (MACH_O_MAGICS.has(u32(head, 0, false))) {
		// A Java class shares 0xCAFEBABE; its next word is a version, far above an architecture count.
		return u32(head, 0, false) !== 0xcafebabe || u32(head, 4, false) <= 32
	}

	if (!startsWith(head, MZ)) return false

	const pe = u32(head, 0x3c, true)

	return pe >= 0x40 && pe + 4 <= head.length && u32(head, pe, true) === 0x00004550
}

// The facts of an executable or a disk image; null for a file that is neither.
export async function readBinaryInfo(source: BinarySource, name: string, signal?: AbortSignal): Promise<BinaryInfo | null> {
	const head = await source.read(0, HEAD_BYTES, signal)

	if (startsWith(head, ELF)) {
		return await readElf(source, head, signal)
	}

	if (MACH_O_MAGICS.has(u32(head, 0, false))) {
		const machO = await readMachO(source, head, signal)

		if (machO !== null) return machO
	}

	if (startsWith(head, MZ)) {
		const pe = await readPe(source, head, name, signal)

		if (pe !== null) return pe
	}

	return (await readDmg(source, head, signal)) ?? (await readIso(source, signal))
}
