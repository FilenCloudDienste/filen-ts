import type { SheetId } from "../protocol"
import { defineSheetFeature, type SheetCommandContext, type SheetHandled } from "../registry"
import { textFeature, type TextSheetDocument } from "../text"
import { autoFillWrites, entryCells, fillPlan, seriesWrites, type FillWrites } from "./fill"
import { fillSeries, seriesLine, type FillCalendar, type FillSourceCell } from "./series"
import { dateSerial, MAX_SERIAL_1900, serialDate, type DateParts } from "../numfmt/date"

// Fill over a text file: each target takes its source's text as it is, or a number or text of its own. A field that
// reads as a plain number is a number; a text file has no dates, so a series by dates counts in 1900-system serials.

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function read(document: TextSheetDocument, row: number, col: number): FillSourceCell {
	const text = document.text(row, col)

	if (text === "") return { kind: "empty" }
	if (NUMBER.test(text)) return { kind: "number", value: Number(text), temporal: "none" }

	return { kind: "text", text }
}

const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

const SERIALS: FillCalendar = {
	date: serial => ({ ...serialDate(serial, false, parts) }),
	serial: (year, month, day) => dateSerial(year, month, day, false),
	maxSerial: MAX_SERIAL_1900
}

// Writes a fill's targets as text.
function writeTexts(
	context: SheetCommandContext<TextSheetDocument>,
	sheet: SheetId,
	writes: FillWrites | "tooLarge" | null
): SheetHandled | Promise<SheetHandled> {
	if (writes === null) return null
	if (writes === "tooLarge") return { refused: { reason: "tooLarge" } }

	const set = textFeature.commands?.["cells.set"]
	const inputs = writes.values.map((value, i) =>
		value.kind === "copy"
			? context.doc.text(writes.sourceRows[i] ?? 0, writes.sourceCols[i] ?? 0)
			: value.kind === "number"
				? String(value.value)
				: value.text
	)

	if (writes.values.some(value => value.kind === "number" && !Number.isFinite(value.value))) return { refused: { reason: "tooLarge" } }

	return set === undefined
		? { refused: { reason: "unsupported" } }
		: set.run(context, { type: "cells.set", sheet, cells: { rows: writes.rows, cols: Uint16Array.from(writes.cols), inputs } })
}

export const textFillFeature = defineSheetFeature<TextSheetDocument>({
	id: "fill",
	commands: {
		"fill.auto": {
			info: { write: true },
			run: async (context, command) => {
				const handled = await writeTexts(
					context,
					command.sheet,
					autoFillWrites(command.source, command.target, command.mode, (row, col) => read(context.doc, row, col), fillSeries)
				)

				if (handled !== null && !("refused" in handled))
					context.changes.select(command.sheet, {
						activeRow: command.source.startRow,
						activeCol: command.source.startCol,
						ranges: [command.target]
					})

				return handled
			}
		},
		"fill.series": {
			info: { write: true },
			run: (context, command) => {
				const stop = command.options.stop === null ? null : command.options.stop.trim()

				if (stop !== null && !NUMBER.test(stop)) return { refused: { reason: "unsupported", detail: "stop" } }

				const options = { ...command.options, stop: stop === null ? null : Number(stop) }

				return writeTexts(
					context,
					command.sheet,
					seriesWrites(
						command.range,
						command.orientation,
						(row, col) => read(context.doc, row, col),
						cells => seriesLine(cells, options, SERIALS)
					)
				)
			}
		},
		"fill.copy": {
			info: { write: true },
			run: (context, command) => {
				const plan = fillPlan(command.ranges, command.direction)

				if (plan === null) return null
				if (plan === "tooLarge") return { refused: { reason: "tooLarge" } }

				const inputs = Array.from(plan.rows, (_, i) => context.doc.text(plan.sourceRows[i] ?? 0, plan.sourceCols[i] ?? 0))
				const set = textFeature.commands?.["cells.set"]

				return set === undefined
					? { refused: { reason: "unsupported" } }
					: set.run(context, {
							type: "cells.set",
							sheet: command.sheet,
							cells: { rows: plan.rows, cols: Uint16Array.from(plan.cols), inputs }
						})
			}
		},
		"fill.entry": {
			info: { write: true },
			run: (context, command) => {
				// A text file merges nothing.
				const cells = entryCells(command.ranges, new Uint32Array(0), command.entry, command.from)
				const set = textFeature.commands?.["cells.set"]

				if (cells === null) return null
				if (cells === "tooLarge") return { refused: { reason: "tooLarge" } }

				return set === undefined
					? { refused: { reason: "unsupported" } }
					: set.run(context, { type: "cells.set", sheet: command.sheet, cells })
			}
		}
	}
})
