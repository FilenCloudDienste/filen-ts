import { describe, expect, it, vi } from "vitest"
import { paintThumbnail, thumbnailHeight, type ThumbnailCanvas } from "../react/docx/paint/thumbnail"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// A page's thumbnail (the navigation pane's Pages): one bar per run of text on its lines, sized to the canvas.

function recordingCanvas(): { canvas: ThumbnailCanvas; rects: [number, number, number, number][] } {
	const rects: [number, number, number, number][] = []
	const context = {
		setTransform: vi.fn(),
		clearRect: vi.fn(),
		fillRect: (x: number, y: number, width: number, height: number) => {
			rects.push([x, y, width, height])
		},
		fillStyle: "",
		globalAlpha: 1
	}
	const canvas: ThumbnailCanvas = { width: 0, height: 0, getContext: () => context }

	return { canvas, rects }
}

describe("page thumbnails", () => {
	it("draws a bar for each run of text, on its line, at the thumbnail's size", async () => {
		const { editor } = await pagedEditor(buildDocx({ body: p("First line") + p("Second") }))

		await settleAll(editor)

		const page = editor.page(0)

		if (page === undefined) throw new Error("no page")

		const { canvas, rects } = recordingCanvas()

		paintThumbnail(canvas, page, 120, 2, "rgb(0, 0, 0)")
		expect(canvas.width).toBe(240)
		expect(canvas.height).toBe(Math.round(thumbnailHeight(page.width, page.height, 120) * 2))
		expect(rects.length).toBeGreaterThanOrEqual(2)

		// Bars lie within the page, the second paragraph's below the first's.
		for (const [x, y, width, height] of rects) {
			expect(x).toBeGreaterThanOrEqual(0)
			expect(x + width).toBeLessThanOrEqual(page.width)
			expect(y + height).toBeLessThanOrEqual(page.height)
		}

		expect(rects[rects.length - 1]?.[1]).toBeGreaterThan(rects[0]?.[1] ?? 0)
		editor.dispose()
	})
})
