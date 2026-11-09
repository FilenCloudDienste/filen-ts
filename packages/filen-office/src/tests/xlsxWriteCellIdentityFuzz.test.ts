import { unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import type { SheetCommand } from "../core/sheet/protocol"
import { R, SML, firstTile, openFixture } from "./sheetSessionFixtures"

// Every cell carries an attribute the model does not hold (its identity). Random formats, value edits and row and
// column inserts and deletes over equal values; after the save every identity is where its cell went, once.

const RUNS = 300
const ID = "urn:cell-identity"

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

function colName(col: number): string {
	let name = ""

	for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name

	return name
}

describe("cell identity through edits", () => {
	it("keeps each cell's own unmodelled attribute with the cell", { timeout: 120_000 }, async () => {
		const failures: string[] = []

		for (let run = 0; run < RUNS && failures.length < 5; run++) {
			const random = rng(run + 1)
			const rows = 2 + Math.floor(random() * 5)
			const cols = 2 + Math.floor(random() * 5)
			// id -> [row, col], or null once its cell is deleted.
			const expected = new Map<number, [number, number] | null>()
			let id = 0
			let body = "<sheetData>"

			for (let row = 0; row < rows; row++) {
				body += `<row r="${row + 1}">`

				for (let col = 0; col < cols; col++) {
					if (random() < 0.25) continue

					expected.set(++id, [row, col])
					body += `<c r="${colName(col)}${row + 1}" own:id="${id}"><v>1</v></c>`
				}

				body += "</row>"
			}

			body += "</sheetData>"

			const { session, info } = await openFixture({
				sheets: [
					{
						name: "One",
						xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="${R}" xmlns:own="${ID}">${body}</worksheet>`
					}
				]
			})
			const sheet = info.sheets[0]!.id
			const log: string[] = []

			await firstTile(session, sheet)
			await session.intent()

			for (let step = 0; step < 6; step++) {
				const pick = random()
				const at = Math.floor(random() * Math.max(rows, cols))
				const count = 1 + Math.floor(random() * 2)
				let command: SheetCommand

				if (pick < 0.25) {
					const row = Math.floor(random() * rows)
					const col = Math.floor(random() * cols)

					command = {
						type: "format.apply",
						sheet,
						ranges: [{ startRow: row, startCol: col, endRow: row + 1, endCol: col + 1 }],
						patch: { bold: random() < 0.5 }
					}
				} else if (pick < 0.4) {
					command = {
						type: "cells.set",
						sheet,
						cells: {
							rows: Uint32Array.of(Math.floor(random() * rows)),
							cols: Uint16Array.of(Math.floor(random() * cols)),
							inputs: ["1"]
						}
					}
				} else {
					const axis = random() < 0.5 ? "rows" : "cols"
					command =
						random() < 0.5 ? { type: "axis.insert", sheet, axis, at, count } : { type: "axis.delete", sheet, axis, at, count }
				}

				const result = await session.command(command)

				log.push(
					`${JSON.stringify(command, (_, value) => (value instanceof Uint32Array || value instanceof Uint16Array ? [...value] : value))} ${result.ok ? "ok" : result.refusal.reason}`
				)

				if (!result.ok || (command.type !== "axis.insert" && command.type !== "axis.delete") || !("at" in command)) continue

				const rowsAxis = command.axis === "rows"

				for (const [key, place] of expected) {
					if (place === null) continue

					const index = rowsAxis ? place[0] : place[1]

					if (command.type === "axis.insert") {
						if (index >= command.at) place[rowsAxis ? 0 : 1] = index + command.count
					} else if (index >= command.at && index < command.at + command.count) {
						expected.set(key, null)
					} else if (index >= command.at + command.count) {
						place[rowsAxis ? 0 : 1] = index - command.count
					}
				}
			}

			const saved = await session.save()

			session.close()

			if (!saved.ok) {
				failures.push(`run ${run}: save ${saved.reason} ${saved.message}\n${log.join("\n")}`)
				continue
			}

			const xml = new TextDecoder().decode(unzipSync(saved.bytes)["xl/worksheets/sheet1.xml"])
			const seen = new Map<number, string>()

			for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*?\sown:id="(\d+)"/g)) {
				const key = Number(match[3])

				if (seen.has(key)) failures.push(`run ${run}: id ${key} twice`)

				seen.set(key, `${match[1]}${match[2]}`)
			}

			const wrong: string[] = []

			for (const [key, place] of expected) {
				const at = seen.get(key)

				if (place === null) {
					if (at !== undefined) wrong.push(`${key}: deleted, found at ${at}`)
				} else if (at !== undefined && at !== `${colName(place[1])}${place[0] + 1}`) {
					wrong.push(`${key}: expected ${colName(place[1])}${place[0] + 1}, found at ${at}`)
				}
			}

			if (wrong.length > 0) failures.push(`run ${run}: ${wrong.slice(0, 4).join("; ")}\n${log.join("\n")}`)
		}

		expect(failures).toEqual([])
	})
})
