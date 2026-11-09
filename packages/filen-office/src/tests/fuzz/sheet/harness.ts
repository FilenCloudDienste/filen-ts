import { unzipSync } from "fflate"
import { bytesSource } from "../../../core/opc/index"
import { openXlsxSession } from "../../../core/sheet/commands"
import type { SheetFileKind, SheetSessionApi, SheetTile } from "../../../core/sheet/protocol"
import type { SheetSession } from "../../../core/sheet/session"
import type { XlsxDocument } from "../../../core/xlsx/edit/document"
import { cellKeyOf } from "../../../core/xlsx/edit/history"
import { decodeUtf8 } from "../../../core/xml/index"
import { rng } from "../config"
import { difference } from "../../xlsxWriteFixtures"
import { compareRecords, modelRecord, readSaved, type WorkbookRecord } from "./compare"
import { KNOWN_REFUSALS, OpPicker, type Outcome } from "./ops"

// One fuzz sequence: a session opened on a workbook takes random commands, in order and awaited one by one
// ("sync"), or in bursts sent without waiting and interleaved with tile requests, copies and saves ("race").
// At every checkpoint the session saves; the save must pass its gate, and the save read back without the engine
// must equal the session's model (compare.ts). Every answer must be a change or a typed refusal: anything that
// throws, rejects or does not answer in time is a finding.

// Runs everything at once: no yielding (the in-thread host's slicing, with an endless slice).
const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }

export type FuzzMode = "sync" | "race"

export interface SequenceOptions {
	readonly steps: number
	// A checkpoint after every this many steps (and at the end).
	readonly checkEvery: number
	readonly families?: readonly string[]
	readonly ops?: readonly string[]
	// Per call; a call that takes longer is a hang.
	readonly callTimeoutMs: number
	// Undo everything at the end and check the save gives the source's parts back.
	readonly undoAll: boolean
	// Compare what a fresh session on the save shows with what the editing session shows.
	readonly reopen: boolean
	// Edits at the grid's last rows and columns too.
	readonly edges: boolean
	// Formulas whose result is a range where one value is expected.
	readonly ranges: boolean
	// Each call as it starts (replaying a finding).
	readonly trace?: (call: string) => void
	// Each checkpoint's save (keeping a finding's file).
	readonly keep?: (bytes: Uint8Array) => void
}

export const DEFAULT_SEQUENCE: SequenceOptions = {
	steps: 16,
	checkEvery: 6,
	callTimeoutMs: 60_000,
	undoAll: true,
	reopen: true,
	edges: true,
	ranges: true
}

export interface SequenceResult {
	readonly name: string
	readonly seed: number
	readonly mode: FuzzMode
	// Why nothing was fuzzed (an open failure, a view-only verdict): expected, not a finding.
	skipped?: string
	applied: number
	steps: number
	checks: number
	refusals: Record<string, number>
	// Findings.
	diverge?: string[]
	saveFail?: string
	untypedRefusal?: string
	crash?: string
	hang?: string
	undoAll?: string[]
	reopen?: string[]
	ops: string[]
	ms: number
}

export function isFinding(result: SequenceResult): boolean {
	return (
		result.diverge !== undefined ||
		result.saveFail !== undefined ||
		result.untypedRefusal !== undefined ||
		result.crash !== undefined ||
		result.hang !== undefined ||
		result.undoAll !== undefined ||
		result.reopen !== undefined
	)
}

class Hang extends Error {}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined

	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Hang(`${what} did not answer in ${ms} ms`)), ms)
		})
	]).finally(() => clearTimeout(timer))
}

function errorText(error: unknown): string {
	return (error instanceof Error ? (error.stack ?? error.message) : String(error)).slice(0, 1500)
}

