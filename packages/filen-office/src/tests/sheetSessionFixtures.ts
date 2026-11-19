import { MessageChannel } from "node:worker_threads"
import {
	CellFlag,
	type SheetChange,
	type SheetCommandResult,
	type SheetEvent,
	type SheetHost,
	type SheetOpenOptions,
	type SheetOpened,
	type SheetReadSource,
	type SheetRefusal,
	type SheetSessionApi,
	type SheetTile
} from "../core/sheet/protocol"
import { sheetWorkerHost, type SheetWorkerLike } from "../dom/sheet/client"
import { inThreadSheetHost, workbookOpener, type SheetHostOptions } from "../dom/sheet/host"
import { serveSheetWorker } from "../dom/sheet/worker"
import { SML, R, buildFixture, type Fixture } from "./xlsxWriteFixtures"

// Sessions over small workbooks built from part text, for the session and host tests.

export { SML, R, buildFixture }

export const IMMEDIATE = { sliceMs: 1_000_000, now: () => 0, pause: () => Promise.resolve() }

export interface OpenedFixture extends SheetOpened {
	readonly events: SheetEvent[]
	readonly bytes: Uint8Array
}

export async function openFixture(fixture: Fixture | Uint8Array, options: Partial<SheetOpenOptions> = {}): Promise<OpenedFixture> {
	const bytes = fixture instanceof Uint8Array ? fixture : buildFixture(fixture)
	const events: SheetEvent[] = []
	const host = inThreadSheetHost()
	const result = await host.open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE, ...options }, event => events.push(event))

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}${"reason" in result ? ` (${result.reason})` : ""}`)

	return { session: result.session, info: result.info, events, bytes }
}

// The text each cell of a tile shows, by "row,col".
export function tileTexts(tile: SheetTile): Map<string, string> {
	const texts = new Map<string, string>()

	for (let i = 0; i < tile.count; i++) {
		const position = tile.positions[i] ?? 0
		const row = tile.tileRow * 64 + (position >> 5)
		const col = tile.tileCol * 32 + (position & 31)
		const index = tile.texts[i] ?? -1

		texts.set(`${row},${col}`, index < 0 ? "" : (tile.strings[index] ?? ""))
	}

	return texts
}

export function tileEntry(
	tile: SheetTile,
	row: number,
	col: number
): { text: string; input: string | null; style: number; flags: number } | null {
	const position = ((row & 63) << 5) | (col & 31)

	for (let i = 0; i < tile.count; i++) {
		if (tile.positions[i] !== position) continue

		const text = tile.texts[i] ?? -1
		const input = tile.inputs[i] ?? -1

		return {
			text: text < 0 ? "" : (tile.strings[text] ?? ""),
			input: input < 0 ? null : (tile.strings[input] ?? null),
			style: tile.styles[i] ?? 0,
			flags: tile.flags[i] ?? 0
		}
	}

	return null
}

export async function firstTile(session: SheetReadSource, sheet: number): Promise<SheetTile> {
	const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))

	return tiles[0] as SheetTile
}

export function cells(entries: readonly (readonly [number, number, string])[]): { rows: Uint32Array; cols: Uint16Array; inputs: string[] } {
	return {
		rows: Uint32Array.from(entries, entry => entry[0]),
		cols: Uint16Array.from(entries, entry => entry[1]),
		inputs: entries.map(entry => entry[2])
	}
}

export async function savedBytes(session: SheetSessionApi): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(`save refused (${result.reason}): ${result.message}`)

	return result.bytes
}

export function numeric(flags: number): boolean {
	return (flags & CellFlag.NUMBER) !== 0
}

function refusalText(refusal: SheetRefusal): string {
	return `${refusal.reason}${refusal.detail === undefined ? "" : ` (${refusal.detail})`}`
}

// A command's change; throws with the refusal's reason and detail when it was refused.
export function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(`refused: ${refusalText(result.refusal)}`)

	return result.change
}

// A refused command's reason; throws when the command was made.
export function refusalOf(result: SheetCommandResult): string {
	if (result.ok) throw new Error("expected a refusal, the command was made")

	return result.refusal.reason
}

// Text of `length` letters from a seeded generator: deflate cannot shrink it much, so a part built from it stays
// large compressed too.
export function noise(length: number, seed: number): string {
	let state = seed >>> 0
	let out = ""

	for (let i = 0; i < length; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		out += String.fromCharCode(97 + (state >>> 27))
	}

	return out
}

// A worker host and its server joined by a real message channel (structured clone and transfer, as a Worker).
// close disposes the host, then closes both ports.
export function workerPair(options?: SheetHostOptions): { host: SheetHost; close: () => void } {
	const { port1, port2 } = new MessageChannel()
	const page: SheetWorkerLike = {
		postMessage: (message, transfer) => {
			port1.postMessage(message, transfer ?? [])
		},
		addEventListener: (type, listener) => {
			if (type === "message") port1.on("message", (data: unknown) => listener({ data }))
		}
	}

	serveSheetWorker(
		{ post: (message, transfer) => port2.postMessage(message, [...transfer]), listen: on => port2.on("message", on) },
		workbookOpener(options)
	)

	const host = sheetWorkerHost(page)

	return {
		host,
		close: () => {
			host.dispose()
			port1.close()
			port2.close()
		}
	}
}

export const BASIC: Fixture = {
	sheets: [
		{
			name: "One",
			body:
				'<dimension ref="A1:C3"/><sheetData>' +
				'<row r="1"><c r="A1"><v>2</v></c><c r="B1" t="s"><v>0</v></c><c r="C1"><f>A1*3</f><v>6</v></c></row>' +
				'<row r="2"><c r="A2" s="1"><v>45000</v></c><c r="B2" t="b"><v>1</v></c></row>' +
				'<row r="3"><c r="A3"><f>SUM(A1:A2)</f><v>45002</v></c></row>' +
				"</sheetData>"
		},
		{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><f>One!A1+1</f><v>3</v></c></row></sheetData>' }
	],
	sharedStrings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${SML}" count="1" uniqueCount="1"><si><t>hello</t></si></sst>`
}
