import { hex, u16, u32, utf16 } from "@/features/preview/lib/binaryInfo/bytes"
import type { BinarySignature, BinarySource, PeInfo, PeVersion } from "@/features/preview/lib/binaryInfo/types"

// A Windows Portable Executable ("MZ", then "PE\0\0" at e_lfanew): its COFF and optional headers, the version resource
// and the Authenticode signature's container (PE/COFF specification). Little-endian throughout.

const MAX_HEADER_OFFSET = 16 * 1024 * 1024
const MAX_SECTIONS = 96
// The security directory holds the signature: past this it is not read.
const MAX_CERTIFICATE = 1024 * 1024
const MAX_VERSION_RESOURCE = 64 * 1024
const MAX_RESOURCE_ENTRIES = 256
const RT_VERSION = 16
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 2

const MACHINES: ReadonlyMap<number, string> = new Map([
	[0x14c, "x86"],
	[0x8664, "x86-64"],
	[0xaa64, "ARM64"],
	[0xa641, "ARM64EC"],
	[0x1c0, "ARM"],
	[0x1c4, "ARMv7"],
	[0x200, "Itanium"],
	[0x5064, "RISC-V 64"],
	[0x6264, "LoongArch 64"],
	[0xebc, "EFI byte code"]
])

const SUBSYSTEMS: ReadonlyMap<number, string> = new Map([
	[1, "Native"],
	[2, "Windows GUI"],
	[3, "Windows console"],
	[5, "OS/2 console"],
	[7, "POSIX console"],
	[9, "Windows CE"],
	[10, "EFI application"],
	[11, "EFI boot service driver"],
	[12, "EFI runtime driver"],
	[13, "EFI ROM"],
	[14, "Xbox"],
	[16, "Windows boot application"]
])

interface Section {
	readonly virtualAddress: number
	readonly virtualSize: number
	readonly rawOffset: number
	readonly rawSize: number
}

function fileOffset(sections: readonly Section[], rva: number): number | null {
	for (const section of sections) {
		const size = Math.max(section.virtualSize, section.rawSize)

		if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
			const within = rva - section.virtualAddress

			return within < section.rawSize ? section.rawOffset + within : null
		}
	}

	return null
}

// 2000-01-01 to a year from now: anything else is a hash or zero, not a date.
function plausibleTimestamp(seconds: number): number | null {
	return seconds >= 946_684_800 && seconds <= Date.now() / 1000 + 365 * 86_400 ? seconds : null
}

const VERSION_KEYS: Readonly<Record<string, keyof PeVersion>> = {
	ProductName: "productName",
	CompanyName: "companyName",
	FileDescription: "fileDescription",
	FileVersion: "fileVersion",
	ProductVersion: "productVersion",
	LegalCopyright: "copyright",
	OriginalFilename: "originalFilename"
}

const align4 = (at: number): number => (at + 3) & ~3

// VS_VERSIONINFO (its StringFileInfo's first table): each node is wLength, wValueLength, wType, a NUL-terminated
// UTF-16 key, padding to 4, its value, then its children.
function versionStrings(bytes: Uint8Array): PeVersion | null {
	const found: Record<keyof PeVersion, string | null> = {
		productName: null,
		companyName: null,
		fileDescription: null,
		fileVersion: null,
		productVersion: null,
		copyright: null,
		originalFilename: null
	}
	let visited = 0

	const walk = (start: number, end: number, depth: number): void => {
		let at = start

		while (at + 6 < end && depth < 4 && visited++ < 512) {
			const length = u16(bytes, at, true)
			const valueLength = u16(bytes, at + 2, true)
			const type = u16(bytes, at + 4, true)

			if (length < 6 || at + length > end) return

			let keyEnd = at + 6

			while (keyEnd + 1 < at + length && (bytes[keyEnd] !== 0 || bytes[keyEnd + 1] !== 0)) keyEnd += 2

			const key = utf16(bytes, at + 6, keyEnd, true)
			const valueStart = align4(keyEnd + 2)
			const field = VERSION_KEYS[key]

			if (depth === 3 && field !== undefined && type === 1) {
				const text = utf16(bytes, valueStart, Math.min(valueStart + valueLength * 2, at + length), true).trim()

				found[field] = text === "" ? null : text.slice(0, 256)
			}

			// The root's value is VS_FIXEDFILEINFO; StringFileInfo and its tables hold children only.
			const childrenStart = depth === 0 ? align4(valueStart + valueLength) : valueStart

			if (depth === 0 || (depth === 1 && key === "StringFileInfo") || depth === 2) {
				walk(childrenStart, at + length, depth + 1)
			}

			at = align4(at + length)
		}
	}

	walk(0, bytes.length, 0)

	return Object.values(found).some(value => value !== null) ? found : null
}

