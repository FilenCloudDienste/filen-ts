// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { DrawingList, rgba } from "../core/drawingml/index"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { SlideLayer, SlideRender, TextSeed } from "../core/presentation/output"
import { drawingData } from "../core/presentation/render/slide"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { SlideView } from "../react/presentation/SlideView"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { paintEditorSlide, paintSlide } from "../react/presentation/paint/slide"
import { FakeMeasurer, testFont } from "./textFixtures"

// The editor's painter draws an empty placeholder's prompt; the painter of the show, the presenter and the viewer
// never does. The prompt is hidden while its placeholder's text is edited, also when a render lands meanwhile.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHAPE: ShapeRef = { slide: slideRef(7), id: 3 }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function laid(text: string) {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 300, height: 100 },
		ENV
	)

	return { body, page: result.page, layout: transferableLayout(result) }
}

function empty(width: number, height: number) {
	const list = new DrawingList()

	list.width = width
	list.height = height

	return drawingData(list)
}

// A slide with one empty placeholder (its prompt laid out) and one shape with text.
function slide(revision: number): SlideRender {
	const prompt: SlideLayer = {
		shape: SHAPE,
		role: "placeholder",
		drawing: empty(300, 100),
		matrix: [1, 0, 0, 1, 10, 10],
		textMatrix: [1, 0, 0, 1, 10, 10],
		prompt: laid("Click to add title").page
	}
	const text: SlideLayer = {
		shape: { slide: SHAPE.slide, id: 4 },
		role: "shape",
		drawing: empty(300, 100),
		matrix: [1, 0, 0, 1, 10, 200],
		text: laid("Words").page
	}

	return {
		ref: SHAPE.slide,
		index: 0,
		revision,
		hidden: false,
		background: empty(960, 540),
		layers: [prompt, text],
		notesText: "",
		animated: false
	}
}

function session(): PresentationSessionApi {
	const seed = (): TextSeed => {
		const { body, page, layout } = laid("")

		return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], page, layout, matrix: [1, 0, 0, 1, 10, 10] }
	}

	return {
		textSeed: () => Promise.resolve(seed()),
		layoutText: (_shape: ShapeRef, body: TextBody) =>
			Promise.resolve({ ...laid(body.paragraphs[0]?.runs[0]?.kind === "r" ? body.paragraphs[0].runs[0].text : ""), revision: 2 }),
		command: (): Promise<CommandResult> => Promise.resolve({ ok: true, revision: 2, dirty: true })
	} as unknown as PresentationSessionApi
}

async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function promptOf(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>("[data-fo-prompt]")
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("empty placeholder prompts on the page", () => {
	it("are painted by the editor's painter only, as no content", () => {
		const editor = paintEditorSlide(slide(1), { document, session: undefined, signal: { aborted: false } })
		const shown = paintSlide(slide(1), { document, session: undefined, signal: { aborted: false } })
		const prompt = editor.root.querySelector<HTMLElement>("[data-fo-prompt]")

		expect(prompt?.textContent).toContain("Click to add title")
		expect(prompt?.getAttribute("aria-hidden")).toBe("true")
		expect(prompt?.classList.contains("fo-slide-text")).toBe(false)
		expect(editor.root.querySelectorAll(".fo-slide-text")).toHaveLength(1)
		expect(shown.root.querySelector("[data-fo-prompt]")).toBeNull()
		expect(shown.root.textContent).not.toContain("Click to add title")
	})

	it("hide while the placeholder's text is edited, also over a render that lands meanwhile", async () => {
		const host = document.createElement("div")

		document.body.append(host)

		const root = createRoot(host)
		const editing = createTextEditing()
		const view = (render: SlideRender, edited: boolean) => (
			<SlideView
				render={render}
				size={{ cx: 960 * 9525, cy: 540 * 9525 }}
				painter={paintEditorSlide}
				label="Slide 1"
				zoom={1}
				mode="edit"
				overlay={
					edited ? (
						<PresentationTextEditor
							session={session()}
							shape={SHAPE}
							scale={1}
							editing={editing}
							labels={{ editor: "Slide text" }}
							render={render}
							apple={false}
							measurer={new FakeMeasurer()}
							onExit={() => undefined}
							onRefused={() => undefined}
						/>
					) : null
				}
			/>
		)

		await act(async () => {
			root.render(view(slide(1), false))
		})

		expect(promptOf(host)?.style.visibility).toBe("")

		await act(async () => {
			root.render(view(slide(1), true))
		})
		await flushAll()

		expect(promptOf(host)?.style.visibility).toBe("hidden")

		// A commit's new render (the text emptied again) is painted after the editor's own effects ran.
		await act(async () => {
			root.render(view(slide(2), true))
		})
		await flushAll()

		expect(promptOf(host)?.style.visibility).toBe("hidden")

		await act(async () => {
			root.render(view(slide(3), false))
		})
		await flushAll()

		expect(promptOf(host)?.style.visibility).toBe("")

		await act(async () => {
			root.unmount()
		})
	})
})
