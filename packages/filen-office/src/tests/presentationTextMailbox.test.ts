import { afterEach, describe, expect, it, vi } from "vitest"
import { rgba } from "../core/drawingml/index"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { TextMailbox, writeTextMailbox, type TextMailboxTicket } from "../dom/presentation/textMailbox"
import { LAYOUT_STALL_MS, MAILBOX_SPIN_MS, MAX_MAILBOX_FRAMES, TextEditController } from "../react/presentation/edit/text/controller"
import { cpuMs } from "./timing"
import { FakeMeasurer, testFont } from "./textFixtures"

// The layoutText answer through shared memory: written by the worker, read back equal (typed arrays copied out, never
// views of shared memory), refused into the posted path when it does not fit, and painted by the editor in the frame
// it arrives before, ahead of the posted answer.

const SHAPE: ShapeRef = { slide: slideRef(3), id: 2 }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function plain(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: { sz: 1800 } }] }] }
}

function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 400, height: 300 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result), revision: 4 }
}

function seedOf(body: TextBody): TextSeed {
	const { page, layout } = laid(body)

	return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], page, layout, matrix: [1, 0, 0, 1, 0, 0] }
}

const scope = globalThis as { crossOriginIsolated?: boolean; requestAnimationFrame?: (callback: () => void) => number }

afterEach(() => {
	delete scope.crossOriginIsolated
	delete scope.requestAnimationFrame
})

describe("presentation text mailbox", () => {
	it("reads back what the worker wrote, with typed arrays copied out of shared memory", () => {
		const mailbox = TextMailbox.create({ crossOriginIsolated: true }) as TextMailbox
		const ticket = mailbox.ticket()
		const value = laid(plain("Hello mailbox ✓ \u{1F600}"))

		expect(mailbox.take(ticket.id)).toBeUndefined()
		expect(writeTextMailbox(ticket, value)).toBe(true)

		const taken = mailbox.take(ticket.id)

		expect(taken).not.toBe("posted")

		const read = (taken as { value: typeof value }).value

		expect(read).toEqual(structuredClone(value))
		expect(read.page.page.lineInts.buffer instanceof SharedArrayBuffer).toBe(false)
	})

	it("sends the page to the posted answer when the value does not fit, and makes no mailbox outside isolation", () => {
		const small = TextMailbox.create({ crossOriginIsolated: true }, 256) as TextMailbox
		const ticket = small.ticket()

		expect(writeTextMailbox(ticket, laid(plain("x".repeat(400))))).toBe(false)
		expect(small.take(ticket.id)).toBe("posted")
		expect(TextMailbox.create({})).toBeUndefined()
	})

	it("the editor paints a layout from the mailbox in the frame, before the posted answer", () => {
		const frames: (() => void)[] = []

		scope.crossOriginIsolated = true
		scope.requestAnimationFrame = callback => frames.push(callback)

		const session = {
			// The worker wrote the mailbox; its posted answer has not arrived.
			layoutText: (_shape: ShapeRef, body: TextBody, _caret: number, ticket: TextMailboxTicket) => {
				writeTextMailbox(ticket, laid(body))

				return new Promise(() => undefined)
			}
		} as unknown as PresentationSessionApi
		const controller = new TextEditController(session, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		expect(controller.page.page.sourceTexts).toEqual(["Title"])

		for (const frame of frames.splice(0)) frame()

		expect(controller.page.page.sourceTexts).toEqual(["ATitle"])
		expect(controller.mapDoc).toBe(controller.state.doc)
	})

	it("stops reading the mailbox after a bounded number of frames, and reports a layout that never answers", async () => {
		vi.useFakeTimers()

		try {
			const frames: (() => void)[] = []
			const refusals: string[] = []

			scope.crossOriginIsolated = true
			scope.requestAnimationFrame = callback => frames.push(callback)

			// A worker that died mid-layout: no mailbox write, no posted answer.
			const session = {
				layoutText: () => new Promise(() => undefined),
				command: () => new Promise(() => undefined)
			} as unknown as PresentationSessionApi
			const controller = new TextEditController(session, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), reason =>
				refusals.push(reason)
			)

			controller.dispatch(controller.state.tr.insertText("A", 1), true)

			let ran = 0

			while (frames.length > 0 && ran < 10 * MAX_MAILBOX_FRAMES) {
				ran++
				frames.shift()?.()
			}

			expect(ran).toBe(MAX_MAILBOX_FRAMES)
			await vi.advanceTimersByTimeAsync(LAYOUT_STALL_MS + 10)
			expect(refusals).toEqual(["failed"])
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops reading the mailbox once the session is closed", () => {
		const frames: (() => void)[] = []

		scope.crossOriginIsolated = true
		scope.requestAnimationFrame = callback => frames.push(callback)

		const session = { closed: false, layoutText: () => new Promise(() => undefined), command: () => new Promise(() => undefined) }
		const controller = new TextEditController(
			session as unknown as PresentationSessionApi,
			seedOf(plain("Title")),
			new MeasureCache(new FakeMeasurer()),
			() => undefined
		)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		session.closed = true
		frames.shift()?.()
		expect(frames).toHaveLength(0)
	})

	it("waits at most a few milliseconds in the first frame for an answer the worker is about to write", () => {
		const frames: (() => void)[] = []

		scope.crossOriginIsolated = true
		scope.requestAnimationFrame = callback => frames.push(callback)

		const session = {
			layoutText: () => new Promise(() => undefined),
			command: () => new Promise(() => undefined)
		} as unknown as PresentationSessionApi
		const controller = new TextEditController(session, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)

		const start = cpuMs()
		const wallStart = performance.now()

		frames.shift()?.()

		const waited = performance.now() - wallStart
		const spent = cpuMs() - start

		// The worker never writes: the first frame gives up after the spin, and the next frame reads again. The spin
		// is timed on the wall clock, which a descheduled process still advances, so that is what bounds it from
		// below; only CPU time is free of a busy runner's stalls, so that is what bounds it from above.
		expect(waited).toBeGreaterThanOrEqual(MAILBOX_SPIN_MS * 0.5)
		expect(spent).toBeLessThan(MAILBOX_SPIN_MS + 4)
		expect(frames).toHaveLength(1)
	})
})
