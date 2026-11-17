import { u32 } from "@/features/preview/lib/binaryInfo/bytes"
import type { BinarySignature, BinarySource, MachOInfo, MachOSlice } from "@/features/preview/lib/binaryInfo/types"

// A Mach-O file (Apple's <mach-o/loader.h>, <mach-o/fat.h>), thin or universal: its slices' CPUs, file type, the
// platform it was built for and its code signature's CMS blob (<kern/cs_blobs.h>).

const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const MH_CIGAM = 0xcefaedfe
const MH_CIGAM_64 = 0xcffaedfe
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
// A Java class file shares the fat magic; its next word (a version) is far above any architecture count.
const MAX_FAT_ARCHES = 32
// Load commands read per slice: real ones take a few KiB.
const MAX_COMMANDS_BYTES = 256 * 1024
const MAX_COMMANDS = 1024
// The code signature's SuperBlob, as the PE's WIN_CERTIFICATE: past this it is not read.
const MAX_SIGNATURE = 1024 * 1024
const MAX_BLOBS = 64

const LC_CODE_SIGNATURE = 0x1d
const LC_VERSION_MIN_MACOSX = 0x24
const LC_VERSION_MIN_IPHONEOS = 0x25
const LC_VERSION_MIN_TVOS = 0x2f
const LC_VERSION_MIN_WATCHOS = 0x30
const LC_BUILD_VERSION = 0x32

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0
const CSMAGIC_BLOBWRAPPER = 0xfade0b01
const CSSLOT_SIGNATURESLOT = 0x10000

const CPUS: ReadonlyMap<number, string> = new Map([
	[7, "x86"],
	[0x01000007, "x86-64"],
	[12, "ARM"],
	[0x0100000c, "ARM64"],
	[0x0200000c, "ARM64_32"],
	[18, "PowerPC"],
	[0x01000012, "PowerPC 64"]
])

const PLATFORMS: ReadonlyMap<number, string> = new Map([
	[1, "macOS"],
	[2, "iOS"],
	[3, "tvOS"],
	[4, "watchOS"],
	[6, "Mac Catalyst"],
	[7, "iOS Simulator"],
	[8, "tvOS Simulator"],
	[9, "watchOS Simulator"],
	[11, "visionOS"],
	[12, "visionOS Simulator"]
])

const VERSION_MIN_PLATFORMS: ReadonlyMap<number, string> = new Map([
	[LC_VERSION_MIN_MACOSX, "macOS"],
	[LC_VERSION_MIN_IPHONEOS, "iOS"],
	[LC_VERSION_MIN_TVOS, "tvOS"],
	[LC_VERSION_MIN_WATCHOS, "watchOS"]
])

function kindOf(fileType: number): MachOInfo["kind"] {
	switch (fileType) {
		case 1:
			return "object"
		case 2:
			return "executable"
		case 6:
		case 9:
			return "library"
		case 8:
			return "bundle"
		case 11:
			return "kernelExtension"
		default:
			return "other"
	}
}

// xxxx.yy.zz in nibbles.
function version(packed: number): string {
	const patch = packed & 0xff
	const minor = (packed >>> 8) & 0xff
	const major = packed >>> 16

	return patch === 0 ? `${String(major)}.${String(minor)}` : `${String(major)}.${String(minor)}.${String(patch)}`
}

function isThin(magic: number): boolean {
	return magic === MH_MAGIC || magic === MH_MAGIC_64 || magic === MH_CIGAM || magic === MH_CIGAM_64
}

async function codeSignature(source: BinarySource, offset: number, size: number, signal?: AbortSignal): Promise<BinarySignature> {
	if (size > MAX_SIGNATURE || offset + size > source.size) {
		return { state: "unreadable" }
	}

	// The code signature's integers are big-endian whatever the file's order.
	const blob = await source.read(offset, size, signal)

	if (u32(blob, 0, false) !== CSMAGIC_EMBEDDED_SIGNATURE) {
		return { state: "unreadable" }
	}

	const count = Math.min(u32(blob, 8, false), MAX_BLOBS)

	for (let index = 0; index < count; index++) {
		if (u32(blob, 12 + index * 8, false) !== CSSLOT_SIGNATURESLOT) continue

		const at = u32(blob, 16 + index * 8, false)
		const length = u32(blob, at + 4, false)

		if (u32(blob, at, false) !== CSMAGIC_BLOBWRAPPER || length < 8 || at + length > blob.length) {
			return { state: "unreadable" }
		}

		// An ad hoc signature's wrapper is empty.
		return { state: "present", der: length === 8 ? null : blob.slice(at + 8, at + length) }
	}

	return { state: "present", der: null }
}

