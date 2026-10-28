import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { AllSelection, TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { DocxDocBuilder, DocxEditorSession, docxSchema } from "@filen/office/core/docx/edit"
import { key, openEditor, percentile as share, placeCaret, spreadPosition, typeBursts } from "../bench/editHarness"
import { CORPUS_DIR } from "./corpusDir"
import { openBytes } from "./docxEditFixtures"
import { liveHeap } from "./liveHeap"
import { budget, cpuMs } from "./timing"

const FIXTURE = join(import.meta.dirname, "fixtures", "08-large-300p.docx")
const TARIFF = join(CORPUS_DIR, "docx", "govuk__Tariff_of_the_United_Kingdom_v1.34.docx")

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

const MiB = 1024 * 1024
// What each holds, with room for the reading's noise and little else: the 300-page story 7.9 MB, its open editor
// 20–21 MB (its turns vary the reading by about 1 MB), the Tariff story 122.9 MB.
const BUILD_HEAP_MB = 9
const EDITOR_HEAP_MB = 23
const TARIFF_HEAP_MB = 135

// The live heap (liveHeap.ts) a piece of work leaves held while `hold` keeps its result reachable. Measured after the
// timed runs and twice: the forced collections flush the engine's aged bytecode, which the first run recompiles (code
// the heap would count, and CPU the timed runs would be billed), so only the second reads what the result holds.
async function heldMb<T>(work: () => Promise<T> | T, hold: (result: T) => unknown): Promise<number> {
	await heldOnce(work, hold)

	return heldOnce(work, hold)
}

// A call of its own, so that its result is unreachable once it returns (a loop's binding in an async function lives on
// in its context until the next iteration overwrites it, past the next run's first reading).
async function heldOnce<T>(work: () => Promise<T> | T, hold: (result: T) => unknown): Promise<number> {
	const before = await liveHeap()
	const result = await work()
	const held = ((await liveHeap()) - before) / MiB

	expect(hold(result)).toBeTruthy()

	return held
}

async function measureBuild(
	path: string
): Promise<{ session: DocxEditorSession; buildMs: number; sessionMs: number; heap: number; blocks: number }> {
	const opened = await openBytes(new Uint8Array(readFileSync(path)))
	const body = opened.model.body

	if (body === undefined) throw new Error("no body")

	const start = cpuMs()
	const story = new DocxDocBuilder(opened.context).build(body)
	const buildMs = cpuMs() - start
	const sessionStart = cpuMs()
	const session = new DocxEditorSession(opened.context)
	const sessionMs = cpuMs() - sessionStart
	// The built story: the document the session edits, over the open package the heap already held.
	const heap = await heldMb(
		() => new DocxDocBuilder(opened.context).build(body),
		built => built.doc.childCount
	)

	return { session, buildMs, sessionMs, heap, blocks: story.doc.childCount }
}

// Keystrokes at positions spread over the document: insert a character as a view would (a text
// selection, insertText through dispatch), the state's invariant plugins, history and snapshot included.
function keystrokes(session: DocxEditorSession, count: number, key: "type" | "backspace" | "enter" = "type"): number[] {
	const times: number[] = []

	for (let k = 0; k < count; k++) {
		const state = session.state
		// A position inside some text, spread over the document.
		let target = Math.floor((((k * 7919) % 10007) / 10007) * state.doc.content.size)
		let $pos = state.doc.resolve(target)

		while (!$pos.parent.inlineContent && target < state.doc.content.size) $pos = state.doc.resolve(++target)

		const start = cpuMs()
		const tr = state.tr.setSelection(TextSelection.create(state.doc, target))

		if (key === "type") tr.insertText("a")
		else if (key === "enter") tr.split(target)
		else if ($pos.parentOffset > 0) tr.delete(target - 1, target)
		else tr.insertText("a")

		const applied = session.dispatch(tr)

		session.snapshot()
		times.push(cpuMs() - start)

		if (!applied) throw new Error(`keystroke at ${target} refused`)
	}

	return times.sort((a, b) => a - b)
}

describe("docx editing performance", () => {
	it("builds the 300-page fixture and types into it under a frame per keystroke", { timeout: 120_000 }, async ({ task }) => {
		const { session, buildMs, sessionMs, heap, blocks } = await measureBuild(FIXTURE)

		keystrokes(session, 50)

		const times = keystrokes(session, 300)
		const p50 = percentile(times, 0.5)
		const p95 = percentile(times, 0.95)
		const backspace = keystrokes(session, 200, "backspace")
		const enter = keystrokes(session, 200, "enter")

		session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))

		const boldStart = cpuMs()

		session.execute({ type: "format.bold" })
		session.snapshot()

		const boldMs = cpuMs() - boldStart

		console.log(
			`300p: ${blocks} blocks, build ${buildMs.toFixed(1)} ms, session (build + proof) ${sessionMs.toFixed(1)} ms, heap ${heap.toFixed(1)} MB; ` +
				`keystroke p50 ${p50.toFixed(2)} ms p95 ${p95.toFixed(2)} ms max ${(times[times.length - 1] ?? 0).toFixed(2)} ms; ` +
				`backspace p95 ${percentile(backspace, 0.95).toFixed(2)} ms, enter p95 ${percentile(enter, 0.95).toFixed(2)} ms; select-all bold ${boldMs.toFixed(1)} ms`
		)
		Object.assign(task.meta, { perf: { docxBuildHeapMB: { value: heap, budget: BUILD_HEAP_MB } } })
		expect(session.state.doc.type).toBe(docxSchema.nodes.doc)
		expect(heap).toBeLessThanOrEqual(BUILD_HEAP_MB)
		// The target is 16 ms of CPU time; the bound leaves room for noise.
		expect(p95).toBeLessThan(budget(48))
		expect(percentile(enter, 0.95)).toBeLessThan(budget(48))
		expect(percentile(backspace, 0.95)).toBeLessThan(budget(48))
	})

	// As the web edits: the in-thread editing host (sliced open with the writer's proof), the pages in view laid
	// out in the key's task, the toolbar's snapshot read after each key.
	it(
		"opens the 300-page fixture for editing and types into it in page view under a frame per keystroke",
		{ timeout: 120_000 },
		async ({ task }) => {
			const bytes = new Uint8Array(readFileSync(FIXTURE))
			const opened = await openEditor(bytes)
			const editor = opened.editor

			placeCaret(editor, spreadPosition(editor.session.state, 5000))

			const first = key(editor, "type")?.ms ?? 0
			const typed = await typeBursts(editor, 10, 20, ["type"], 0, 0)
			const enter = await typeBursts(editor, 5, 10, ["enter"], 50, 0)
			const p95 = share(typed.cpu, 0.95)

			console.log(
				`300p page view: open ${opened.editorMs.toFixed(0)} ms, longest open task ${opened.tasks.maxMs.toFixed(0)} ms; ` +
					`first key ${first.toFixed(2)} ms; keystroke p50 ${share(typed.times, 0.5).toFixed(2)} ms p95 ${p95.toFixed(2)} ms; enter p95 ${share(enter.times, 0.95).toFixed(2)} ms`
			)
			opened.close()

			// What the open editor holds (the session, the laid-out pages in view), the bytes of the file aside.
			const heap = await heldMb(
				() => openEditor(bytes),
				open => {
					open.close()

					return true
				}
			)

			console.log(`300p page view: open editor holds ${heap.toFixed(1)} MB`)
			Object.assign(task.meta, { perf: { docxEditorOpenHeapMB: { value: heap, budget: EDITOR_HEAP_MB } } })
			expect(typed.refused).toBe(0)
			expect(heap).toBeLessThanOrEqual(EDITOR_HEAP_MB)
			// The target is 16 ms (src/bench/editBench.ts measures the gate); the bound leaves room for loaded CI machines.
			expect(p95).toBeLessThan(budget(48))
		}
	)

	it.skipIf(!existsSync(TARIFF))("builds the Tariff document", { timeout: 300_000 }, async ({ task }) => {
		const { session, buildMs, sessionMs, heap, blocks } = await measureBuild(TARIFF)
		const times = keystrokes(session, 100)
		const all = (): void => {
			session.dispatch(session.state.tr.setSelection(new AllSelection(session.state.doc)))
		}
		let start = cpuMs()

		all()
		session.snapshot()

		const cold = cpuMs() - start

		session.dispatch(session.state.tr.insertText("z", session.state.doc.content.size - 3))
		start = cpuMs()
		session.snapshot()

		const warm = cpuMs() - start
		// Shift+arrow over half the document, a snapshot per step.
		const half = Math.floor(session.state.doc.content.size / 2)
		const arrows: number[] = []

		for (let k = 0; k < 20; k++) {
			const state = session.state
			const step = cpuMs()

			session.dispatch(state.tr.setSelection(TextSelection.between(state.doc.resolve(1), state.doc.resolve(half + k))))
			session.snapshot()
			arrows.push(cpuMs() - step)
		}

		arrows.sort((a, b) => a - b)

		console.log(
			`Tariff: ${blocks} blocks, build ${buildMs.toFixed(0)} ms, session ${sessionMs.toFixed(0)} ms, heap ${heap.toFixed(1)} MB; ` +
				`keystroke p50 ${percentile(times, 0.5).toFixed(2)} ms p95 ${percentile(times, 0.95).toFixed(2)} ms; ` +
				`select-all snapshot cold ${cold.toFixed(0)} ms, after an edit ${warm.toFixed(1)} ms; shift+arrow over half p50 ${percentile(arrows, 0.5).toFixed(2)} ms`
		)
		Object.assign(task.meta, { perf: { docxTariffBuildHeapMB: { value: heap, budget: TARIFF_HEAP_MB } } })
		expect(blocks).toBeGreaterThan(0)
		expect(heap).toBeLessThanOrEqual(TARIFF_HEAP_MB)
		expect(warm).toBeLessThan(budget(150))
		expect(percentile(arrows, 0.5)).toBeLessThan(budget(15))
	})
})
