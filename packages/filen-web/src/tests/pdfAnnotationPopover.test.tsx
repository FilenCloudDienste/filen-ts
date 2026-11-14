// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PDF_PRESET_STAMPS, type PdfAnnotationInfo } from "@filen/office/core/pdfedit/annotations"
import { PdfAnnotationPopover } from "@/features/pdf/annotations/annotationPopover"
import {
	clampWidth,
	colorKey,
	hasColor,
	hasStrokeWidth,
	opacityPercent,
	PDF_STAMP_KEYS
} from "@/features/pdf/annotations/annotationPopover.logic"
import { i18n } from "@/lib/i18n"

// The annotation popover: colour from the office grid, opacity and width committed once, comment and delete, and a
// locked annotation that only shows its comments.

afterEach(cleanup)

function info(extra: Partial<PdfAnnotationInfo> = {}): PdfAnnotationInfo {
	return {
		page: 0,
		id: 9,
		type: "Ink",
		rect: [0, 0, 10, 10],
		color: [1, 0, 0],
		interiorColor: null,
		opacity: 0.5,
		width: 3,
		author: "Ann",
		created: null,
		modified: null,
		text: "",
		replyTo: null,
		geometry: "points",
		locked: false,
		...extra
	}
}

// The sliders' range inputs (visually hidden inputs the slider drives).
function sliders(): HTMLInputElement[] {
	return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="range"]'))
}

function popover(value: PdfAnnotationInfo) {
	const onStyle = vi.fn()
	const onComment = vi.fn()
	const onDelete = vi.fn()

	render(
		<PdfAnnotationPopover
			info={value}
			onStyle={onStyle}
			onComment={onComment}
			onDelete={onDelete}
		/>
	)

	return { onStyle, onComment, onDelete }
}

describe("annotation popover logic", () => {
	it("knows which controls apply", () => {
		expect(hasStrokeWidth({ type: "Ink" })).toBe(true)
		expect(hasStrokeWidth({ type: "Highlight" })).toBe(false)
		expect(hasColor({ type: "Stamp" })).toBe(false)
		expect(hasColor({ type: "FreeText" })).toBe(true)
		expect(colorKey([1, 0, 0])).toBe("FF0000")
		expect(colorKey(null)).toBeUndefined()
		expect(opacityPercent(0.333)).toBe(33)
		expect(clampWidth(0)).toBe(0.5)
		expect(clampWidth(3.3)).toBe(3.5)
		expect(clampWidth(40)).toBe(12)
	})

	it("names every preset stamp", () => {
		for (const stamp of PDF_PRESET_STAMPS) expect(i18n.t(`preview:${PDF_STAMP_KEYS[stamp]}`)).not.toBe(PDF_STAMP_KEYS[stamp])
	})
})

describe("PdfAnnotationPopover", () => {
	it("picks a colour from the office grid", async () => {
		const { onStyle } = popover(info())

		fireEvent.click(screen.getByRole("button", { name: "Color" }))
		fireEvent.click(await screen.findByRole("button", { name: "Blue" }))
		expect(onStyle).toHaveBeenCalledWith({ color: [0, 112 / 255, 192 / 255] })
	})

	it("shows opacity and line width for stroked annotations only", () => {
		popover(info())
		expect(screen.getByText("50%")).toBeTruthy()
		expect(screen.getByText("3 pt")).toBeTruthy()
		expect(sliders()).toHaveLength(2)

		cleanup()
		popover(info({ type: "Highlight", geometry: null }))
		expect(sliders()).toHaveLength(1)
	})

	it("commits a slider once when it is released", () => {
		const { onStyle } = popover(info())
		const [opacity] = sliders()

		if (opacity === undefined) throw new Error("no slider")

		fireEvent.keyDown(opacity, { key: "ArrowRight" })
		expect(onStyle).toHaveBeenCalledTimes(1)
		expect(onStyle).toHaveBeenCalledWith({ opacity: 0.55 })
	})

	it("opens the comment thread and deletes", () => {
		const { onComment, onDelete } = popover(info())

		fireEvent.click(screen.getByRole("button", { name: "Comment" }))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		expect(onComment).toHaveBeenCalledTimes(1)
		expect(onDelete).toHaveBeenCalledTimes(1)
	})

	it("only offers comments on a locked annotation", () => {
		popover(info({ locked: true }))

		expect(screen.getByText("This annotation is locked.")).toBeTruthy()
		expect(sliders()).toEqual([])
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
		expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy()
	})
})
