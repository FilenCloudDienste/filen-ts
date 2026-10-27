import { describe, expect, it, vi } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { TextEditController, TYPING_GROUP_MS } from "../react/presentation/edit/text/controller"
import { FakeMeasurer, testFont } from "./textFixtures"

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }
const SHAPE: ShapeRef = { slide: slideRef(3), id: 2 }

function laid(body: TextBody) {
	const result = layoutBody(resolveBody(body, CONTEXT), { width: 400, height: 300 }, ENV)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(body: TextBody): TextSeed {
	const { page, layout } = laid(body)

	return {
		shape: SHAPE,
		revision: 1,
		body,
		resolved: body.paragraphs.map(paragraph => ({
			pPr: paragraph.pPr,
			runs: paragraph.runs.map(run => (run.kind === "opaque" ? {} : run.rPr))
		})),
		page,
		layout,
		matrix: [1, 0, 0, 1, 0, 0]
	}
}

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: { sz: 1800 } }] }] }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(r => {
		resolve = r
	})

	return { promise, resolve }
}

function tick(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

// A worker whose answers the test releases one by one, in the order a FIFO worker would send them.
function slowSession() {
	const ops: DeckOp[] = []
	const layouts: { body: TextBody; answer: ReturnType<typeof deferred<ReturnType<typeof laid> & { revision: number }>> }[] = []
	const undos: ReturnType<typeof deferred<CommandResult>>[] = []
	const opens: (ShapeRef | undefined)[] = []
	const api = {
		layoutText: (_shape: ShapeRef, body: TextBody) => {
			const answer = deferred<ReturnType<typeof laid> & { revision: number }>()

			layouts.push({ body, answer })

			return answer.promise
		},
		command: (op: DeckOp, open?: ShapeRef): Promise<CommandResult> => {
			ops.push(op)
			opens.push(open)

			return Promise.resolve({
				ok: true,
				revision: ops.length,
				dirty: true,
				...(op.kind === "replace" ? { seed: seedOf(plain("Replaced")) } : {})
			})
		},
		undo: (): Promise<CommandResult> => {
			const answer = deferred<CommandResult>()

			undos.push(answer)
			ops.push({ family: "text", kind: "setAutofitResult", target: SHAPE })

			return answer.promise
		},
		textSeed: () => Promise.resolve(seedOf(plain("x")))
	} as unknown as PresentationSessionApi

	return { api, ops, layouts, undos, opens }
}

function textOf(op: DeckOp | undefined): string | undefined {
	return op?.family === "text" && op.kind === "setText"
		? op.body.paragraphs.map(p => p.runs.map(r => (r.kind === "br" ? "\n" : r.text)).join("")).join("\n")
		: undefined
}

describe("presentation text controller with steps in flight", () => {
	it("a layout answered after an undo's reseed does not paint the undone text", async () => {
		const s = slowSession()
		const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		controller.dispatch(controller.state.tr.insertText("B", 2), true)

		const undone = controller.step("undo")

		// The first layout answers; the controller sends the newest body (ABTitle) after the undo went out.
		s.layouts[0]?.answer.resolve({ ...laid(s.layouts[0].body), revision: 1 })
		await tick()
		expect(s.layouts).toHaveLength(2)

		s.undos[0]?.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf(plain("Title")) })
		await undone
		expect(controller.state.doc.textContent).toBe("Title")

		s.layouts[1]?.answer.resolve({ ...laid(s.layouts[1].body), revision: 1 })
		await tick()

		// The painted page must be the reseeded document's.
		expect(controller.page.page.sourceTexts).toEqual(["Title"])
	})

	it("text typed while an undo is on its way is kept", async () => {
		const s = slowSession()
		const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		await controller.flush()

		const undone = controller.step("undo")

		await tick()
		// The user types "Z" at the end before the undo answers.
		controller.dispatch(controller.state.tr.insertText("Z", controller.state.doc.content.size - 1), true)
		s.undos[0]?.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf(plain("Title")) })
		await undone
		await controller.flush()

		const sent = s.ops.map(textOf).filter(text => text !== undefined)

		expect(controller.state.doc.textContent.includes("Z") || sent.some(text => text.includes("Z") && !text.startsWith("A"))).toBe(true)
	})

	it("an undo slower than the idle commit: view and worker end on the same body", async () => {
		vi.useFakeTimers()

		try {
			const s = slowSession()
			const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

			controller.dispatch(controller.state.tr.insertText("A", 1), true)
			await controller.flush()

			const undone = controller.step("undo")

			await vi.advanceTimersByTimeAsync(0)
			controller.dispatch(controller.state.tr.insertText("Z", controller.state.doc.content.size - 1), true)
			// The idle commit fires while the undo is still on its way: a setText of the pre-undo body goes after it.
			await vi.advanceTimersByTimeAsync(200)
			s.undos[0]?.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf(plain("Title")) })
			await undone
			await controller.flush()

			const lastSent = textOf(s.ops.filter(op => op.kind === "setText").at(-1))

			// Nothing went after the undo but the body the view shows: the undone text with the key typed meanwhile.
			expect(controller.state.doc.textContent).toBe("TitleZ")
			expect(lastSent).toBe(controller.state.doc.textContent)
		} finally {
			vi.useRealTimers()
		}
	})

	it("a command on the open body sends its pending text first, names the body, and reseeds from the answer", async () => {
		const s = slowSession()
		const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)

		const result = await controller.command({
			family: "text",
			kind: "replace",
			query: "Title",
			replacement: "Replaced",
			caseSensitive: false,
			targets: [{ target: SHAPE }]
		})

		expect(result.ok).toBe(true)
		expect(s.ops.map(op => op.kind)).toEqual(["setText", "replace"])
		expect(s.opens.at(-1)).toEqual(SHAPE)
		expect(controller.state.doc.textContent).toBe("Replaced")

		// The next key builds on the replaced body.
		controller.dispatch(controller.state.tr.insertText("!", controller.state.doc.content.size - 1), true)
		await controller.flush()
		expect(textOf(s.ops.at(-1))).toBe("Replaced!")
	})
})

