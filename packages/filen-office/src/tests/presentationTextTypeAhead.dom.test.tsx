// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { FakeMeasurer, testFont } from "./textFixtures"

// Keys typed from the moment a body is asked for until its editor is ready (its seed still on the way) are held and
// then typed into it, in order: none is dropped, whether the body is a slide's text box or notes still being made.

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
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: text === "" ? [] : [{ kind: "r", text, rPr: {} }] }] }

	return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], ...laid(body), matrix: [1, 0, 0, 1, 40, 50] }
}

function frame(): HTMLElement {
	const element = document.createElement("div")

	element.className = "fo-slide-frame"
	element.tabIndex = 0
	document.body.append(element)

	return element
}

function press(key: string, init: KeyboardEventInit = {}): void {
	;(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
	)
}

function typed(text: string): void {
	for (const char of text) press(char)
}

// A seed answered when `answer` is called: the editor is not ready until then.
function slowSession(text: string): { session: PresentationSessionApi; answer: () => void } {
	let answer: () => void = () => undefined
	const session = {
		textSeed: () =>
			new Promise<TextSeed>(resolve => {
				answer = () => {
					resolve(seedOf(text))
				}
			}),
		layoutText: (_shape: ShapeRef, body: TextBody) => Promise.resolve({ ...laid(body), revision: 2 }),
		command: () => Promise.resolve({ ok: true, revision: 2, dirty: true })
	} as unknown as PresentationSessionApi

	return { session, answer: () => answer() }
}

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

