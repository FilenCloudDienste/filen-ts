import { withoutFormatControls } from "@filen/shared/formatControls"
import { asciiField, startsWith, u16, u32, u64, utf16 } from "@/features/preview/lib/binaryInfo/bytes"
import type { BinarySource, DmgInfo, IsoInfo } from "@/features/preview/lib/binaryInfo/types"

// Disk images: an Apple UDIF image (its "koly" trailer and the partition names in its property list) and an ISO 9660
// or UDF image (its volume descriptors from sector 16).

const KOLY = [0x6b, 0x6f, 0x6c, 0x79]
const ENCRCDSA = [0x65, 0x6e, 0x63, 0x72, 0x63, 0x64, 0x73, 0x61]
const MAX_PLIST = 1024 * 1024
const MAX_PARTITIONS = 64

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function xmlText(text: string): string {
	return withoutFormatControls(text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? "")).trim()
}

// A UDIF image, or an encrypted one (its header begins "encrcdsa"); null for neither.
export async function readDmg(source: BinarySource, head: Uint8Array, signal?: AbortSignal): Promise<DmgInfo | null> {
	if (startsWith(head, ENCRCDSA)) {
		return { format: "dmg", encrypted: true, dataSize: null, partitions: [] }
	}

	if (source.size < 512) {
		return null
	}

	const trailer = await source.read(source.size - 512, 512, signal)

	if (!startsWith(trailer, KOLY)) {
		return null
	}

	const dataSize = u64(trailer, 32, false)
	const xmlOffset = u64(trailer, 216, false)
	const xmlLength = u64(trailer, 224, false)
	const partitions: string[] = []

	if (xmlOffset !== null && xmlLength !== null && xmlLength > 0 && xmlLength <= MAX_PLIST && xmlOffset + xmlLength <= source.size) {
		const plist = new TextDecoder().decode(await source.read(xmlOffset, xmlLength, signal))
		const names = /<key>(?:CFName|Name)<\/key>\s*<string>([^<]*)<\/string>/g

		for (let match = names.exec(plist); match !== null && partitions.length < MAX_PARTITIONS; match = names.exec(plist)) {
			const name = xmlText(match[1] ?? "")

			if (name !== "" && !partitions.includes(name)) partitions.push(name.slice(0, 256))
		}
	}

	return { format: "dmg", encrypted: false, dataSize, partitions }
}

const SECTOR = 2048
const FIRST_DESCRIPTOR = 16 * SECTOR
const DESCRIPTORS = 16
const CD001 = [0x43, 0x44, 0x30, 0x30, 0x31]

// "YYYYMMDDHHMMSScc" then a zone offset; all zeros (or blanks) for none.
function isoDate(bytes: Uint8Array, at: number): string | null {
	const text = asciiField(bytes, at, at + 14)

	if (text === null || !/^\d{14}$/.test(text) || /^0+$/.test(text)) {
		return null
	}

	return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)} ${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}`
}

// The UCS-2 escape sequences a Joliet supplementary descriptor carries (%/@, %/C, %/E).
function isJoliet(descriptor: Uint8Array): boolean {
	return descriptor[88] === 0x25 && descriptor[89] === 0x2f && [0x40, 0x43, 0x45].includes(descriptor[90] ?? 0)
}

function jolietField(descriptor: Uint8Array, start: number, end: number): string | null {
	const text = utf16(descriptor, start, end, false).trim()

	return text === "" ? null : text
}

// The volume descriptor set from sector 16: its primary descriptor (or a Joliet one's longer names), an El Torito boot
// record, UDF's descriptors. Null when it has none of them.
export async function readIso(source: BinarySource, signal?: AbortSignal): Promise<IsoInfo | null> {
	if (source.size < FIRST_DESCRIPTOR + SECTOR) {
		return null
	}

	const set = await source.read(FIRST_DESCRIPTOR, DESCRIPTORS * SECTOR, signal)
	let primary: Uint8Array | null = null
	let joliet: Uint8Array | null = null
	let bootable = false
	let udf = false

	for (let index = 0; index < DESCRIPTORS; index++) {
		const descriptor = set.subarray(index * SECTOR, (index + 1) * SECTOR)
		const id = asciiField(descriptor, 1, 6)

		if (startsWith(descriptor, CD001, 1)) {
			const type = descriptor[0]

			if (type === 0 && asciiField(descriptor, 7, 39)?.startsWith("EL TORITO") === true) bootable = true
			else if (type === 1) primary ??= descriptor
			else if (type === 2 && isJoliet(descriptor)) joliet ??= descriptor
			else if (type === 255) break
		} else if (id === "NSR02" || id === "NSR03") {
			udf = true
		} else if (id !== "BEA01" && id !== "TEA01" && id !== "BOOT2" && id !== "CDW02") {
			break
		}
	}

	if (primary === null && !udf) {
		return null
	}

	const names = joliet ?? primary
	const field = (start: number, end: number): string | null =>
		names === null ? null : names === joliet ? jolietField(names, start, end) : asciiField(names, start, end)
	const blocks = primary === null ? null : u32(primary, 80, true)
	const blockSize = primary === null ? null : u16(primary, 128, true)

	return {
		format: "iso",
		volume: field(40, 72),
		system: field(8, 40),
		publisher: field(318, 446),
		application: field(574, 702),
		created: primary === null ? null : isoDate(primary, 813),
		volumeBytes: blocks === null || blockSize === null || blockSize === 0 ? null : blocks * blockSize,
		bootable,
		udf
	}
}
