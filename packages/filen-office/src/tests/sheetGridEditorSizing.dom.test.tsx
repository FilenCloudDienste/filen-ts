// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SheetGridHandle, SheetGridModel } from "../react/sheet/index"
import { RecordingCanvas } from "./sheetGridCanvas"
import { BASIC, IMMEDIATE, buildFixture } from "./sheetSessionFixtures"

// The in-cell editor sized to its entry: by CSS field-sizing where the engine has it (nothing written inline, no
// layout read), measured from its scroll size where it does not.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

// What the stubbed engine lays an entry out as: 7 px per character of its longest line, 16 px per line, and the
// 6 px of padding.
function scrollSize(text: string): { width: number; height: number } {
	const lines = text.split("\n")

	return { width: Math.max(...lines.map(line => line.length)) * 7 + 6, height: lines.length * 16 }
}

beforeEach(() => {
	vi.resetModules()
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
		() => new RecordingCanvas() as unknown as CanvasRenderingContext2D
	)
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 800 : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("fo-sheet-scroller") ? 400 : 0
	})
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this instanceof HTMLTextAreaElement ? scrollSize(this.value).width : 0
	})
	vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
		return this instanceof HTMLTextAreaElement ? scrollSize(this.value).height : 0
	})
})

const roots: Root[] = []

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount())

	document.body.innerHTML = ""
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

async function settle(): Promise<void> {
	for (let k = 0; k < 6; k++) await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

// The grid mounted with an engine that has (or lacks) field-sizing, the module read anew so it sees that engine.
async function mount(
	fieldSizing: boolean
): Promise<{ model: SheetGridModel; scroller: HTMLElement; ref: { current: SheetGridHandle | null } }> {
	vi.stubGlobal("CSS", {
		supports: (property: string, value: string) => fieldSizing && property === "field-sizing" && value === "content"
	})

	const { inThreadSheetHost } = await import("../dom/sheet/host")
	const { SheetGrid, SheetGridModel } = await import("../react/sheet/index")
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
			/>
		)
	})
	await settle()
	act(() => ref.current?.renderer.paint())

	return { model, scroller: container.querySelector<HTMLElement>(".fo-sheet-scroller") as HTMLElement, ref }
}

function open(scroller: HTMLElement, model: SheetGridModel, text: string): HTMLTextAreaElement {
	act(() => {
		scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))
	})
	act(() => model.setEditText(text))

	return document.querySelector<HTMLTextAreaElement>("textarea.fo-sheet-editor") as HTMLTextAreaElement
}

describe("the in-cell editor's size", () => {
	it("follows the entry where the engine lacks field-sizing", async () => {
		const { model, scroller } = await mount(false)
		const long = "a long entry that runs past its cell"
		const editor = open(scroller, model, long)

		expect(editor.style.width).toBe(`${String(scrollSize(long).width)}px`)
		expect(editor.style.height).toBe("16px")

		// Alt+Enter: a second line.
		act(() => model.setEditText(`${long}\nand more`))
		expect(editor.style.width).toBe(`${String(scrollSize(long).width)}px`)
		expect(editor.style.height).toBe("32px")

		act(() => model.setEditText("ab"))
		expect(editor.style.width).toBe(`${String(scrollSize("ab").width)}px`)
		expect(editor.style.height).toBe("16px")
	})

	it("is measured again when the renderer places the box anew", async () => {
		const { model, scroller } = await mount(false)
		const editor = open(scroller, model, "entry")
		const box = editor.parentElement as HTMLElement

		editor.style.width = ""
		box.style.setProperty("--fo-sheet-editor-max-width", "500px")
		await act(() => Promise.resolve())

		expect(editor.style.width).toBe(`${String(scrollSize("entry").width)}px`)
	})

	it("is left to CSS where the engine has field-sizing", async () => {
		const scrolled = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get")
		const { model, scroller } = await mount(true)

		scrolled.mockClear()

		const editor = open(scroller, model, "a long entry that runs past its cell")

		act(() => model.setEditText("two\nlines"))
		expect(editor.style.width).toBe("")
		expect(editor.style.height).toBe("")
		expect(scrolled).not.toHaveBeenCalled()
	})
})