function equal(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
	if (a === undefined || b === undefined || a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false

	return true
}

// The cells a tile shows, as "row,col" → text and input.
function tileCells(tile: SheetTile): Map<string, string> {
	const out = new Map<string, string>()

	for (let i = 0; i < tile.count; i++) {
		const position = tile.positions[i] ?? 0
		const row = tile.tileRow * 64 + (position >> 5)
		const col = tile.tileCol * 32 + (position & 31)
		const text = tile.texts[i] ?? -1
		const input = tile.inputs[i] ?? -1

		out.set(`${row},${col}`, `${text < 0 ? "" : tile.strings[text]}|${input < 0 ? "" : tile.strings[input]}`)
	}

	return out
}

async function shownTiles(session: SheetSessionApi, sheet: number, coordinates: Uint32Array): Promise<Map<string, string>> {
	const { tiles } = await session.tiles(sheet, coordinates)
	const out = new Map<string, string>()

	for (const tile of tiles) for (const [key, value] of tileCells(tile)) out.set(key, value)

	return out
}

export async function runSequence(
	bytes: Uint8Array,
	kind: SheetFileKind,
	name: string,
	seed: number,
	mode: FuzzMode,
	options: SequenceOptions = DEFAULT_SEQUENCE
): Promise<SequenceResult> {
	const started = performance.now()
	const rand = rng(seed)
	const picker = new OpPicker(options.families, options.ops)
	const result: SequenceResult = { name, seed, mode, applied: 0, steps: 0, checks: 0, refusals: {}, ops: [], ms: 0 }
	let session: SheetSession<XlsxDocument> | undefined

	const tally = (outcome: Outcome, op: string): void => {
		if (outcome.kind === "applied") result.applied++
		else if (outcome.kind === "refused") {
			const reason = outcome.refusal.reason

			if (!KNOWN_REFUSALS.has(reason)) result.untypedRefusal ??= `${op}: ${JSON.stringify(outcome.refusal)}`

			const key = `${op}:${reason}${outcome.refusal.detail === undefined ? "" : `(${outcome.refusal.detail})`}`

			result.refusals[key] = (result.refusals[key] ?? 0) + 1
		}
	}

	try {
		const opened = await within(
			// Notes and comments are written under an author.
			openXlsxSession(
				bytesSource(bytes.slice()),
				{ kind, slicing: IMMEDIATE, settings: { author: "Fuzz", clock: () => 0 } },
				() => undefined
			),
			options.callTimeoutMs,
			"open"
		)

		if (opened.kind !== "opened") {
			result.skipped = `open ${opened.kind === "failed" ? opened.reason : "aborted"}`

			return result
		}

		session = opened.session

		const live = session
		const verdict = await within(live.intent(), options.callTimeoutMs, "intent")

		if (verdict.state !== "writable") {
			result.skipped = `view-only (${verdict.state === "viewOnly" ? verdict.reason : verdict.state})`

			return result
		}

		await within(live.document.readyAllSheets(IMMEDIATE), options.callTimeoutMs, "load")

		const held = new Set<number>()
		const hold = async (sheet: number): Promise<void> => {
			held.add(sheet)
			await live.tiles(sheet, Uint32Array.of(0, 0, 1, 0, 0, 1))
		}

		for (const entry of live.document.worksheets()) await hold(entry.id)

		const checkpoint = async (): Promise<boolean> => {
			result.checks++
			options.trace?.("checkpoint")

			const saved = await within(live.save(), options.callTimeoutMs, "save")

			if (!saved.ok) {
				result.saveFail = `${saved.reason}: ${saved.message.slice(0, 1000)} after ${result.ops.join(" ")}`

				return false
			}

			options.keep?.(saved.bytes)
			options.trace?.("compare")

			const differences = compareRecords(modelRecord(live.document.workbook), await readSaved(saved.bytes, bytes))

			if (differences.length > 0) {
				result.diverge = [...differences.slice(0, 12), `after ${result.ops.join(" ")}`]

				return false
			}

			if (options.reopen) {
				options.trace?.("reopen")

				const problems = await reopenProblems(live, saved.bytes, kind, options.callTimeoutMs)

				if (problems.length > 0) {
					result.reopen = [...problems, `after ${result.ops.join(" ")}`]

					return false
				}
			}

			return true
		}

		let checked = 0

		for (let step = 0; step < options.steps;) {
			const burst = mode === "sync" ? 1 : Math.min(options.steps - step, 1 + Math.floor(rand() * 5))
			const calls: Promise<void>[] = []

			for (let i = 0; i < burst; i++, step++) {
				const op = picker.pick(rand)
				const call = op.plan({ session: live, rand, edges: options.edges, ranges: options.ranges })

				result.steps++

				if (call === null) continue

				result.ops.push(op.name)
				options.trace?.(op.name)

				const running = within(call(), options.callTimeoutMs, op.name).then(outcome => tally(outcome, op.name))

				if (mode === "sync") await running
				else {
					calls.push(running)

					// What a client does meanwhile: asks for tiles, copies, sometimes saves.
					const roll = rand()
					const sheets = live.document.worksheets()
					const sheet = sheets[Math.floor(rand() * sheets.length)]?.id ?? 0

					if (roll < 0.3)
						calls.push(within(live.tiles(sheet, Uint32Array.of(0, 0)), options.callTimeoutMs, "tiles").then(() => undefined))
					else if (roll < 0.4)
						calls.push(
							within(live.save(), options.callTimeoutMs, "save").then(saved => {
								if (!saved.ok) result.saveFail ??= `mid-burst ${saved.reason}: ${saved.message.slice(0, 600)}`
							})
						)
					else if (roll < 0.5)
						calls.push(
							within(live.query("cell", { sheet, row: 0, col: 0 }), options.callTimeoutMs, "cell").then(() => undefined)
						)
				}
			}

			if (calls.length > 0) await Promise.all(calls)
			if (result.saveFail !== undefined) return result
			if (step - checked >= options.checkEvery || step >= options.steps) {
				checked = step

				if (!(await checkpoint())) return result
			}
		}

		if (options.undoAll) {
			for (let guard = 0; guard < 200; guard++) {
				const undone = await within(live.undo(), options.callTimeoutMs, "undo")

				if (!undone.ok || !undone.change.state.canUndo) break
			}

			if (!(await checkpoint())) return result

			const saved = await within(live.save(), options.callTimeoutMs, "save")

			if (saved.ok) {
				const problems = await undoneProblems(bytes, saved.bytes)

				if (problems.length > 0) result.undoAll = [...problems, `after ${result.ops.join(" ")}`]
			}
		}
	} catch (error) {
		if (error instanceof Hang) result.hang = `${error.message} after ${result.ops.join(" ")}`
		else result.crash = `${errorText(error)} after ${result.ops.join(" ")}`
	} finally {
		session?.close()
		result.ms = Math.round(performance.now() - started)
	}

	return result
}

// Parts an undone session may still have changed: records are append-only (styles, shared strings), and the
// calculation chain goes with its relationship and content type once a formula changed.
const APPEND_ONLY = /^xl\/(styles|sharedStrings|calcChain)\.xml$|^\[Content_Types\]\.xml$|^xl\/_rels\/workbook\.xml\.rels$/

// After every edit is undone: what the save holds equals the source (cells, rows, columns, merges, sheets, names),
// and every part but the append-only ones keeps its bytes, or differs in its text only where shown.
// Worksheet parts are compared by what they hold: a rewritten row loses source cells that hold nothing (no value, no
// style, no formula: `<c r="F5"/>`), and a dimension that did not cover the cells is widened.
async function undoneProblems(source: Uint8Array, saved: Uint8Array): Promise<string[]> {
	const problems = compareRecords(normalized(await readSaved(source)), normalized(await readSaved(saved, source)))
	const after = unzipSync(saved)
	const original = unzipSync(source)

	for (const part of new Set([...Object.keys(original), ...Object.keys(after)])) {
		if (APPEND_ONLY.test(part) || WORKSHEET.test(part) || equal(original[part], after[part])) continue

		const left = original[part] === undefined ? "" : decodeUtf8(original[part])
		const right = after[part] === undefined ? "" : decodeUtf8(after[part])
		const change = difference(left, right)

		problems.push(
			`${part}: ${JSON.stringify(left.slice(change.from, change.to).slice(0, 200))} → ${JSON.stringify(change.inserted.slice(0, 200))}`
		)
	}

	return problems
}

const WORKSHEET = /^xl\/worksheets\/[^/]+\.xml$/

// Without the style tables (append-only) and without cells that hold nothing.
function normalized(record: WorkbookRecord): WorkbookRecord {
	return {
		...record,
		sheets: record.sheets.map(sheet =>
			sheet.cells === undefined
				? sheet
				: {
						...sheet,
						cells: new Map(
							[...sheet.cells].filter(
								([, cell]) => cell.value !== undefined || cell.style !== 0 || cell.formula !== undefined
							)
						)
					}
		),
		xfs: [],
		fonts: [],
		numFmts: new Map()
	}
}

// What a fresh session on the save shows equals what the editing session shows, over the tiles held.
async function reopenProblems(
	live: SheetSession<XlsxDocument>,
	bytes: Uint8Array,
	kind: SheetFileKind,
	timeoutMs: number
): Promise<string[]> {
	const opened = await within(
		openXlsxSession(bytesSource(bytes), { kind, slicing: IMMEDIATE }, () => undefined),
		timeoutMs,
		"reopen"
	)

	if (opened.kind !== "opened") return [`the save does not open: ${opened.kind === "failed" ? opened.reason : "aborted"}`]

	const fresh = opened.session
	const problems: string[] = []

	try {
		await fresh.document.readyAllSheets(IMMEDIATE)

		// Results the file keeps none of are calculated once the session is quiet or set out to edit: on intent here.
		if ((await within(fresh.intent(), timeoutMs, "reopen intent")).state === "writable")
			await within(fresh.layout(fresh.document.activeSheet()), timeoutMs, "reopen engine")

		const coordinates = Uint32Array.of(0, 0, 1, 0, 0, 1)
		const freshSheets = fresh.document.worksheets()

		for (const entry of live.document.worksheets()) {
			const other = freshSheets.find(candidate => candidate.name === entry.name)

			if (other === undefined) {
				problems.push(`sheet ${entry.name} missing`)
				continue
			}

			const shown = await shownTiles(live, entry.id, coordinates)
			const again = await shownTiles(fresh, other.id, coordinates)

			// A result the fresh session calculated again on open (the save asks for a full calculation, as it does
			// once the editing session kept a result it could not calculate) is the engine's from the file, which may
			// differ from what the editing session kept.
			const recalculated = (key: string): boolean => {
				const [row = 0, col = 0] = key.split(",").map(Number)

				return fresh.document.shownResults.get(other.id)?.get(cellKeyOf(row, col))?.recalculated === true
			}

			for (const key of new Set([...shown.keys(), ...again.keys()])) {
				const left = shown.get(key) ?? "|"
				const right = again.get(key) ?? "|"

				if (left !== right && !recalculated(key) && problems.length < 8)
					problems.push(`${entry.name} ${key}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`)
			}
		}
	} finally {
		fresh.close()
	}

	return problems
}
