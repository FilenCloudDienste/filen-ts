// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { FakeMeasurer, testFont } from "./textFixtures"

// Typed text shows in the frame of the key: before the worker answers, the typed characters are in the painted span
// they extend and the caret is past them; the worker's page then replaces the echo.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHAPE: ShapeRef = { slide: slideRef(7), id: 3 }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 300, height: 100 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(text: string): TextSeed {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }

	return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], ...laid(body), matrix: [1, 0, 0, 1, 40, 50] }
}

function fakeSession(ops: DeckOp[], undos: (ShapeRef | undefined)[]): PresentationSessionApi {
	return {
		textSeed: () => Promise.resolve(seedOf("Hello")),
		layoutText: (_shape: ShapeRef, body: TextBody) => Promise.resolve({ ...laid(body), revision: 2 }),
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		},
		undo: (open?: ShapeRef): Promise<CommandResult> => {
			undos.push(open)

			return Promise.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf("Hello") })
		}
	} as unknown as PresentationSessionApi
}

// A slide painted the way paintSlide marks it: layer 0 is the layout's, layer 1 the shape's own.
function frameWithLayers(): HTMLElement {
	const frame = document.createElement("div")

	frame.className = "fo-slide-frame"
	frame.innerHTML =
		'<div class="fo-slide-content"><div class="fo-slide-layer" data-fo-layer="0"><div class="fo-slide-text">layout</div></div>' +
		'<div class="fo-slide-layer" data-fo-layer="1"><div class="fo-slide-text">Hello</div></div></div>'
	document.body.append(frame)

	return frame
}

async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

describe("presentation text echo", () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it("paints typed text and moves the caret before the worker's layout, which then replaces the echo", async () => {
		const answers: ((value: unknown) => void)[] = []
		const frame = frameWithLayers()
		const editing = createTextEditing()
		const root = createRoot(frame)
		const session = {
			...fakeSession([], []),
			layoutText: (_shape: ShapeRef, body: TextBody) =>
				new Promise(resolve => {
					answers.push(() => resolve({ ...laid(body), revision: 2 }))
				})
		} as unknown as PresentationSessionApi

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={session}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Slide text" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => undefined}
					onRefused={() => undefined}
				/>
			)
		})
		await flushAll()

		const controller = editing.active
		const painted = (): string => frame.querySelector(".fo-text-edit-box .fo-docx-text")?.textContent ?? ""
		const caretX = (): number => Number.parseFloat((frame.querySelector(".fo-text-caret") as HTMLElement).style.left)
		const before = caretX()

		expect(painted()).toContain("Hello")
		act(() => {
			controller?.dispatch(controller.state.tr.insertText("ab", controller.state.doc.content.size - 1), true)
		})

		// No answer yet: the echo.
		expect(painted()).toContain("Helloab")
		expect(caretX()).toBeGreaterThan(before)

		const echoed = caretX()

		await act(async () => {
			for (const answer of answers.splice(0)) answer(undefined)
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(painted()).toContain("Helloab")
		expect(painted()).not.toContain("Helloabab")
		expect(caretX()).toBeCloseTo(echoed, 3)

		await act(async () => {
			root.unmount()
		})
	})
})
