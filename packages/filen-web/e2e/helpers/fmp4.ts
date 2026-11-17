// The samples of a fragmented MP4 as a SourceBuffer receives it: the init segment's timescale, then each fragment's
// samples with their decode and presentation times (tfdt, trun durations and composition offsets), in seconds.

export interface Fmp4Sample {
	dts: number
	pts: number
	duration: number
	size: number
	key: boolean
}

interface Box {
	type: string
	start: number
	end: number
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const found: Box[] = []

	for (let at = start; at + 8 <= end;) {
		let size = view.getUint32(at)
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
		let header = 8

		if (size === 1 && at + 16 <= end) {
			size = Number(view.getBigUint64(at + 8))
			header = 16
		} else if (size === 0) {
			size = end - at
		}

		if (size < header || at + size > end) {
			break
		}

		found.push({ type, start: at + header, end: at + size })
		at += size
	}

	return found
}

function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box | undefined {
	return boxes(bytes, parent.start + skip, parent.end).find(box => box.type === type)
}

export function fmp4Samples(bytes: Uint8Array, limit: number): { timescale: number | null; samples: Fmp4Sample[] } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const top = boxes(bytes, 0, bytes.length)
	let timescale: number | null = null
	const samples: Fmp4Sample[] = []
	const moov = top.find(box => box.type === "moov")
	const trak = moov === undefined ? undefined : child(bytes, moov, "trak")
	const mdia = trak === undefined ? undefined : child(bytes, trak, "mdia")
	const mdhd = mdia === undefined ? undefined : child(bytes, mdia, "mdhd")

	if (mdhd !== undefined) {
		const version = bytes[mdhd.start] ?? 0

		timescale = view.getUint32(mdhd.start + (version === 1 ? 20 : 12))
	}

	const scale = timescale ?? 1

	for (const moof of top.filter(box => box.type === "moof")) {
		const traf = child(bytes, moof, "traf")

		if (traf === undefined) {
			continue
		}

		const tfhd = child(bytes, traf, "tfhd")
		const tfdt = child(bytes, traf, "tfdt")
		const trun = child(bytes, traf, "trun")

		if (tfhd === undefined || trun === undefined) {
			continue
		}

		const tfhdFlags = view.getUint32(tfhd.start) & 0xffffff
		let at = tfhd.start + 8

		if (tfhdFlags & 0x1) at += 8
		if (tfhdFlags & 0x2) at += 4

		const defaultDuration = tfhdFlags & 0x8 ? view.getUint32(at) : 0

		if (tfhdFlags & 0x8) at += 4

		const defaultSize = tfhdFlags & 0x10 ? view.getUint32(at) : 0

		if (tfhdFlags & 0x10) at += 4

		const defaultFlags = tfhdFlags & 0x20 ? view.getUint32(at) : 0
		let dts =
			tfdt === undefined
				? 0
				: (bytes[tfdt.start] ?? 0) === 1
					? Number(view.getBigUint64(tfdt.start + 4))
					: view.getUint32(tfdt.start + 4)
		const version = bytes[trun.start] ?? 0
		const flags = view.getUint32(trun.start) & 0xffffff
		const count = view.getUint32(trun.start + 4)
		let cursor = trun.start + 8

		if (flags & 0x1) cursor += 4

		const firstFlags = flags & 0x4 ? view.getUint32(cursor) : null

		if (flags & 0x4) cursor += 4

		for (let index = 0; index < count && samples.length < limit; index++) {
			const duration = flags & 0x100 ? view.getUint32(cursor) : defaultDuration

			if (flags & 0x100) cursor += 4

			const size = flags & 0x200 ? view.getUint32(cursor) : defaultSize

			if (flags & 0x200) cursor += 4

			const sampleFlags = flags & 0x400 ? view.getUint32(cursor) : index === 0 && firstFlags !== null ? firstFlags : defaultFlags

			if (flags & 0x400) cursor += 4

			const offset = flags & 0x800 ? (version === 1 ? view.getInt32(cursor) : view.getUint32(cursor)) : 0

			if (flags & 0x800) cursor += 4

			samples.push({
				dts: dts / scale,
				pts: (dts + offset) / scale,
				duration: duration / scale,
				size,
				// sample_is_non_sync_sample clear.
				key: (sampleFlags & 0x10000) === 0
			})
			dts += duration
		}
	}

	return { timescale, samples }
}
