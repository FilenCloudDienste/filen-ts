import { startsWith, viewOf } from "@/features/preview/lib/imageSniff/bytes"

// QOI (qoiformat.org, specification 1.0): "qoif", width and height as 32-bit big endian, channels (3 RGB, 4 RGBA) and
// colorspace (0 sRGB with linear alpha, 1 all linear).

export interface QoiHeader {
	readonly width: number
	readonly height: number
	readonly hasAlpha: boolean
}

const QOI_MAGIC = [0x71, 0x6f, 0x69, 0x66]
const QOI_HEADER_BYTES = 14

export function sniffQoi(head: Uint8Array): QoiHeader | null {
	if (head.length < QOI_HEADER_BYTES || !startsWith(head, QOI_MAGIC)) {
		return null
	}

	const view = viewOf(head)
	const width = view.getUint32(4)
	const height = view.getUint32(8)
	const channels = view.getUint8(12)
	const colorspace = view.getUint8(13)

	if (width === 0 || height === 0 || (channels !== 3 && channels !== 4) || colorspace > 1) {
		return null
	}

	return { width, height, hasAlpha: channels === 4 }
}
