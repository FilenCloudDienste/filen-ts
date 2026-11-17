import { describe, expect, it } from "vitest"
import { avcPictureOrderCount, freshPocState, type AvcPocParams, type AvcSlice, type AvcSps } from "@filen/shared/videos"

function sps(poc: Partial<AvcPocParams>): AvcSps {
	return {
		profile: 100,
		compatibility: 0,
		level: 31,
		width: 64,
		height: 36,
		bitDepth: 8,
		par: 1,
		transfer: null,
		frameSeconds: null,
		reorderFrames: null,
		poc: {
			log2MaxFrameNum: 4,
			pocType: 0,
			log2MaxPocLsb: 4,
			deltaPicOrderAlwaysZero: false,
			offsetForNonRefPic: 0,
			offsetForTopToBottomField: 0,
			offsetsForRefFrame: [],
			frameMbsOnly: true,
			separateColourPlane: false,
			...poc
		}
	}
}

function slice(fields: Partial<AvcSlice>): AvcSlice {
	return {
		idr: false,
		refIdc: 1,
		frameNum: 0,
		field: false,
		bottomField: false,
		pocLsb: 0,
		deltaPocBottom: 0,
		deltaPoc: [0, 0],
		...fields
	}
}

describe("avcPictureOrderCount", () => {
	it("counts type 0 across the LSB's wrap, and restarts at an IDR", () => {
		const params = sps({ pocType: 0, log2MaxPocLsb: 4 })
		const state = freshPocState()
		const counts = [0, 4, 2, 8, 6, 12, 10, 2, 14].map((lsb, i) =>
			avcPictureOrderCount(slice({ idr: i === 0, pocLsb: lsb, refIdc: lsb % 4 === 0 ? 1 : 0 }), params, state)
		)

		// From the reference picture at 12, an LSB of 2 has wrapped the 4 bits: 18.
		expect(counts).toEqual([0, 4, 2, 8, 6, 12, 10, 18, 14])
		expect(avcPictureOrderCount(slice({ idr: true, pocLsb: 0 }), params, state)).toBe(0)
	})

	it("counts from the first picture when a count starts past an IDR", () => {
		const params = sps({ pocType: 0, log2MaxPocLsb: 4 })
		const state = freshPocState()

		expect(avcPictureOrderCount(slice({ pocLsb: 14 }), params, state)).toBe(14)
		expect(avcPictureOrderCount(slice({ pocLsb: 2 }), params, state)).toBe(18)
	})

	it("counts type 2 in decode order, non-reference pictures one before", () => {
		const params = sps({ pocType: 2, log2MaxFrameNum: 4 })
		const state = freshPocState()

		expect(avcPictureOrderCount(slice({ idr: true, frameNum: 0 }), params, state)).toBe(0)
		expect(avcPictureOrderCount(slice({ frameNum: 1 }), params, state)).toBe(2)
		expect(avcPictureOrderCount(slice({ frameNum: 2, refIdc: 0 }), params, state)).toBe(3)
		// frame_num wraps at 16: the offset carries it on.
		expect(avcPictureOrderCount(slice({ frameNum: 15 }), params, state)).toBe(30)
		expect(avcPictureOrderCount(slice({ frameNum: 0 }), params, state)).toBe(32)
	})

	it("counts type 1 from the reference frame cycle", () => {
		const params = sps({ pocType: 1, offsetsForRefFrame: [2], offsetForNonRefPic: -1 })
		const state = freshPocState()

		expect(avcPictureOrderCount(slice({ idr: true, frameNum: 0 }), params, state)).toBe(0)
		expect(avcPictureOrderCount(slice({ frameNum: 1 }), params, state)).toBe(2)
		expect(avcPictureOrderCount(slice({ frameNum: 2, refIdc: 0 }), params, state)).toBe(1)
	})
})
