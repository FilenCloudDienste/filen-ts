// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import "@/lib/i18n"
import type { DriveItem } from "@/features/drive/lib/item"
import type { FrameRequests } from "@/features/preview/videoEdit/components/frameRequests"
import type { TextOverlay } from "@/features/preview/videoEdit/types"
import {
	pillColor,
	TEXT_FONT_STACK,
	TEXT_FONT_WEIGHT,
	TEXT_LINE_HEIGHT,
	TEXT_MAX_WIDTH_FRACTION,
	TEXT_PAD_X,
	TEXT_PAD_Y
} from "@/features/preview/videoEdit/gl/textRaster.logic"
import { recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"

// The video editor's stage in its Text tab: the draggable boxes are the only preview of text there, so they wear the
// export's look (face, padding, line pitch, pill, wrap width), dim outside their time range as the export hides them,
// and a drag the browser cancels puts the box back where the recipe has it.

vi.mock("@/features/preview/hooks/usePreviewVideo", () => ({ usePreviewVideo: () => ({ controller: null, snapshot: null }) }))

const { VideoStage } = await import("@/features/preview/videoEdit/components/videoStage")

class SizedResizeObserver {
	private readonly callback: ResizeObserverCallback

	public constructor(callback: ResizeObserverCallback) {
		this.callback = callback
	}

	public observe(): void {
		this.callback([{ contentRect: { width: 1600, height: 900 } } as ResizeObserverEntry], this)
	}

	public unobserve = vi.fn()

	public disconnect = vi.fn()
}

const BLACK: TextOverlay = {
	id: "black",
	text: "Caption",
	startSec: 2,
	endSec: 5,
	x: 0.25,
	y: 0.75,
	size: 0.1,
	color: "#000000",
	background: true
}

function renderStage(settledOutputTime: number) {
	const onMoveText = vi.fn()
	const frames = { request: vi.fn(), clear: vi.fn() } as unknown as FrameRequests

	render(
		<VideoStage
			item={{ type: "file", data: { uuid: "video-1" } } as unknown as DriveItem}
			positionKey="video-1"
			info={sourceInfo()}
			recipe={recipeFor(60, { text: [BLACK] })}
			mode="text"
			aspect="free"
			paused
			settledTime={settledOutputTime}
			settledOutputTime={settledOutputTime}
			decodingSuspended={false}
			selectedText={null}
			frames={frames}
			canvasRef={createRef<HTMLCanvasElement>()}
			onVideo={vi.fn()}
			onCrop={vi.fn()}
			onSelectText={vi.fn()}
			onMoveText={onMoveText}
		/>
	)

	return { onMoveText, box: screen.getByRole("button", { name: "Text: Caption" }) }
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", SizedResizeObserver)
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()
	Element.prototype.hasPointerCapture = vi.fn(() => true)
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

describe("VideoStage text boxes", () => {
	it("wear the export's look: its pill for dark text, face, padding, line pitch and wrap width", () => {
		const { box } = renderStage(3)
		const expected = document.createElement("div")

		// Normalised the way the DOM writes it back.
		expected.style.backgroundColor = pillColor("#000000")
		expected.style.fontFamily = TEXT_FONT_STACK

		expect(box.style.backgroundColor).toBe(expected.style.backgroundColor)
		expect(box.style.fontFamily).toBe(expected.style.fontFamily)
		expect(box.style.fontWeight).toBe(String(TEXT_FONT_WEIGHT))
		expect(box.style.padding).toBe(`${String(TEXT_PAD_Y)}em ${String(TEXT_PAD_X)}em`)
		expect(box.style.lineHeight).toBe(String(TEXT_LINE_HEIGHT))
		expect(box.style.maxWidth).toBe(`${String(TEXT_MAX_WIDTH_FRACTION * 100)}%`)
		expect(box.style.width).toBe("max-content")
		expect(box.style.boxSizing).toBe("border-box")
		expect(box.className).toContain("whitespace-pre-wrap")
		expect(box.className).not.toContain("opacity-40")
	})

	it("dims as the export hides the box: shown from its start, hidden from its end", () => {
		expect(renderStage(2).box.className).not.toContain("opacity-40")
		cleanup()
		expect(renderStage(5).box.className).toContain("opacity-40")
		cleanup()
		expect(renderStage(1.99).box.className).toContain("opacity-40")
	})

	for (const ending of ["pointerCancel", "lostPointerCapture"] as const) {
		it(`puts a box back where the recipe has it on ${ending}, moving nothing`, () => {
			const { box, onMoveText } = renderStage(3)

			act(() => {
				fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
				fireEvent.pointerMove(box, { pointerId: 1, clientX: 300, clientY: 200 })
			})

			expect(box.style.left).not.toBe("25%")

			act(() => {
				fireEvent[ending](box, { pointerId: 1 })
			})

			expect(box.style.left).toBe("25%")
			expect(box.style.top).toBe("75%")
			expect(onMoveText).not.toHaveBeenCalled()
		})
	}
})
