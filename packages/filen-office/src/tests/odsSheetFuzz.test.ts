import { readFileSync } from "node:fs"
import { odsProof } from "../core/ods/write/save"
import { STRICT_ERRORS } from "../core/ods/write/cells"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOdsSession } from "../core/ods/session"
import type { SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import type { SheetSession } from "../core/sheet/session"
import type { XlsxDocument } from "../core/xlsx/edit/document"
import { CORPUS_DIR } from "./corpusDir"
import { rng } from "./fuzz/config"
import { KNOWN_REFUSALS, OpPicker, type Outcome } from "./fuzz/sheet/ops"
import { odsBytes, table } from "./odsFixtures"
import { sameBytes } from "../core/docx/write/bytes"

// Random command sequences through ODS sessions, awaited one by one ("sync") and sent in bursts that interleave with
// tile requests and saves ("race"). At every checkpoint the save passes its proof (the file read back equals the
// session), and a fresh session on it shows what the editing session shows; once everything is undone, the save is
// the source's bytes. Refusals are typed, never findings. FILEN_OFFICE_ODS_FUZZ=<seeds> runs more seeds over the
// corpus too.

const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }
const STEPS = 16
const CHECK_EVERY = 6
const CALL_TIMEOUT_MS = 60_000
const REFUSALS = new Set([...KNOWN_REFUSALS, "chartUnsupported"])

type Mode = "sync" | "race"

interface Result {
	applied: number
	refusals: Record<string, number>
	findings: string[]
	ops: string[]
}

class Hang extends Error {}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined

	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Hang(`${what} did not answer`)), CALL_TIMEOUT_MS)
		})
	]).finally(() => clearTimeout(timer))
}

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

async function shown(session: SheetSessionApi, sheet: number): Promise<Map<string, string>> {
	const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0, 1, 0, 0, 1))
	const out = new Map<string, string>()

	for (const tile of tiles) for (const [key, value] of tileCells(tile)) out.set(key, value)

	return out
}

async function open(bytes: Uint8Array): Promise<SheetSession<XlsxDocument> | null> {
	const opened = await openOdsSession(
		bytesSource(bytes.slice()),
		{ kind: "ods", slicing: IMMEDIATE, settings: { author: "Fuzz", clock: () => 0 } },
		() => undefined
	)

	return opened.kind === "opened" ? (opened.session as SheetSession<XlsxDocument>) : null
}

// An error constant comes back from a document without calcext as the formula of that error alone (cells.ts
// STRICT_ERRORS): the same error shown, its input the formula.
function sameShown(left: string, right: string): boolean {
	if (left === right) return true

	const [text = "", input = ""] = left.split("|")

	return input === "" && STRICT_ERRORS.has(text) && right === `${text}|=${text}`
}

async function reopenProblems(live: SheetSession<XlsxDocument>, bytes: Uint8Array): Promise<string[]> {
	const fresh = await open(bytes)

	if (fresh === null) return ["the save does not open"]

	const problems: string[] = []

	try {
		await fresh.document.readyAllSheets(IMMEDIATE)

		if ((await fresh.intent()).state === "writable") await fresh.layout(fresh.document.activeSheet())

		const freshSheets = fresh.document.worksheets()

		for (const entry of live.document.worksheets()) {
			const other = freshSheets.find(candidate => candidate.name === entry.name)

			if (other === undefined) {
				problems.push(`sheet ${entry.name} missing`)

				continue
			}

			const left = await shown(live, entry.id)
			const right = await shown(fresh, other.id)

			for (const key of new Set([...left.keys(), ...right.keys()])) {
				if (!sameShown(left.get(key) ?? "|", right.get(key) ?? "|") && problems.length < 8)
					problems.push(
						`${entry.name} ${key}: ${JSON.stringify(left.get(key) ?? "|")} → ${JSON.stringify(right.get(key) ?? "|")}`
					)
			}
		}
	} finally {
		fresh.close()
	}

	return problems
}

