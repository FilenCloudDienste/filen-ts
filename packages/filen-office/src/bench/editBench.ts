import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CORPUS_DIR } from "../tests/corpusDir"
import {
	addComments,
	key,
	memory,
	openEditor,
	percentile,
	placeCaret,
	save,
	spreadPosition,
	typeBursts,
	type Burst,
	type KeyKind,
	type Tasks
} from "./editHarness"

// The editor's performance gate on node: open (time, retained heap, longest task), the first key, keys
// in page view and with paged layout suspended (what Mobile view leaves the core to do), memory per key and
// a save's longest task, on the 300-page fixture and Tariff, plain and under review (tracking on, 200
// comments, Markup view). Each case runs in its own process.
//
//   node --expose-gc --import tsx src/bench/editBench.ts [--case=<name>] [--json=<file>] [--head=<json of the base>]

const FILES = {
	"300p": join(import.meta.dirname, "..", "tests", "fixtures", "08-large-300p.docx"),
	tariff: join(CORPUS_DIR, "docx", "govuk__Tariff_of_the_United_Kingdom_v1.34.docx")
} as const

type FileName = keyof typeof FILES

interface Case {
	readonly file: FileName
	readonly review: boolean
}

export const CASES: Readonly<Record<string, Case>> = {
	"300p": { file: "300p", review: false },
	"300p-review": { file: "300p", review: true },
	tariff: { file: "tariff", review: false },
	"tariff-review": { file: "tariff", review: true }
}

const SPOTS = 20
const PER_SPOT = 15

interface Keys {
	readonly p50: number
	readonly p95: number
	readonly max: number
	// p95 in this thread's CPU time.
	readonly cpuP95: number
	readonly count: number
	readonly refused: number
}

function keys(burst: Burst): Keys {
	return {
		p50: percentile(burst.times, 0.5),
		p95: percentile(burst.times, 0.95),
		max: Math.max(0, ...burst.times),
		cpuP95: percentile(burst.cpu, 0.95),
		count: burst.times.length,
		refused: burst.refused
	}
}

export interface CaseResult {
	readonly name: string
	readonly blocks: number
	readonly pages: number
	readonly openMs: number
	readonly settledMs: number
	readonly openTasks: Tasks
	readonly openHeapMb: number
	readonly openArrayBuffersMb: number
	readonly commentsMs: number | undefined
	readonly firstSnapshotMs: number
	readonly firstKeyMs: number
	readonly type: Keys
	// Keys one turn apart (a key held down): the layout gets no gap.
	readonly held: Keys
	readonly backspace: Keys
	readonly enter: Keys
	readonly suspendedType: Keys
	readonly suspendedEnter: Keys
	readonly kbPerKey: number
	readonly saveMs: number
	readonly saveTasks: Tasks
	readonly saveBytes: number
}

async function burst(editor: Parameters<typeof typeBursts>[0], kind: KeyKind, offset: number, intervalMs = 100): Promise<Burst> {
	return kind === "type"
		? typeBursts(editor, SPOTS, PER_SPOT, ["type"], offset, intervalMs)
		: typeBursts(editor, SPOTS / 2, PER_SPOT, [kind], offset, intervalMs)
}

export async function runCase(name: string): Promise<CaseResult> {
	const spec = CASES[name]

	if (spec === undefined) throw new Error(`no case ${name}`)

	const bytes = new Uint8Array(readFileSync(FILES[spec.file]))
	const before = memory()
	const opened = await openEditor(bytes, spec.review ? { view: "markup" } : {})
	const open = memory()
	const editor = opened.editor
	let commentsMs: number | undefined

	if (spec.review) {
		editor.execute({ type: "review.track", on: true })

		const start = performance.now()
		const added = addComments(editor, 200)

		commentsMs = performance.now() - start

		if (added !== 200) throw new Error(`added ${String(added)} comments of 200`)

		await editor.whenSettled()
	}

	// The first key after opening (the click that places the caret not counted).
	placeCaret(editor, spreadPosition(editor.session.state, 5000))

	const firstKeyMs = key(editor, "type")?.ms ?? 0

	await editor.whenSettled()

	const typedFrom = memory()
	const type = await burst(editor, "type", 0)
	const typed = memory()
	const held = await burst(editor, "type", 500, 0)
	const backspace = await burst(editor, "backspace", 100)
	const enter = await burst(editor, "enter", 200)

	editor.suspend()

	const suspendedType = await burst(editor, "type", 300)
	const suspendedEnter = await burst(editor, "enter", 400)

	editor.resume()
	await editor.whenSettled()

	const saved = await save(opened.editing)
	const result: CaseResult = {
		name,
		blocks: editor.body.session.state.doc.childCount,
		pages: editor.layout.pages.length,
		openMs: opened.editorMs,
		settledMs: opened.settledMs,
		openTasks: opened.tasks,
		openHeapMb: open.heapMb - before.heapMb,
		openArrayBuffersMb: open.arrayBuffersMb - before.arrayBuffersMb,
		commentsMs,
		firstSnapshotMs: opened.firstSnapshotMs,
		firstKeyMs,
		type: keys(type),
		held: keys(held),
		backspace: keys(backspace),
		enter: keys(enter),
		suspendedType: keys(suspendedType),
		suspendedEnter: keys(suspendedEnter),
		kbPerKey: ((typed.heapMb - typedFrom.heapMb) * 1024) / Math.max(1, type.times.length),
		saveMs: saved.ms,
		saveTasks: saved.tasks,
		saveBytes: saved.written.bytes.length
	}

	opened.close()

	return result
}

