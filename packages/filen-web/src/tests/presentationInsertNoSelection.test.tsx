// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { usePresentationPictures } from "@/features/presentation/components/ribbon/insertObjects"

vi.mock("@/features/preview/lib/docxImages", () => ({
	BROWSER_PICTURE_CODECS: {},
	driveSource: () => undefined,
	fileSource: () => undefined
}))

// Insert commands with nothing selected on the slide: the picture goes onto the slide in view, centred, as PowerPoint
// inserts it; nothing waits for a selection.

const EMU = 9525
const ref = slideRef(256)
const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	editable: true
} as unknown as OpenInfo

function png(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(33)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	new DataView(bytes.buffer).setUint32(16, width)
	new DataView(bytes.buffer).setUint32(20, height)
	bytes.set([8, 6, 0, 0, 0], 24)

	return bytes
}

describe("insert with nothing selected", () => {
	it("puts a picture from this device on the slide in view, centred", async () => {
		const selection = createShapeSelection()

		// The slide shows; no shape is selected, so the ribbon has no render.
		selection.show(ref)

		const sent: DeckOp[] = []
		const render = { ref, index: 0, revision: 1, layers: [] } as unknown as SlideRender
		const editor: PresentationRibbonEditor = {
			info: INFO,
			render: undefined,
			selection,
			session: { render: vi.fn(() => Promise.resolve([render])) } as unknown as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				sent.push(op)

				return Promise.resolve({ ok: true, revision: 2, dirty: true })
			}
		}
		const { result } = renderHook(() => usePresentationPictures(editor))
		const bytes = png(200, 100)

		await result.current.take([{ size: bytes.length, name: "photo.png", type: "image/png", read: () => Promise.resolve(bytes) }])

		expect(sent).toHaveLength(1)

		const op = sent[0] as Extract<DeckOp, { family: "picture"; kind: "insert" }>

		expect(op).toMatchObject({ family: "picture", kind: "insert", slide: ref })

		const box = op.shape.xfrm

		expect(box === undefined ? undefined : Math.round(box.x + box.cx / 2)).toBe(480 * EMU)
		expect(box === undefined ? undefined : Math.round(box.y + box.cy / 2)).toBe(270 * EMU)
	})
})
