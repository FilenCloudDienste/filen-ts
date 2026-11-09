import { readFileSync } from "node:fs"
import { getHeapSpaceStatistics } from "node:v8"
import { bytesSource } from "@filen/office/core/opc"
import { openXlsxSession } from "../core/sheet/commands"
import type { SheetCommand, SheetCommandResult, SheetId } from "../core/sheet/protocol"
import type { SheetSession } from "../core/sheet/session"
import type { XlsxDocument } from "../core/xlsx/edit/document"

// A long editing session on one workbook (the spreadsheet engine's soak test): keystroke commits spread over the
// sheet, formats, rows inserted and deleted, columns resized, pastes, undo/redo bursts, and a save every
// `saveEvery` operations (as idle autosave would). After each save: memory after a full collection, the save's CPU,
// the weight the undo history claims, and the keys' p95 since the last save. The budgets: memory in proportion to
// the content (no growth beyond what the history holds), history within its byte budget, save cost in proportion to
// the edits, key p95 drift at most 20 %.
//   node --expose-gc --import tsx src/bench/sheetSoak.ts <workbook.xlsx> [--ops=5000] [--save-every=250] [--json]
// Memory counts the session's data: V8's compiled-code spaces are taken out (they say which code ran).

const gc = (globalThis as { gc?: () => void }).gc

if (gc === undefined) throw new Error("run with --expose-gc")

const MB = 1024 * 1024
const args = process.argv.slice(2)
const file = args.find(arg => !arg.startsWith("--"))

if (file === undefined) throw new Error("usage: sheetSoak.ts <workbook.xlsx> [--ops=5000] [--save-every=250] [--json]")

const option = (name: string, fallback: string): string =>
	args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const OPS = Number(option("ops", "5000"))
const SAVE_EVERY = Number(option("save-every", "250"))
const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }

// mulberry32: the same session every run.
function rng(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let t = state

		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function dataMb(): number {
	gc?.()
	gc?.()

	const code = getHeapSpaceStatistics()
		.filter(space => /code|trusted/.test(space.space_name))
		.reduce((sum, space) => sum + space.space_used_size, 0)
	const usage = process.memoryUsage()

	return (usage.heapUsed + usage.external - code) / MB
}

function cpuMs(since: NodeJS.CpuUsage): number {
	const used = process.threadCpuUsage(since)

	return (used.user + used.system) / 1000
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, z) => a - z)

	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

function round(value: number, digits = 2): number {
	const scale = 10 ** digits

	return Math.round(value * scale) / scale
}

// What the session's undo history claims to hold (its own estimate), read for the report only.
function historyBytes(session: SheetSession<XlsxDocument>): number {
	return (session as unknown as { readonly history: { readonly weight: number } }).history.weight
}

interface Checkpoint {
	readonly ops: number
	readonly dataMb: number
	readonly historyMb: number
	readonly saveCpuMs: number
	readonly saveBytes: number
	readonly keyP95Ms: number
}

