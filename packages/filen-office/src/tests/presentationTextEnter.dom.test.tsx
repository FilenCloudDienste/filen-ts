// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { slideRef, type ShapeRef } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import type { CommandResult } from "../dom/presentation/protocol"
import { HIT_MARGIN_PX, ShapeEditLayer } from "../react/presentation/edit/overlay"
import { createShapeSelection } from "../react/presentation/edit/selection"

// Double-clicking a shape enters its text where the click landed: the canvas hands the text editor the point (slide
// px), so the first caret goes there, not to the end of the body.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const EMU = 9525
const ref = slideRef(256)
const XFRM = { x: 100 * EMU, y: 50 * EMU, cx: 400 * EMU, cy: 100 * EMU, rot: 0, flipH: false, flipV: false }
const RENDER = {
	ref,
	index: 0,
	revision: 1,
	hidden: false,
	background: {},
	layers: [
		{
			shape: { slide: ref, id: 2 },
			role: "placeholder",
			drawing: { width: 400, height: 100 },
			matrix: [1, 0, 0, 1, 100, 50],
			box: { id: 2, xfrm: XFRM, body: "placeholder" }
		}
	],
	notesText: "",
	animated: false
} as unknown as SlideRender

let root: Root | undefined

afterEach(() => {
	act(() => root?.unmount())
	document.body.replaceChildren()
})

describe("entering a shape's text", () => {
	it("hands the text editor the double-clicked point in slide px", () => {
		const entered: { shape: ShapeRef; at: { x: number; y: number } | undefined }[] = []
		const host = document.createElement("div")
		const content = document.createElement("div")
		const layer = document.createElement("div")

		content.className = "fo-slide-content"
		layer.dataset["foLayer"] = "0"
		content.append(layer)
		document.body.append(content, host)
		root = createRoot(host)
		act(() => {
			root?.render(
				<ShapeEditLayer
					render={RENDER as unknown as SlideRender & { layers: SlideLayer[] }}
					size={{ cx: 960 * EMU, cy: 540 * EMU }}
					scale={1}
					selection={createShapeSelection()}
					editable
					bindings={{
						selectAll: "mod+a",
						group: "mod+g",
						ungroup: "mod+shift+u",
						bringToFront: "",
						sendToBack: "",
						bringForward: "",
						sendBackward: ""
					}}
					labels={{ canvas: "Slide editor", describe: () => "" }}
					command={() => Promise.resolve({ ok: true, revision: 1, dirty: true } as CommandResult)}
					onEnterText={(shape, at) => entered.push({ shape, at })}
				/>
			)
		})

		const canvas = host.querySelector<HTMLElement>("[data-fo-shape-edit]") as HTMLElement

		vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
			left: -HIT_MARGIN_PX,
			top: -HIT_MARGIN_PX,
			width: 960 + 2 * HIT_MARGIN_PX,
			height: 540 + 2 * HIT_MARGIN_PX
		} as DOMRect)
		act(() => {
			canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 150, clientY: 70 }))
		})

		expect(entered).toEqual([{ shape: { slide: ref, id: 2 }, at: { x: 150, y: 70 } }])
	})
})
