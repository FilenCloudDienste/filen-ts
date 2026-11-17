import { BitReader, unescapeRbsp, type AvcSps } from "./codecString"

// H.264 picture order count (ITU-T H.264 8.2.1) from slice headers: the presentation order of pictures that a
// container stores only in decode order (AVI). A counter is fed each picture's first slice in decode order.

export interface AvcSlice {
	idr: boolean
	// nal_ref_idc: 0 for a picture no other refers to.
	refIdc: number
	frameNum: number
	field: boolean
	bottomField: boolean
	pocLsb: number
	deltaPocBottom: number
	deltaPoc: [number, number]
}

// bottom_field_pic_order_in_frame_present_flag of a PPS NAL unit (header byte included); null when unreadable.
export function avcPpsPocPresent(nal: Uint8Array): boolean | null {
	if (((nal[0] ?? 0) & 0x1f) !== 8) {
		return null
	}

	const bits = new BitReader(unescapeRbsp(nal.subarray(1)))

	if (bits.ue() === null || bits.ue() === null || bits.read(1) === null) {
		return null
	}

	const present = bits.read(1)

	return present === null ? null : present === 1
}

// The header fields of a coded slice NAL unit (types 1 and 5, header byte included) that picture order count needs;
// null when unreadable. `pocPresent` comes from the PPS.
export function avcSliceHeader(nal: Uint8Array, sps: AvcSps, pocPresent: boolean): AvcSlice | null {
	const type = (nal[0] ?? 0) & 0x1f

	if (type !== 1 && type !== 5) {
		return null
	}

	const { poc } = sps
	// The header is a few dozen bytes at most; unescaping all of a large slice is wasted work.
	const bits = new BitReader(unescapeRbsp(nal.subarray(1, 64)))

	if (bits.ue() === null || bits.ue() === null || bits.ue() === null) {
		return null
	}

	if (poc.separateColourPlane) {
		bits.read(2)
	}

	const frameNum = bits.read(poc.log2MaxFrameNum)
	let field = false
	let bottomField = false

	if (frameNum === null) {
		return null
	}

	if (!poc.frameMbsOnly) {
		field = bits.read(1) === 1
		bottomField = field && bits.read(1) === 1
	}

	const idr = type === 5

	if (idr && bits.ue() === null) {
		return null
	}

	let pocLsb = 0
	let deltaPocBottom = 0
	const deltaPoc: [number, number] = [0, 0]

	if (poc.pocType === 0) {
		pocLsb = bits.read(poc.log2MaxPocLsb) ?? -1

		if (pocLsb < 0) {
			return null
		}

		if (pocPresent && !field) {
			deltaPocBottom = bits.se() ?? 0
		}
	} else if (poc.pocType === 1 && !poc.deltaPicOrderAlwaysZero) {
		deltaPoc[0] = bits.se() ?? 0

		if (pocPresent && !field) {
			deltaPoc[1] = bits.se() ?? 0
		}
	}

	return { idr, refIdc: ((nal[0] ?? 0) >> 5) & 0x03, frameNum, field, bottomField, pocLsb, deltaPocBottom, deltaPoc }
}

export interface AvcPocState {
	prevPocMsb: number
	prevPocLsb: number
	prevFrameNumOffset: number
	prevFrameNum: number
	// No picture seen yet: the first one seeds the state, IDR or not.
	fresh: boolean
}

export function freshPocState(): AvcPocState {
	return { prevPocMsb: 0, prevPocLsb: 0, prevFrameNumOffset: 0, prevFrameNum: 0, fresh: true }
}

// The picture's order count, advancing `state`. A count started at a picture that is no IDR counts from that
// picture, which is all a presentation order relative to it needs.
export function avcPictureOrderCount(slice: AvcSlice, sps: AvcSps, state: AvcPocState): number {
	const { poc } = sps

	if (state.fresh && !slice.idr) {
		state.prevPocLsb = slice.pocLsb
		state.prevFrameNum = slice.frameNum
	}

	state.fresh = false

	if (poc.pocType === 0) {
		if (slice.idr) {
			state.prevPocMsb = 0
			state.prevPocLsb = 0
		}

		const max = 2 ** poc.log2MaxPocLsb
		const { prevPocLsb, prevPocMsb } = state
		const msb =
			slice.pocLsb < prevPocLsb && prevPocLsb - slice.pocLsb >= max / 2
				? prevPocMsb + max
				: slice.pocLsb > prevPocLsb && slice.pocLsb - prevPocLsb > max / 2
					? prevPocMsb - max
					: prevPocMsb
		const top = msb + slice.pocLsb

		if (slice.refIdc !== 0) {
			state.prevPocMsb = msb
			state.prevPocLsb = slice.pocLsb
		}

		return slice.field ? top : Math.min(top, top + slice.deltaPocBottom)
	}

	const maxFrameNum = 2 ** poc.log2MaxFrameNum
	const offset = slice.idr ? 0 : state.prevFrameNum > slice.frameNum ? state.prevFrameNumOffset + maxFrameNum : state.prevFrameNumOffset

	state.prevFrameNumOffset = offset
	state.prevFrameNum = slice.frameNum

	if (poc.pocType === 2) {
		return slice.idr ? 0 : 2 * (offset + slice.frameNum) - (slice.refIdc === 0 ? 1 : 0)
	}

	const cycle = poc.offsetsForRefFrame
	let absolute = cycle.length === 0 ? 0 : offset + slice.frameNum

	if (slice.refIdc === 0 && absolute > 0) {
		absolute--
	}

	let expected = 0

	if (absolute > 0) {
		const perCycle = cycle.reduce((sum, value) => sum + value, 0)
		const count = Math.floor((absolute - 1) / cycle.length)
		const within = (absolute - 1) % cycle.length

		expected = count * perCycle

		for (let i = 0; i <= within; i++) {
			expected += cycle[i] ?? 0
		}
	}

	if (slice.refIdc === 0) {
		expected += poc.offsetForNonRefPic
	}

	const top = expected + slice.deltaPoc[0]

	if (slice.field) {
		return slice.bottomField ? expected + poc.offsetForTopToBottomField + slice.deltaPoc[0] : top
	}

	return Math.min(top, top + poc.offsetForTopToBottomField + slice.deltaPoc[1])
}