describe("keys typed while a body opens", () => {
	afterEach(() => {
		document.body.replaceChildren()
	})

	it("a slide's text box: what is typed before its editor is ready lands in order, Backspace and Enter included", async () => {
		const host = frame()
		const editing = createTextEditing()
		const { session, answer } = slowSession("Hi")
		const root = createRoot(host)

		host.focus()
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

		// Typed fast, before the seed comes: the end of the text, a typo taken back, a new paragraph.
		typed(" thereX")
		press("Backspace")
		press("Enter")
		typed("next")

		await act(async () => {
			answer()
			await Promise.resolve()
		})
		await settle()

		const body = editing.active?.body

		expect(body?.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "r" ? run.text : "")).join(""))).toEqual([
			"Hi there",
			"next"
		])

		act(() => {
			root.unmount()
		})
	})

	it("notes still being made: keys typed from the moment they are asked for land in the body once it opens", async () => {
		const host = frame()
		const editing = createTextEditing()
		const { session, answer } = slowSession("")

		host.focus()
		// The notes pane asks for the body (notes.setNotes in flight): the editor is not mounted yet.
		editing.expect()
		typed("Speak slowly")

		const root = createRoot(host)

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={session}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Speaker notes" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => undefined}
					onRefused={() => undefined}
				/>
			)
		})
		typed(" now")
		await act(async () => {
			answer()
			await Promise.resolve()
		})
		await settle()

		const body = editing.active?.body

		expect(body?.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "r" ? run.text : "")).join(""))).toEqual([
			"Speak slowly now"
		])

		act(() => {
			root.unmount()
		})
	})

	it("keys are held only while a body is asked for: once taken back, typing goes where it would", () => {
		const editing = createTextEditing()
		const host = frame()
		const seen: string[] = []

		host.addEventListener("keydown", event => {
			seen.push(event.key)
		})
		host.focus()
		editing.expect()
		typed("ab")
		editing.drop()
		typed("cd")

		expect(seen).toEqual(["c", "d"])
	})
	it("focus moved elsewhere while the body opens (a ribbon tab): its keys stay its own, and the editor leaves focus there", async () => {
		const host = frame()
		const tab = document.createElement("button")
		const seen: string[] = []

		tab.addEventListener("keydown", event => {
			seen.push(event.key)
		})
		document.body.append(tab)

		const editing = createTextEditing()
		const { session, answer } = slowSession("Hi")
		const root = createRoot(host)

		host.focus()
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
		typed("a")
		tab.focus()
		press(" ")
		press("Enter")

		await act(async () => {
			answer()
			await Promise.resolve()
		})
		await settle()

		expect(seen).toEqual([" ", "Enter"])
		expect(document.activeElement).toBe(tab)
		expect(
			editing.active?.body.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "r" ? run.text : "")).join(""))
		).toEqual(["Hi"])

		act(() => {
			root.unmount()
		})
	})

	it("Escape while a slide's text box opens gives the open up: nothing typed after it is held for the body", async () => {
		const host = frame()
		const editing = createTextEditing()
		const { session } = slowSession("Hi")
		const root = createRoot(host)
		const seen: string[] = []
		let exits = 0

		host.addEventListener("keydown", event => {
			seen.push(event.key)
		})
		host.focus()
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
					onExit={() => {
						exits++
					}}
					onRefused={() => undefined}
				/>
			)
		})
		press("Escape")
		typed("xyz")

		expect(exits).toBe(1)
		expect(seen).toEqual(["x", "y", "z"])

		act(() => {
			root.unmount()
		})
	})
	it("an open asked with focus on the page (a mouse click that focuses no button): keys are held there, and a move to the find field drops them", () => {
		const overlay = frame()
		const opener = document.createElement("div")
		const find = document.createElement("input")
		const seen: string[] = []

		opener.tabIndex = 0
		overlay.append(opener, find)
		find.addEventListener("keydown", event => {
			seen.push(event.key)
		})

		const editing = createTextEditing()

		// The click left focus on the overlay, not on the notes area it asked from.
		overlay.focus()
		editing.expect({ anchor: opener })
		typed("ab")
		// Mod+F: the find field takes focus, and what follows is its own.
		find.focus()
		typed("qz")

		const held = editing.take()

		expect([...held]).toEqual([])
		expect(held.focusMoved).toBe(true)
		expect(seen).toEqual(["q", "z"])
	})

	it("an open asked with focus on the page holds what is typed while focus stays there", () => {
		const overlay = frame()
		const opener = document.createElement("div")

		overlay.append(opener)

		const editing = createTextEditing()

		overlay.focus()
		editing.expect({ anchor: opener })
		typed("ab")

		const held = editing.take()

		expect([...held]).toEqual([{ kind: "text", text: "ab" }])
		expect(held.focusMoved).toBe(false)
	})
	it("a body gone before its editor is ready (an undo took the notes away) closes the editor with nothing refused", async () => {
		const host = frame()
		const editing = createTextEditing()
		const refused: string[] = []
		let exits = 0
		const session = {
			// As the worker's answer reaches the page: an error carrying the refusal's reason.
			textSeed: () => Promise.reject(Object.assign(new Error("No node 9"), { reason: "notFound" }))
		} as unknown as PresentationSessionApi
		const root = createRoot(host)

		host.focus()
		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={session}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Speaker notes" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => {
						exits++
					}}
					onRefused={reason => {
						refused.push(reason)
					}}
				/>
			)
		})
		await settle()

		expect(refused).toEqual([])
		expect(exits).toBe(1)

		act(() => {
			root.unmount()
		})
	})
	it("a shortcut pressed while the body opens (Mod+S, Mod+Z) goes to the page, and what is typed after it is still held for the body", () => {
		const overlay = frame()
		const opener = document.createElement("div")
		const seen: string[] = []

		overlay.append(opener)
		overlay.addEventListener("keydown", event => {
			seen.push(event.key)
		})

		const editing = createTextEditing()

		overlay.focus()
		editing.expect({ anchor: opener })
		typed("a")
		press("s", { ctrlKey: true })
		typed("q")
		press("z", { ctrlKey: true })
		typed("z")

		const held = editing.take()

		expect([...held]).toEqual([{ kind: "text", text: "aqz" }])
		// Focus is still where the open was asked: the editor takes it.
		expect(held.focusMoved).toBe(false)
		expect(seen).toEqual(["s", "z"])
	})

	it("a shortcut that opens another control (Mod+F, the find field) leaves focus there", () => {
		const overlay = frame()
		const opener = document.createElement("div")
		const find = document.createElement("input")

		overlay.append(opener)
		overlay.addEventListener("keydown", event => {
			if (event.key === "f" && event.ctrlKey) find.focus()
		})
		document.body.append(find)

		const editing = createTextEditing()

		overlay.focus()
		editing.expect({ anchor: opener })
		typed("a")
		press("f", { ctrlKey: true })
		typed("qz")

		const held = editing.take()

		expect([...held]).toEqual([])
		expect(held.focusMoved).toBe(true)
		expect(document.activeElement).toBe(find)
	})

	it("a formatting key pressed while notes open (Mod+B) applies to what is typed in them, and the editor keeps focus", async () => {
		const host = frame()
		const editing = createTextEditing()
		const { session, answer } = slowSession("")
		const seen: string[] = []

		host.addEventListener("keydown", event => {
			seen.push(event.key)
		})
		host.focus()
		editing.expect({ anchor: host, keys: { apple: false } })
		press("b", { code: "KeyB", ctrlKey: true })
		typed("hi")

		const root = createRoot(host)

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={session}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Speaker notes" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => undefined}
					onRefused={() => undefined}
				/>
			)
		})
		await act(async () => {
			answer()
			await Promise.resolve()
		})
		await settle()

		const runs = editing.active?.body.paragraphs.flatMap(paragraph => paragraph.runs) ?? []

		expect(runs.map(run => (run.kind === "r" ? run.text : "")).join("")).toBe("hi")
		expect(runs.every(run => run.kind === "r" && run.rPr.b === true)).toBe(true)
		// The key was the body's, not the page's.
		expect(seen).toEqual([])
		expect(host.querySelector("[data-fo-text-editor]")?.contains(document.activeElement)).toBe(true)

		act(() => {
			root.unmount()
		})
	})

	it("a character typed with AltGr (Ctrl+Alt) is text, held like any other", () => {
		const host = frame()
		const editing = createTextEditing()

		host.focus()
		editing.expect()
		press("@", { ctrlKey: true, altKey: true })

		expect([...editing.take()]).toEqual([{ kind: "text", text: "@" }])
	})
})