describe("presentation text controller typing steps", () => {
	it("a pause longer than the history's group delay starts a new undo step", async () => {
		vi.useFakeTimers()

		try {
			const s = slowSession()
			const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

			controller.dispatch(controller.state.tr.insertText("A", 1), true)
			await vi.advanceTimersByTimeAsync(TYPING_GROUP_MS - 100)
			controller.dispatch(controller.state.tr.insertText("B", 2), true)
			await vi.advanceTimersByTimeAsync(TYPING_GROUP_MS + 100)
			controller.dispatch(controller.state.tr.insertText("C", 3), true)
			await controller.flush()

			const bursts = s.ops.map(op => (op.family === "text" && op.kind === "setText" ? op.burst : undefined))

			expect(bursts).toHaveLength(3)
			expect(bursts[1]).toBe(bursts[0])
			expect(bursts[2]).not.toBe(bursts[1])
		} finally {
			vi.useRealTimers()
		}
	})

	it("typing away from where the last typing was starts a new undo step", async () => {
		const s = slowSession()
		const controller = new TextEditController(
			s.api,
			seedOf(plain("Hello World")),
			new MeasureCache(new FakeMeasurer()),
			() => undefined
		)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		await controller.flush()
		controller.dispatch(controller.state.tr.insertText("B", 2), true)
		await controller.flush()
		controller.dispatch(controller.state.tr.insertText("Z", controller.state.doc.content.size - 1), true)
		await controller.flush()

		const bursts = s.ops.map(op => (op.family === "text" && op.kind === "setText" ? op.burst : undefined))

		expect(bursts[1]).toBe(bursts[0])
		expect(bursts[2]).not.toBe(bursts[1])
	})

	it("typing the worker has not received yet is pending until its setText is answered", async () => {
		const s = slowSession()
		const controller = new TextEditController(s.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)
		const heard: boolean[] = []

		controller.subscribe(() => heard.push(controller.pending))
		expect(controller.pending).toBe(false)
		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		expect(controller.pending).toBe(true)

		const sent = controller.flush()

		expect(controller.pending).toBe(true)
		await sent
		expect(controller.pending).toBe(false)
		expect(heard.at(-1)).toBe(false)
	})

	it("keys typed while a refused commit resyncs are kept on the worker's body", async () => {
		let refuse = true
		const s = slowSession()
		const api = {
			...s.api,
			command: (op: DeckOp): Promise<CommandResult> => {
				s.ops.push(op)

				if (refuse) {
					refuse = false

					return Promise.resolve({ ok: false, refusal: "malformed" })
				}

				return Promise.resolve({ ok: true, revision: 2, dirty: true })
			},
			textSeed: () => Promise.resolve(seedOf(plain("Title")))
		} as unknown as PresentationSessionApi
		const controller = new TextEditController(api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)

		const sent = controller.flush()

		controller.dispatch(controller.state.tr.insertText("Z", controller.state.doc.content.size - 1), true)
		await sent
		await tick()
		await controller.flush()

		expect(controller.state.doc.textContent).toBe("TitleZ")
		expect(textOf(s.ops.at(-1))).toBe("TitleZ")
	})

	it("reads a paragraph's direction from its level along the chain when it sets none itself", () => {
		const seed = seedOf(plain("שלום"))
		const controller = new TextEditController(
			slowSession().api,
			{ ...seed, resolved: [{ pPr: { rtl: true }, runs: [{}] }] },
			new MeasureCache(new FakeMeasurer()),
			() => undefined
		)

		expect(controller.rtl).toBe(true)
	})
})
