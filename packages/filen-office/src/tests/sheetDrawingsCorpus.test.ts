import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SheetSessionApi } from "../core/sheet/protocol"
import type { DrawingAnchor } from "../core/xlsx/drawings/anchor"
import type { SheetDrawings } from "../core/xlsx/drawings/feature"
import { CORPUS_DIR } from "./corpusDir"
import { openDrawings } from "./sheetDrawingsFixtures"
import { settle } from "./sheetNotesFixtures"

// Every corpus workbook with a drawing part: each object listed is drawn without failing (charts left to their
// renderer), and the first movable object of each sheet moved by a row saves through the gate and reads back there.
// A workbook that does not open is counted with why; one whose opening or layout throws fails. Opt-in:
// FILEN_OFFICE_DRAWINGS_CORPUS=1, with the corpus fetched.

const ENABLED = process.env["FILEN_OFFICE_DRAWINGS_CORPUS"] === "1"
const DIRECTORY = join(CORPUS_DIR, "xlsx")
// What openDrawings throws for a workbook that did not open.
const UNOPENED = new Set(["failed", "aborted"])
// From a run over the corpus (88 workbooks, 670 objects, 163 moved), a little under it so a workbook or two may leave it.
const FLOOR = { files: 80, objects: 600, moved: 145 }

function workbooks(): string[] {
	if (!existsSync(DIRECTORY)) return []

	return readdirSync(DIRECTORY)
		.filter(name => name.endsWith(".xlsx") || name.endsWith(".xlsm"))
		.filter(name => readFileSync(join(DIRECTORY, name)).includes("xl/drawings/drawing"))
		.sort()
}

function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

async function drawingsOf(session: SheetSessionApi, sheet: number): Promise<SheetDrawings | undefined> {
	await session.layout(sheet)
	await settle()

	return (await session.layout(sheet)).extensions?.drawings
}

function down(anchor: DrawingAnchor): DrawingAnchor {
	switch (anchor.mode) {
		case "absolute":
			return { ...anchor, y: anchor.y + 190500 }
		case "oneCell":
			return { ...anchor, from: { ...anchor.from, row: anchor.from.row + 1 } }
		case "twoCell":
			return { ...anchor, from: { ...anchor.from, row: anchor.from.row + 1 }, to: { ...anchor.to, row: anchor.to.row + 1 } }
	}
}

// Where an anchor puts its object's top: its row, or its offset for an absolute one. The writer may normalise the
// rest (offsets, the far corner).
function top(anchor: DrawingAnchor): string {
	return anchor.mode === "absolute" ? `y ${String(anchor.y)}` : `row ${String(anchor.from.row)}`
}

describe.skipIf(!ENABLED || workbooks().length === 0)("drawings over the corpus", () => {
	it("draws every object and moves one per sheet through the gate", { timeout: 1_800_000 }, async () => {
		const tally = {
			files: 0,
			objects: 0,
			drawn: 0,
			charts: 0,
			placeholders: 0,
			moved: 0,
			readBack: 0,
			refused: new Map<string, number>(),
			unopened: new Map<string, string>()
		}
		const failures: string[] = []

		for (const name of workbooks()) {
			let opened: Awaited<ReturnType<typeof openDrawings>>

			try {
				opened = await openDrawings(new Uint8Array(readFileSync(join(DIRECTORY, name))))
			} catch (error) {
				if (error instanceof Error && UNOPENED.has(error.message)) tally.unopened.set(name, error.message)
				else failures.push(`${name}: opening threw ${errorText(error)}`)

				continue
			}

			const { session, sheets } = opened
			// Each object moved: its sheet, key (its place in z-order, which a move keeps), name and where its top went.
			const moved: { sheet: number; key: number; name: string; top: string }[] = []

			tally.files++

			for (const sheet of sheets) {
				let drawings: SheetDrawings | undefined

				try {
					drawings = await drawingsOf(session, sheet)
				} catch (error) {
					failures.push(`${name}: sheet ${String(sheet)} layout threw ${errorText(error)}`)

					continue
				}

				for (const object of drawings?.objects ?? []) {
					tally.objects++

					const rendered = await session.query("drawing.render", { sheet, key: object.key, stamp: object.stamp })

					// Asked without `since`, nothing answers "same".
					if (rendered === null || rendered.kind === "same")
						failures.push(`${name}: sheet ${String(sheet)} object ${String(object.key)} not found`)
					else if (rendered.kind === "drawing") tally.drawn++
					else if (rendered.reason === "chart") tally.charts++
					else if (rendered.reason === "failed")
						failures.push(`${name}: sheet ${String(sheet)} object ${String(object.key)} failed`)
					else tally.placeholders++
				}

				const movable = drawings?.objects.find(object => !object.noMove)

				if (movable === undefined) continue

				const anchor = down(movable.anchor)
				const result = await session.command({ type: "drawing.move", sheet, key: movable.key, stamp: movable.stamp, anchor })

				if (result.ok) {
					tally.moved++
					moved.push({ sheet, key: movable.key, name: movable.name, top: top(anchor) })
				} else {
					const reason = `${result.refusal.reason}${result.refusal.detail === undefined ? "" : `:${result.refusal.detail}`}`

					tally.refused.set(reason, (tally.refused.get(reason) ?? 0) + 1)
				}
			}

			const saved = await session.save()

			if (!saved.ok) failures.push(`${name}: save ${saved.reason} ${saved.message}`)
			else {
				const reopened = await openDrawings(saved.bytes)

				for (const object of moved) {
					const found = (await drawingsOf(reopened.session, object.sheet))?.objects.find(
						candidate => candidate.key === object.key
					)
					const at = `${name}: sheet ${String(object.sheet)} object ${String(object.key)}`

					if (found === undefined || found.name !== object.name) failures.push(`${at} not found after the save`)
					else if (top(found.anchor) !== object.top) failures.push(`${at} reads back at ${top(found.anchor)}, not ${object.top}`)
					else tally.readBack++
				}

				reopened.session.close()
			}

			session.close()
		}

		// The tally, for a report (FILEN_OFFICE_DRAWINGS_TALLY names a file).
		const out = process.env["FILEN_OFFICE_DRAWINGS_TALLY"]

		if (out !== undefined && out !== "")
			writeFileSync(
				out,
				JSON.stringify({ ...tally, refused: Object.fromEntries(tally.refused), unopened: Object.fromEntries(tally.unopened) })
			)
		expect(failures).toEqual([])
		expect(tally.files, "workbooks opened").toBeGreaterThanOrEqual(FLOOR.files)
		expect(tally.objects, "objects").toBeGreaterThanOrEqual(FLOOR.objects)
		expect(tally.moved, "objects moved").toBeGreaterThanOrEqual(FLOOR.moved)
	})
})