const bytes = new Uint8Array(readFileSync(file))
const opened = await openXlsxSession(bytesSource(bytes), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

if (opened.kind !== "opened") throw new Error(`open: ${opened.kind}`)

const { session, info } = opened

if ((await session.intent()).state !== "writable") throw new Error("the workbook is view-only")

await session.document.readyAllSheets(IMMEDIATE)

const sheet: SheetId = info.activeSheet
const rows = Math.max(1, info.activeLayout.rowCount)
const cols = Math.max(1, Math.min(info.activeLayout.colCount, 30))
const rand = rng(7)
const int = (to: number): number => Math.floor(rand() * to)
const baseline = dataMb()
const checkpoints: Checkpoint[] = []
const refusals: Record<string, number> = {}
let keys: number[] = []
let spot = { row: int(rows), col: int(cols) }

const run = async (command: SheetCommand): Promise<SheetCommandResult> => {
	const result = await session.command(command)

	if (!result.ok) refusals[`${command.type}:${result.refusal.reason}`] = (refusals[`${command.type}:${result.refusal.reason}`] ?? 0) + 1

	return result
}

for (let op = 1; op <= OPS; op++) {
	const roll = rand()

	if (op % 25 === 0) spot = { row: int(rows), col: int(cols) }

	if (roll < 0.8) {
		const cpu = process.threadCpuUsage()

		await run({
			type: "cells.set",
			sheet,
			cells: {
				rows: Uint32Array.of(spot.row + int(5)),
				cols: Uint16Array.of(spot.col),
				inputs: [rand() < 0.2 ? `=A${spot.row + 1}*2` : String(int(100_000))]
			}
		})
		keys.push(cpuMs(cpu))
	} else if (roll < 0.86) {
		await run({
			type: "format.apply",
			sheet,
			ranges: [{ startRow: spot.row, startCol: spot.col, endRow: spot.row + int(20), endCol: spot.col + int(3) }],
			patch: rand() < 0.5 ? { bold: rand() < 0.5 } : { fill: int(0xffffff) }
		})
	} else if (roll < 0.89) {
		const insert = rand() < 0.5
		const move = { sheet, axis: "rows", at: spot.row, count: 1 + int(2) } as const

		await run(insert ? { type: "axis.insert", ...move } : { type: "axis.delete", ...move })
	} else if (roll < 0.91) {
		await run({ type: "axis.resize", sheet, axis: "cols", indices: Uint32Array.of(spot.col), sizes: Float32Array.of(40 + int(200)) })
	} else if (roll < 0.94) {
		const copied = await session.query("copy", {
			sheet,
			range: { startRow: spot.row, startCol: 0, endRow: spot.row + int(30), endCol: Math.min(cols - 1, 3) },
			cut: false
		})

		if (!("refused" in copied))
			await run({ type: "clipboard.paste", sheet, at: { row: int(rows), col: int(cols) }, text: copied.text, clip: copied.clip })
	} else {
		const burst = 1 + int(5)

		for (let i = 0; i < burst; i++) await session.undo()
		for (let i = 0; i < int(burst + 1); i++) await session.redo()
	}

	if (op % SAVE_EVERY === 0) {
		const cpu = process.threadCpuUsage()
		const saved = await session.save()
		const saveCpu = cpuMs(cpu)

		if (!saved.ok) throw new Error(`save at ${op}: ${saved.reason} ${saved.message}`)

		await session.markSaved(saved.version)
		checkpoints.push({
			ops: op,
			dataMb: round(dataMb() - baseline, 1),
			historyMb: round(historyBytes(session) / MB, 1),
			saveCpuMs: round(saveCpu, 1),
			saveBytes: saved.bytes.byteLength,
			keyP95Ms: round(percentile(keys, 95), 3)
		})
		keys = []

		if (!args.includes("--json")) console.log(JSON.stringify(checkpoints.at(-1)))
	}
}

const first = checkpoints[0]
const last = checkpoints.at(-1)
const summary = {
	file,
	ops: OPS,
	saveEvery: SAVE_EVERY,
	refusals,
	checkpoints: checkpoints.length,
	keyP95DriftPct:
		first === undefined || last === undefined || first.keyP95Ms === 0
			? 0
			: round(((last.keyP95Ms - first.keyP95Ms) / first.keyP95Ms) * 100, 1),
	dataMb: { first: first?.dataMb, last: last?.dataMb, max: Math.max(...checkpoints.map(checkpoint => checkpoint.dataMb)) },
	historyMbMax: Math.max(...checkpoints.map(checkpoint => checkpoint.historyMb)),
	saveCpuMs: { first: first?.saveCpuMs, last: last?.saveCpuMs, max: Math.max(...checkpoints.map(checkpoint => checkpoint.saveCpuMs)) }
}

session.close()
console.log(JSON.stringify(args.includes("--json") ? { ...summary, series: checkpoints } : summary, null, args.includes("--json") ? 0 : 1))