function line(result: CaseResult): string {
	const k = (keys: Keys): string =>
		`${keys.p50.toFixed(2)}/${keys.p95.toFixed(2)}/${keys.max.toFixed(1)} (cpu p95 ${keys.cpuP95.toFixed(2)})`

	return (
		`${result.name.padEnd(14)} ${String(result.blocks)} blocks ${String(result.pages)} pages; open ${result.openMs.toFixed(0)} ms ` +
		`(settled ${result.settledMs.toFixed(0)}), heap +${result.openHeapMb.toFixed(1)} MB, longest task ${result.openTasks.maxMs.toFixed(0)} ms ` +
		`(${String(result.openTasks.over50)} > 50 ms; cpu ${result.openTasks.maxCpuMs.toFixed(0)} ms, ${String(result.openTasks.cpuOver50)} > 50)` +
		(result.commentsMs === undefined ? "" : `; 200 comments ${result.commentsMs.toFixed(0)} ms`) +
		`\n${"".padEnd(15)}first snapshot ${result.firstSnapshotMs.toFixed(1)} ms, first key ${result.firstKeyMs.toFixed(2)} ms; ` +
		`p50/p95/max type ${k(result.type)}, held ${k(result.held)}, backspace ${k(result.backspace)}, ` +
		`enter ${k(result.enter)}; suspended type ${k(result.suspendedType)}, enter ${k(result.suspendedEnter)}; ` +
		`${result.kbPerKey.toFixed(2)} KB/key; ` +
		`save ${result.saveMs.toFixed(0)} ms, longest task ${result.saveTasks.maxMs.toFixed(0)} ms (${String(result.saveTasks.over50)} > 50 ms; ` +
		`cpu ${result.saveTasks.maxCpuMs.toFixed(0)} ms)`
	)
}

// The gate's limits: what failed, against `head` (the same cases measured at the base commit) where relative.
export function gateFailures(results: readonly CaseResult[], head: readonly CaseResult[] = []): string[] {
	const failures: string[] = []
	const named = (name: string, from: readonly CaseResult[]): CaseResult | undefined => from.find(result => result.name === name)
	const check = (ok: boolean, what: string): void => {
		if (!ok) failures.push(what)
	}

	for (const result of results) {
		const base = named(result.name, head)

		check(result.saveTasks.maxMs <= 50, `${result.name}: save task ${result.saveTasks.maxMs.toFixed(0)} ms > 50`)

		if (result.name === "300p") check(result.type.p95 < 16, `300p: keystroke p95 ${result.type.p95.toFixed(2)} ms >= 16`)
		if (result.name === "tariff-review") {
			check(result.type.p95 <= 8, `tariff-review: page view keystroke p95 ${result.type.p95.toFixed(2)} ms > 8`)
			check(result.suspendedType.p95 <= 8, `tariff-review: suspended keystroke p95 ${result.suspendedType.p95.toFixed(2)} ms > 8`)
		}
		if (result.name.startsWith("tariff"))
			check(result.openTasks.maxMs < 80, `${result.name}: open task ${result.openTasks.maxMs.toFixed(0)} ms >= 80`)

		if (base === undefined) continue

		check(
			result.kbPerKey <= base.kbPerKey * 1.1,
			`${result.name}: ${result.kbPerKey.toFixed(2)} KB/key over HEAD's ${base.kbPerKey.toFixed(2)} + 10 %`
		)
		// Retained memory is exact to a few hundred KB from run to run.
		check(
			result.openHeapMb <= base.openHeapMb + 0.5,
			`${result.name}: open heap ${result.openHeapMb.toFixed(1)} MB over HEAD's ${base.openHeapMb.toFixed(1)} MB`
		)
	}

	return failures
}

const args = process.argv.slice(2)
const only = args.find(arg => arg.startsWith("--case="))?.slice(7)
const json = args.find(arg => arg.startsWith("--json="))?.slice(7)
const headJson = args.find(arg => arg.startsWith("--head="))?.slice(7)

if (import.meta.filename === process.argv[1]) {
	if (only !== undefined) {
		const result = await runCase(only)

		console.log(line(result))

		if (json !== undefined) writeFileSync(json, JSON.stringify(result))
	} else {
		const results: CaseResult[] = []
		let skipped = 0

		for (const name of Object.keys(CASES)) {
			if (!existsSync(FILES[CASES[name]?.file ?? "300p"])) {
				console.log(`${name}: fixture missing, skipped`)

				skipped++

				continue
			}

			const out = join(process.env["TMPDIR"] ?? "/tmp", `docx-edit-bench-${String(process.pid)}-${name}.json`)

			execFileSync(process.execPath, [...process.execArgv, import.meta.filename, `--case=${name}`, `--json=${out}`], {
				stdio: "inherit"
			})
			results.push(JSON.parse(readFileSync(out, "utf8")) as CaseResult)
			rmSync(out)
		}

		if (json !== undefined) writeFileSync(json, JSON.stringify(results, null, "\t"))

		const head = headJson === undefined ? [] : (JSON.parse(readFileSync(headJson, "utf8")) as CaseResult[])
		const failures = gateFailures(results, head)

		const skippedNote = skipped === 0 ? "" : ` (${String(skipped)} of ${String(Object.keys(CASES).length)} cases skipped)`

		if (failures.length === 0) {
			console.log(`Performance gate: within the limits${skippedNote}`)
		} else {
			console.log(`Performance gate failures${skippedNote}:\n  ${failures.join("\n  ")}`)

			process.exitCode = 1
		}
	}
}
