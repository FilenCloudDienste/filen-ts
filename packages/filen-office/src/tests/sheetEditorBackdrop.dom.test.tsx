// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { inThreadSheetHost } from "../dom/sheet/host"
import { SheetGrid, SheetGridModel, type SheetGridExtension, type SheetGridHandle } from "../react/sheet/index"
import { RecordingCanvas } from "./sheetGridCanvas"
import { BASIC, IMMEDIATE, buildFixture } from "./sheetSessionFixtures"

// An extension's text drawn under the in-cell editor's (a formula's references in colour): the same text in the same
// box, kept in step with the editor's scroll, and none for an entry the extension leaves plain or while an input
// method composes.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

beforeEach(() => {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() => new RecordingCanvas() as unknown as CanvasRenderingContext2D
	)
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 800 : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 400 : 0
	})
})

const roots: Root[] = []

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
})

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

// Colours "A1" wherever a formula has it.
const asked: string[] = []
const COLORING: SheetGridExtension = {
	id: "colouring",
	editorText: text => {
		asked.push(text)

		if (!text.startsWith("=")) return null

		return text.split(/(A1)/).map((part, index) =>
			part === "A1" ? (
				<span
					key={index}
					style={{ color: "rgb(31, 95, 214)" }}
				>
					{part}
				</span>
			) : (
				part
			)
		)
	}
}

async function mount(): Promise<{ model: SheetGridModel; scroller: HTMLElement }> {
	const host = inThreadSheetHost()
	const opened = await host.open(buildFixture(BASIC), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })
	const container = document.createElement("div")
	const ref = createRef<SheetGridHandle>()
	const root = createRoot(container)

	roots.push(root)
	document.body.appendChild(container)
	await act(async () => {
		root.render(
			<SheetGrid
				ref={ref}
				grid={model}
				label="Sheet"
				editorLabel="Cell entry"
				extensions={[COLORING]}
			/>
		)
	})
	await settle()
	act(() => ref.current?.renderer.paint())

	return { model, scroller: container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement }
}

function open(scroller: HTMLElement, model: SheetGridModel, text: string): HTMLTextAreaElement {
	act(() => {
		scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true, cancelable: true }))
	})
	act(() => model.setEditText(text))

	return document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement
}

function backdrop(): HTMLElement | null {
	return document.querySelector<HTMLElement>(".fo-sheet-editor-backdrop")
}

describe("the in-cell editor's backdrop", () => {
	it("draws the extension's text in the editor's box, glyph for glyph, and the editor's own text clear", async () => {
		const { model, scroller } = await mount()
		const editor = open(scroller, model, "=A1+B2*A1")
		const box = editor.parentElement as HTMLElement

		expect(backdrop()?.textContent).toBe(editor.value)
		expect(backdrop()?.parentElement).toBe(box)
		expect(box.hasAttribute("data-colored")).toBe(true)
		expect([...(backdrop()?.querySelectorAll("span") ?? [])].map(span => [span.textContent, span.style.color])).toEqual([
			["A1", "rgb(31, 95, 214)"],
			["A1", "rgb(31, 95, 214)"]
		])
		// The renderer places the box (the editor and the backdrop in it) over the cell.
		expect(box.style.transform).toMatch(/^translate\(/)
		expect(box.style.getPropertyValue("--fo-sheet-editor-min-width")).toMatch(/px$/)
		expect(asked.at(-1)).toBe("=A1+B2*A1")
	})

	it("follows the editor's scroll", async () => {
		const { model, scroller } = await mount()
		const editor = open(scroller, model, `=A1+${"B2+".repeat(80)}A1`)

		editor.scrollLeft = 120
		act(() => {
			editor.dispatchEvent(new Event("scroll"))
		})

		const layer = backdrop()?.firstElementChild as HTMLElement

		expect(layer.style.transform).toBe("translate(-120px, 0px)")
	})

	it("draws nothing under an entry the extension leaves plain", async () => {
		const { model, scroller } = await mount()
		const editor = open(scroller, model, "A1 is plain")

		expect(editor.value).toBe("A1 is plain")
		expect(backdrop()).toBeNull()
		expect(editor.parentElement?.hasAttribute("data-colored")).toBe(false)
	})

	it("shows the editor's own text while an input method composes", async () => {
		const { model, scroller } = await mount()
		const editor = open(scroller, model, "=A1")

		act(() => {
			editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
		})

		expect(backdrop()).toBeNull()

		act(() => {
			editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
		})

		expect(backdrop()?.textContent).toBe("=A1")
	})
})
