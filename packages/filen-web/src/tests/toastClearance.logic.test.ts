import { describe, expect, it } from "vitest"
import {
	computeToastClearance,
	toastBottomOffset,
	TOAST_EDGE_OFFSET_PX,
	TOAST_WIDTH_PX,
	type ObstructionRect
} from "@/lib/toastClearance.logic"

const viewport = {
	width: 1280,
	height: 800
}

// Toast column at 1280px: [1280 - 24 - 356, 1280 - 24] = [900, 1256].
function rect({ top, left, width, height }: { top: number; left: number; width: number; height: number }): ObstructionRect {
	return {
		top,
		left,
		right: left + width,
		width,
		height
	}
}

// The floating selection bar: centered in the content card, reaching into the toast column.
const selectionBar = rect({
	top: 800 - 24 - 46,
	left: 700,
	width: 420,
	height: 46
})
// The docked audio player: full-width, flush with the viewport bottom.
const audioPlayer = rect({
	top: 800 - 72,
	left: 0,
	width: 1280,
	height: 72
})

describe("computeToastClearance", () => {
	it("is 0 with nothing registered, so toasts sit flush", () => {
		expect(
			computeToastClearance({
				obstructions: [],
				viewport
			})
		).toBe(0)
	})

	it("clears the selection bar from its top edge down, including its own float gap", () => {
		expect(
			computeToastClearance({
				obstructions: [selectionBar],
				viewport
			})
		).toBe(24 + 46)
	})

	it("clears the audio player by its height", () => {
		expect(
			computeToastClearance({
				obstructions: [audioPlayer],
				viewport
			})
		).toBe(72)
	})

	it("clears the higher of the two when the bar floats above the docked player", () => {
		const stackedBar = rect({
			top: 800 - 72 - 8 - 16 - 46,
			left: 700,
			width: 420,
			height: 46
		})

		expect(
			computeToastClearance({
				obstructions: [audioPlayer, stackedBar],
				viewport
			})
		).toBe(72 + 8 + 16 + 46)
	})

	it("follows a resize: a taller player lifts the stack further", () => {
		const grown = rect({
			top: 800 - 96,
			left: 0,
			width: 1280,
			height: 96
		})

		expect(
			computeToastClearance({
				obstructions: [grown],
				viewport
			})
		).toBe(96)
	})

	it("ignores a bar outside the toast column (a left sidebar, or a centered bar on a wide screen)", () => {
		const columnLeft = viewport.width - TOAST_EDGE_OFFSET_PX - TOAST_WIDTH_PX

		expect(
			computeToastClearance({
				obstructions: [
					rect({
						top: 700,
						left: 80,
						width: columnLeft - 80,
						height: 46
					})
				],
				viewport
			})
		).toBe(0)
	})

	it("treats everything as overlapping below sonner's mobile breakpoint, where toasts span the width", () => {
		expect(
			computeToastClearance({
				obstructions: [
					rect({
						top: 600,
						left: 0,
						width: 120,
						height: 46
					})
				],
				viewport: {
					width: 400,
					height: 700
				}
			})
		).toBe(100)
	})

	it("ignores zero-area rects (a bar inside the closed drawer)", () => {
		expect(
			computeToastClearance({
				obstructions: [
					rect({
						top: 0,
						left: 0,
						width: 0,
						height: 0
					})
				],
				viewport
			})
		).toBe(0)
	})

	it("rounds a fractional clearance up so the stack never grazes the bar", () => {
		expect(
			computeToastClearance({
				obstructions: [
					rect({
						top: 729.4,
						left: 0,
						width: 1280,
						height: 70.6
					})
				],
				viewport
			})
		).toBe(71)
	})
})

describe("toastBottomOffset", () => {
	it("is the edge offset plus the bottom safe-area inset when nothing is cleared", () => {
		expect(
			toastBottomOffset({
				clearance: 0,
				edge: 24
			})
		).toBe("calc(24px + env(safe-area-inset-bottom, 0px))")
	})

	it("rests one edge offset above the obstruction, never below the safe-area floor", () => {
		expect(
			toastBottomOffset({
				clearance: 70,
				edge: 24
			})
		).toBe("max(94px, calc(24px + env(safe-area-inset-bottom, 0px)))")
	})
})
