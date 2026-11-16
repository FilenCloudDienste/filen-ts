import { startsWith, viewOf, type ByteSpan } from "@/features/preview/lib/imageSniff/bytes"

// Photoshop (Adobe Photoshop File Formats Specification): a 26-byte header ("8BPS", version 1, or 2 for the Large
// Document Format PSB, 6 reserved bytes, channels, height, width, depth, colour mode), the colour mode data section,
// then the image resources section. Its blocks hold the embedded thumbnail: 1036 (Photoshop 5.0+, RGB JPEG) or 1033
// (Photoshop 4.0, BGR JPEG), each a 28-byte header followed by JFIF data.

export interface PsdThumbnail {
	readonly id: 1033 | 1036
	// The JFIF data, after the resource's 28-byte header.
	readonly jpeg: ByteSpan
}

export interface PsdHeader {
	readonly version: 1 | 2
	readonly channels: number
	readonly width: number
	readonly height: number
	readonly depth: number
	readonly mode: number
	// The image resources section's end in the file; null when the colour mode data before it leaves the head.
	readonly resourcesEnd: number | null
	readonly thumbnail: PsdThumbnail | null
	// "needsMore" when the head ended inside the resources section before a 1036 block was found: a read reaching
	// further may find one. "searched" when the section was walked to its end (or its blocks stop making sense).
	readonly resources: "searched" | "needsMore"
}

export const MAX_PSD_RESOURCE_BLOCKS = 1024

const PSD_MAGIC = [0x38, 0x42, 0x50, 0x53]
const PSD_HEADER_BYTES = 26
const THUMBNAIL_HEADER_BYTES = 28
const RESOURCE_THUMBNAIL = 1036
const RESOURCE_THUMBNAIL_PS4 = 1033
// "8BIM", and the signatures other Adobe applications write into the same section.
const RESOURCE_SIGNATURES: ReadonlySet<number> = new Set([0x3842494d, 0x4d655361, 0x50485554, 0x41674867, 0x44435352])

interface ResourceWalk {
	readonly thumbnail: PsdThumbnail | null
	readonly complete: boolean
}

function walkResources(head: Uint8Array, start: number, end: number): ResourceWalk {
	const view = viewOf(head)
	let thumbnail: PsdThumbnail | null = null
	let at = start

	for (let blocks = 0; blocks < MAX_PSD_RESOURCE_BLOCKS && at < end; blocks++) {
		// Signature, id, then a Pascal name padded to an even length (length byte included).
		if (at + 7 > head.length) {
			return { thumbnail, complete: false }
		}

		if (!RESOURCE_SIGNATURES.has(view.getUint32(at))) {
			break
		}

		const id = view.getUint16(at + 4)
		const nameBytes = (view.getUint8(at + 6) + 2) & ~1
		const sizeAt = at + 6 + nameBytes

		if (sizeAt + 4 > head.length) {
			return { thumbnail, complete: false }
		}

		const size = view.getUint32(sizeAt)
		const data = sizeAt + 4
		// The data is padded to an even length.
		const next = data + size + (size & 1)

		if (data + size > end) {
			break
		}

		if ((id === RESOURCE_THUMBNAIL || (id === RESOURCE_THUMBNAIL_PS4 && thumbnail === null)) && size > THUMBNAIL_HEADER_BYTES) {
			thumbnail = { id, jpeg: { offset: data + THUMBNAIL_HEADER_BYTES, length: size - THUMBNAIL_HEADER_BYTES } }

			if (id === RESOURCE_THUMBNAIL) {
				break
			}
		}

		at = next
	}

	return { thumbnail, complete: true }
}

export function sniffPsd(head: Uint8Array, fileSize: number): PsdHeader | null {
	if (head.length < PSD_HEADER_BYTES + 4 || !startsWith(head, PSD_MAGIC)) {
		return null
	}

	const view = viewOf(head)
	const version = view.getUint16(4)
	const channels = view.getUint16(12)
	const height = view.getUint32(14)
	const width = view.getUint32(18)
	const depth = view.getUint16(22)
	const mode = view.getUint16(24)

	if ((version !== 1 && version !== 2) || width === 0 || height === 0 || channels === 0) {
		return null
	}

	const header = { version, channels, width, height, depth, mode } as const
	const resourcesLengthAt = PSD_HEADER_BYTES + 4 + view.getUint32(PSD_HEADER_BYTES)

	if (resourcesLengthAt + 4 > Math.min(head.length, fileSize)) {
		// The colour mode data runs past the head (an indexed palette is 768 bytes, a duotone spec rarely more).
		return { ...header, resourcesEnd: null, thumbnail: null, resources: resourcesLengthAt + 4 > fileSize ? "searched" : "needsMore" }
	}

	const start = resourcesLengthAt + 4
	const resourcesEnd = Math.min(fileSize, start + view.getUint32(resourcesLengthAt))
	const walk = walkResources(head, start, resourcesEnd)

	return {
		...header,
		resourcesEnd,
		thumbnail: walk.thumbnail,
		resources: walk.complete || walk.thumbnail?.id === RESOURCE_THUMBNAIL ? "searched" : "needsMore"
	}
}