async function versionResource(
	source: BinarySource,
	sections: readonly Section[],
	rva: number,
	size: number,
	signal?: AbortSignal
): Promise<PeVersion | null> {
	const base = fileOffset(sections, rva)

	if (base === null || size === 0) {
		return null
	}

	// A directory: 16 bytes, then named entries and id entries of 8 bytes each.
	const entry = async (directory: number, wanted: number | null): Promise<number | null> => {
		const header = await source.read(base + directory, 16, signal)
		const count = Math.min(u16(header, 12, true) + u16(header, 14, true), MAX_RESOURCE_ENTRIES)
		const entries = await source.read(base + directory + 16, count * 8, signal)

		for (let index = 0; index < count; index++) {
			const id = u32(entries, index * 8, true)

			if (wanted === null || id === wanted) {
				return u32(entries, index * 8 + 4, true)
			}
		}

		return null
	}

	const SUBDIRECTORY = 0x80000000
	const type = await entry(0, RT_VERSION)

	if (type === null || type < SUBDIRECTORY) return null

	const name = await entry(type - SUBDIRECTORY, null)

	if (name === null || name < SUBDIRECTORY) return null

	const language = await entry(name - SUBDIRECTORY, null)

	if (language === null || language >= SUBDIRECTORY) return null

	const data = await source.read(base + language, 16, signal)
	const dataOffset = fileOffset(sections, u32(data, 0, true))
	const dataSize = Math.min(u32(data, 4, true), MAX_VERSION_RESOURCE)

	return dataOffset === null ? null : versionStrings(await source.read(dataOffset, dataSize, signal))
}

async function signature(source: BinarySource, offset: number, size: number, signal?: AbortSignal): Promise<BinarySignature> {
	if (offset === 0 || size === 0) {
		return { state: "none" }
	}

	if (size > MAX_CERTIFICATE || offset + size > source.size) {
		return { state: "unreadable" }
	}

	const certificate = await source.read(offset, size, signal)
	const length = u32(certificate, 0, true)

	if (length < 8 || length > size || u16(certificate, 6, true) !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) {
		return { state: "unreadable" }
	}

	return { state: "present", der: certificate.slice(8, length) }
}

// The PE's facts, or null when the head is no PE (an MS-DOS program, a truncated file).
export async function readPe(source: BinarySource, head: Uint8Array, name: string, signal?: AbortSignal): Promise<PeInfo | null> {
	const peOffset = u32(head, 0x3c, true)

	if (peOffset < 0x40 || peOffset > Math.min(MAX_HEADER_OFFSET, source.size - 24)) {
		return null
	}

	const headers = await source.read(peOffset, 24 + 240 + MAX_SECTIONS * 40, signal)

	if (u32(headers, 0, true) !== 0x00004550) {
		return null
	}

	const machine = u16(headers, 4, true)
	const sectionCount = Math.min(u16(headers, 6, true), MAX_SECTIONS)
	const timestamp = u32(headers, 8, true)
	const optionalSize = u16(headers, 20, true)
	const characteristics = u16(headers, 22, true)
	const optional = 24
	const magic = u16(headers, optional, true)

	if (magic !== 0x10b && magic !== 0x20b) {
		return null
	}

	const plus = magic === 0x20b
	const subsystem = u16(headers, optional + 68, true)
	const directoryCount = u32(headers, optional + (plus ? 108 : 92), true)
	const directories = optional + (plus ? 112 : 96)
	const directory = (index: number): { rva: number; size: number } =>
		index < directoryCount
			? { rva: u32(headers, directories + index * 8, true), size: u32(headers, directories + index * 8 + 4, true) }
			: { rva: 0, size: 0 }
	const sections: Section[] = []

	for (let index = 0; index < sectionCount; index++) {
		const at = optional + optionalSize + index * 40

		sections.push({
			virtualSize: u32(headers, at + 8, true),
			virtualAddress: u32(headers, at + 12, true),
			rawSize: u32(headers, at + 16, true),
			rawOffset: u32(headers, at + 20, true)
		})
	}

	const resources = directory(2)
	const security = directory(4)
	const clr = directory(14)
	const efi = subsystem >= 10 && subsystem <= 13
	const driver = subsystem === 1 && /\.sys$/i.test(name)
	let version: PeVersion | null = null

	try {
		version = await versionResource(source, sections, resources.rva, resources.size, signal)
	} catch (e) {
		if (signal?.aborted === true) throw e
	}

	return {
		format: "pe",
		bits: plus ? 64 : 32,
		machine: MACHINES.get(machine) ?? hex(machine),
		kind: efi ? "efi" : driver ? "driver" : (characteristics & 0x2000) !== 0 ? "library" : "executable",
		subsystem: SUBSYSTEMS.get(subsystem) ?? null,
		built: plausibleTimestamp(timestamp),
		version,
		// The security directory's address is a file offset, not an RVA.
		signature: await signature(source, security.rva, security.size, signal),
		managed: clr.rva !== 0 && clr.size !== 0
	}
}
