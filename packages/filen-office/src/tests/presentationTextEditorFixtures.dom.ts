import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { rgba } from "../core/drawingml/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor, type PresentationTextEditorProps } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing, type TextEditing } from "../react/presentation/edit/text/editing"
import { FakeMeasurer, testFont } from "./textFixtures"

// What the slide text editor suites share: a body laid out as the worker lays it out, its seed, a session answering
// at once, a slide frame painted the way paintSlide marks it, and the editor mounted in it.

export const SHAPE: ShapeRef = { slide: slideRef(7), id: 3 }

// The theme's colour for every scheme slot: what a run without its own colour is painted in (here the text colour).
export const THEME_TEXT = "336699"

const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

export function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, {
			listStyles: [],
			bodyPr: [],
			fonts: { color: color => rgba(color.kind === "srgb" ? color.rgb : THEME_TEXT), typeface: typeface => typeface }
		}),
		{ width: 300, height: 100 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result) }
}

// A body of one paragraph holding `text` (none for no text), seeded at (40, 50) on the slide.
export function seedOf(text: string, overrides: Partial<TextSeed> = {}): TextSeed {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: text === "" ? [] : [{ kind: "r", text, rPr: {} }] }] }

	return {
		shape: SHAPE,
		revision: 1,
		body,
		resolved: [{ pPr: {}, runs: [{}] }],
		...laid(body),
		matrix: [1, 0, 0, 1, 40, 50],
		...overrides
	}
}

export function fakeSession(ops: DeckOp[], undos: (ShapeRef | undefined)[]): PresentationSessionApi {
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
export function frameWithLayers(): HTMLElement {
	const frame = document.createElement("div")

	frame.className = "fo-slide-frame"
	frame.innerHTML =
		'<div class="fo-slide-content"><div class="fo-slide-layer" data-fo-layer="0"><div class="fo-slide-text">layout</div></div>' +
		'<div class="fo-slide-layer" data-fo-layer="1"><div class="fo-slide-text">Hello</div></div></div>'
	document.body.append(frame)

	return frame
}

export async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

// The editor mounted in `host` on a fake session at scale 1, its seed answered and drawn; `props` override any prop.
export async function mountEditor(
	host: HTMLElement,
	props: Partial<PresentationTextEditorProps> = {}
): Promise<{ root: Root; editing: TextEditing }> {
	const editing = props.editing ?? createTextEditing()
	const root = createRoot(host)

	await act(async () => {
		root.render(
			createElement(PresentationTextEditor, {
				session: fakeSession([], []),
				shape: SHAPE,
				scale: 1,
				labels: { editor: "Slide text" },
				apple: false,
				measurer: new FakeMeasurer(),
				onExit: () => undefined,
				onRefused: () => undefined,
				...props,
				editing
			})
		)
	})
	await flushAll()

	return { root, editing }
}