async function sequence(bytes: Uint8Array, seed: number, mode: Mode): Promise<Result> {
	const rand = rng(seed)
	const picker = new OpPicker()
	const result: Result = { applied: 0, refusals: {}, findings: [], ops: [] }
	const session = await open(bytes)

	if (session === null) return { ...result, findings: ["does not open"] }

	const tally = (outcome: Outcome, op: string): void => {
		if (outcome.kind === "applied") result.applied++
		if (outcome.kind !== "refused") return

		const reason = outcome.refusal.reason

		if (!REFUSALS.has(reason)) result.findings.push(`${op}: untyped refusal ${JSON.stringify(outcome.refusal)}`)

		const key = `${op}:${reason}${outcome.refusal.detail === undefined ? "" : `(${outcome.refusal.detail})`}`

		result.refusals[key] = (result.refusals[key] ?? 0) + 1
	}

	try {
		if ((await within(session.intent(), "intent")).state !== "writable") return { ...result, findings: ["not writable"] }

		await session.document.readyAllSheets(IMMEDIATE)

		for (const entry of session.document.worksheets()) await session.tiles(entry.id, Uint32Array.of(0, 0, 1, 0, 0, 1))

		const checkpoint = async (): Promise<boolean> => {
			const saved = await within(session.save(), "save")

			if (!saved.ok) {
				result.findings.push(`save: ${saved.reason}: ${saved.message.slice(0, 600)} after ${result.ops.join(" ")}`)

				return false
			}

			const problems = await reopenProblems(session, saved.bytes)

			if (problems.length > 0) result.findings.push(`reopen: ${problems.join("; ")} after ${result.ops.join(" ")}`)

			return problems.length === 0
		}

		let checked = 0

		for (let step = 0; step < STEPS;) {
			const burst = mode === "sync" ? 1 : Math.min(STEPS - step, 1 + Math.floor(rand() * 5))
			const calls: Promise<void>[] = []

			for (let i = 0; i < burst; i++, step++) {
				const op = picker.pick(rand)
				const call = op.plan({ session, rand, edges: false, ranges: false })

				if (call === null) continue

				result.ops.push(op.name)

				const running = within(call(), op.name).then(outcome => tally(outcome, op.name))

				if (mode === "sync") await running
				else {
					calls.push(running)

					if (rand() < 0.3)
						calls.push(
							within(session.save(), "save").then(
								saved => void (saved.ok || result.findings.push(`mid-burst save: ${saved.message.slice(0, 400)}`))
							)
						)
				}
			}

			if (calls.length > 0) await Promise.all(calls)
			if (result.findings.length > 0) return result

			if (step - checked >= CHECK_EVERY || step >= STEPS) {
				checked = step

				if (!(await checkpoint())) return result
			}
		}

		for (let guard = 0; guard < 200; guard++) {
			const undone = await within(session.undo(), "undo")

			if (!undone.ok || !undone.change.state.canUndo) break
		}

		const saved = await within(session.save(), "save")

		if (!saved.ok) result.findings.push(`undone save: ${saved.message.slice(0, 400)}`)
		else if (!sameBytes(saved.bytes, bytes)) result.findings.push(`undone save is not the source after ${result.ops.join(" ")}`)
	} catch (error) {
		result.findings.push(
			`${error instanceof Hang ? "hang" : "crash"}: ${error instanceof Error ? (error.stack ?? error.message).slice(0, 1200) : String(error)} after ${result.ops.join(" ")}`
		)
	} finally {
		session.close()
	}

	return result
}

const cell = (value: string): string =>
	/^-?\d+(\.\d+)?$/.test(value)
		? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
		: `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`

// A small workbook with what sessions edit around: repeated rows and cells, formulas, a styled run, two sheets.
const FIXTURE = odsBytes({
	automatic:
		'<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style><style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.25in"/></style:style>',
	body:
		table(
			"Data",
			`<table:table-row>${cell("Name")}${cell("Amount")}${cell("Rate")}<table:table-cell table:number-columns-repeated="5"/></table:table-row>` +
				`<table:table-row table:number-rows-repeated="4">${cell("item")}${cell("10")}${cell("0.5")}<table:table-cell table:number-columns-repeated="5"/></table:table-row>` +
				`<table:table-row table:style-name="ro1">${cell("total")}<table:table-cell table:formula="of:=SUM([.B2:.B5])" office:value-type="float" office:value="40"><text:p>40</text:p></table:table-cell><table:table-cell table:formula="of:=AVERAGE([.C2:.C5])" office:value-type="float" office:value="0.5"><text:p>0.5</text:p></table:table-cell><table:table-cell table:number-columns-repeated="5"/></table:table-row>` +
				'<table:table-row table:number-rows-repeated="20"><table:table-cell table:style-name="ce1" table:number-columns-repeated="3"/><table:table-cell table:number-columns-repeated="5"/></table:table-row>',
			'<table:table-column table:number-columns-repeated="8"/>'
		) +
		table(
			"Other",
			`<table:table-row>${cell("x")}${cell("=")}</table:table-row>`,
			'<table:table-column table:number-columns-repeated="2"/>'
		)
})

// Every save proved by the whole file too where the rows it wrote proved it: the two never disagree.
beforeAll(() => {
	odsProof.whole = true
})
afterAll(() => {
	odsProof.whole = false
})

const MODES: readonly Mode[] = ["sync", "race"]
const SEEDS = Number(process.env["FILEN_OFFICE_ODS_FUZZ"] ?? "6")
const CORPUS = ["frictionless__table-with-two-sheets.ods", "lo__chart-import-basic.ods", "govuk__Budget_example__guidance.ods"]

describe("ODS sheet fuzz", () => {
	const targets: [string, () => Uint8Array][] = [
		["fixture", () => FIXTURE],
		...CORPUS.map((name): [string, () => Uint8Array] => [name, () => new Uint8Array(readFileSync(join(CORPUS_DIR, "ods", name)))])
	]

	for (const [name, bytes] of targets)
		for (const mode of MODES)
			it(`${name}, ${mode}`, { timeout: 600_000 }, async () => {
				let source: Uint8Array

				try {
					source = bytes()
				} catch {
					return
				}

				const findings: string[] = []
				let applied = 0

				for (let seed = 1; seed <= SEEDS; seed++) {
					const result = await sequence(source, seed, mode)

					applied += result.applied
					findings.push(...result.findings.map(finding => `seed ${seed}: ${finding}`))
				}

				expect(findings.slice(0, 10)).toEqual([])
				expect(applied).toBeGreaterThan(SEEDS * 3)
			})
})