interface Slice {
	readonly slice: MachOSlice
	readonly kind: MachOInfo["kind"]
	readonly platform: string | null
	readonly minimumOs: string | null
	readonly signature: BinarySignature
}

// `withSignature`: the slice shown, whose first LC_CODE_SIGNATURE (and only that) is read.
async function readSlice(source: BinarySource, start: number, withSignature: boolean, signal?: AbortSignal): Promise<Slice | null> {
	const header = await source.read(start, 32, signal)
	const magic = u32(header, 0, false)

	if (!isThin(magic)) {
		return null
	}

	const little = magic === MH_CIGAM || magic === MH_CIGAM_64
	const wide = magic === MH_MAGIC_64 || magic === MH_CIGAM_64
	const cpu = u32(header, 4, little)
	const fileType = u32(header, 12, little)
	const commands = Math.min(u32(header, 16, little), MAX_COMMANDS)
	const commandsSize = Math.min(u32(header, 20, little), MAX_COMMANDS_BYTES)
	const table = await source.read(start + (wide ? 32 : 28), commandsSize, signal)
	let platform: string | null = null
	let minimumOs: string | null = null
	let signature: BinarySignature = { state: "none" }
	let signed = false
	let at = 0

	for (let index = 0; index < commands && at + 8 <= table.length; index++) {
		const command = u32(table, at, little)
		const size = u32(table, at + 4, little)

		if (command === LC_BUILD_VERSION) {
			platform = PLATFORMS.get(u32(table, at + 8, little)) ?? platform
			minimumOs = version(u32(table, at + 12, little))
		} else if (VERSION_MIN_PLATFORMS.has(command) && platform === null) {
			platform = VERSION_MIN_PLATFORMS.get(command) ?? null
			minimumOs = version(u32(table, at + 8, little))
		} else if (command === LC_CODE_SIGNATURE && !signed) {
			signed = true
			signature = withSignature
				? await codeSignature(source, start + u32(table, at + 8, little), u32(table, at + 12, little), signal)
				: { state: "present", der: null }
		}

		if (size < 8) break

		at += size
	}

	return {
		slice: { cpu: CPUS.get(cpu) ?? `#${String(cpu)}`, bits: wide ? 64 : 32 },
		kind: kindOf(fileType),
		platform,
		minimumOs,
		signature
	}
}

// The Mach-O's facts, or null when the head is none (a Java class behind the fat magic).
export async function readMachO(source: BinarySource, head: Uint8Array, signal?: AbortSignal): Promise<MachOInfo | null> {
	const magic = u32(head, 0, false)

	if (isThin(magic)) {
		const slice = await readSlice(source, 0, true, signal)

		return slice === null
			? null
			: {
					format: "macho",
					slices: [slice.slice],
					kind: slice.kind,
					platform: slice.platform,
					minimumOs: slice.minimumOs,
					signature: slice.signature
				}
	}

	if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
		return null
	}

	const count = u32(head, 4, false)

	if (count === 0 || count > MAX_FAT_ARCHES) {
		return null
	}

	const wideFat = magic === FAT_MAGIC_64
	const entries = await source.read(8, count * (wideFat ? 32 : 20), signal)
	const slices: Slice[] = []
	const offsets = new Set<number>()

	for (let index = 0; index < count; index++) {
		const at = index * (wideFat ? 32 : 20)
		const offset = wideFat ? u32(entries, at + 8, false) * 0x100000000 + u32(entries, at + 12, false) : u32(entries, at + 8, false)

		// The same slice twice is read once.
		if (offset >= source.size || offsets.has(offset)) continue

		offsets.add(offset)

		const slice = await readSlice(source, offset, slices.length === 0, signal)

		if (slice !== null) slices.push(slice)
	}

	const first = slices[0]

	return first === undefined
		? null
		: {
				format: "macho",
				slices: slices.map(slice => slice.slice),
				kind: first.kind,
				platform: first.platform,
				minimumOs: first.minimumOs,
				signature: first.signature
			}
}
