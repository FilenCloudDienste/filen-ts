import {
	annexBNal,
	avcPictureOrderCount,
	avcPpsPocPresent,
	avcSliceHeader,
	freshPocState,
	parseAvcSps,
	type AvcPocState,
	type AvcSps
} from "@filen/shared/videos"

// Presentation times of H.264 pictures that a container stores in decode order without them (AVI), or with decode
// times only (ASF as ffmpeg writes it), or with a PTS on only some (a program stream packing several pictures in one
// PES): a picture's time is its anchor's plus half its order-count distance from it, in frames. The anchor is the last
// picture whose time is known to be its presentation (`exact`), else the last key picture.

// The NAL units of an H.264 sample, Annex B or length-prefixed (`lengthSize`).
export function* avcNalUnits(data: Uint8Array, lengthSize: number | null): Generator<Uint8Array> {
	if (lengthSize !== null) {
		for (let at = 0; at + lengthSize <= data.length;) {
			let length = 0

			for (let i = 0; i < lengthSize; i++) {
				length = length * 256 + (data[at + i] ?? 0)
			}

			yield data.subarray(at + lengthSize, Math.min(data.length, at + lengthSize + length))
			at += lengthSize + length
		}

		return
	}

	for (let at = 0; at + 3 < data.length;) {
		const nal = annexBNal(data.subarray(at), () => true)

		if (nal === null) {
			return
		}

		yield nal

		at = nal.byteOffset - data.byteOffset + nal.length
	}
}

export interface AvcParameters {
	sps: AvcSps
	pocPresent: boolean
}

// The parameter sets in a sample, when it carries an SPS.
export function avcParameters(data: Uint8Array, lengthSize: number | null): AvcParameters | null {
	let sps: AvcSps | null = null
	let pocPresent = false

	for (const nal of avcNalUnits(data, lengthSize)) {
		const type = (nal[0] ?? 0) & 0x1f

		if (type === 7) {
			sps ??= parseAvcSps(nal)
		} else if (type === 8) {
			pocPresent = avcPpsPocPresent(nal) ?? pocPresent
		}
	}

	return sps === null ? null : { sps, pocPresent }
}

export interface AvcTimelineState {
	poc: AvcPocState
	anchor: { time: number; poc: number } | null
	// The latest presentation time given so far: an IDR without a time of its own shows after it.
	latest: number | null
}

export function freshTimeline(): AvcTimelineState {
	return { poc: freshPocState(), anchor: null, latest: null }
}

export function cloneTimeline(state: AvcTimelineState): AvcTimelineState {
	return { poc: { ...state.poc }, anchor: state.anchor, latest: state.latest }
}

// One picture in decode order: whether decoding can start at it (an IDR), its presentation time, and whether it carries
// an SPS before its first slice. `time` is the
// container's time for it (null for none); `exact` says that time is its presentation time. In-band parameter sets
// update `parameters`.
export function avcPicture(
	data: Uint8Array,
	lengthSize: number | null,
	parameters: AvcParameters,
	state: AvcTimelineState,
	time: number | null,
	exact: boolean,
	frame: number
): { key: boolean; pts: number | null; parameterSets: boolean } {
	let parameterSets = false

	for (const nal of avcNalUnits(data, lengthSize)) {
		const type = (nal[0] ?? 0) & 0x1f

		if (type === 7) {
			parameters.sps = parseAvcSps(nal) ?? parameters.sps
			parameterSets = true
		} else if (type === 8) {
			parameters.pocPresent = avcPpsPocPresent(nal) ?? parameters.pocPresent
		} else if (type === 1 || type === 5) {
			const key = type === 5
			const slice = avcSliceHeader(nal, parameters.sps, parameters.pocPresent)

			if (slice === null) {
				return { key, pts: time, parameterSets }
			}

			const poc = avcPictureOrderCount(slice, parameters.sps, state.poc)

			if (time !== null && (exact || key || state.anchor === null)) {
				state.anchor = { time, poc }
			} else if (slice.idr && state.latest !== null) {
				// The order count starts over at an IDR: without a time of its own it shows after every picture before it.
				state.anchor = { time: state.latest + frame, poc }
			}

			const pts = state.anchor === null ? time : state.anchor.time + ((poc - state.anchor.poc) / 2) * frame

			if (pts !== null) {
				state.latest = Math.max(state.latest ?? pts, pts)
			}

			return { key, pts, parameterSets }
		}
	}

	return { key: false, pts: time, parameterSets }
}

// A key picture with the stream's parameter sets in front, for a stream that keeps them out of band (in its format
// header) while its pictures are Annex B: a remux finds them in the picture, as it does in a transport stream.
export function withParameterSets(parameterSets: Uint8Array, picture: Uint8Array): Uint8Array {
	const out = new Uint8Array(parameterSets.length + picture.length)

	out.set(parameterSets)
	out.set(picture, parameterSets.length)

	return out
}
