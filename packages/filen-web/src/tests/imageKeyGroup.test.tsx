// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ZoomableImage } from "@/features/preview/components/zoomableImage"
import { ImageKeyGroupContext } from "@/features/preview/lib/imageDisplay"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { registerAction } from "@/lib/keymap/registry"
import "@/lib/i18n"

// Two image viewers on screen at once (a comic's spread): the zoom keys go to the one the group names, not to both.

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

afterEach(() => {
	cleanup()
})

function zoomIn(): void {
	act(() => {
		fireEvent.keyDown(document.body, { key: "=", code: "Equal", ctrlKey: true })
	})
}

describe("image viewer key group", () => {
	it("zooms only the viewer the group gives the keys to", () => {
		const group = { owns: (element: Element) => element.closest("[data-owner]") !== null }

		render(
			<ImageKeyGroupContext value={group}>
				<div data-owner="">
					<ZoomableImage
						url="blob:a"
						alt="left"
					/>
				</div>
				<div>
					<ZoomableImage
						url="blob:b"
						alt="right"
					/>
				</div>
			</ImageKeyGroupContext>
		)

		const before = screen.getByAltText("right").style.transform

		zoomIn()
		expect(screen.getByAltText("left").style.transform).not.toBe(before)
		expect(screen.getByAltText("right").style.transform).toBe(before)
	})
})
