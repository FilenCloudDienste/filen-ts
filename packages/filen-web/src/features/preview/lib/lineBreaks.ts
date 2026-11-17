import { RangeSet, RangeSetBuilder, RangeValue, StateEffect, StateField, type Extension, type Text } from "@codemirror/state"
import { invertedEffects } from "@codemirror/commands"

// Line breaks that differ from a file's own ending (lineEnding), kept where they are while the file is edited, so a
// save of a file with mixed endings changes only the lines that were edited. The editor splits lines on any ending and
// keeps none: each of these breaks is one position of its doc, held as a one-position range the edits map (a range an
// edit deletes is dropped, and comes back with its ending when the edit is undone; a break typed anew takes the file's
// own ending).

export class LineBreak extends RangeValue {
	readonly separator: string
	// Text typed at either side of the break goes outside it: before it at its start, after it at its end.
	override startSide = 1
	override endSide = -1

	constructor(separator: string) {
		super()
		this.separator = separator
	}

	override eq(other: RangeValue): boolean {
		return other instanceof LineBreak && other.separator === this.separator
	}
}

const BREAKS: Readonly<Record<string, LineBreak>> = { "\n": new LineBreak("\n"), "\r": new LineBreak("\r"), "\r\n": new LineBreak("\r\n") }

export type LineBreaks = RangeSet<LineBreak>

// The breaks of `text` (as read, with its endings) other than `separator`, at their positions in the editor's doc. One
// pass; empty for a file with one kind of ending.
export function otherLineBreaks(text: string, separator: string): LineBreaks {
	const builder = new RangeSetBuilder<LineBreak>()
	let position = 0

	for (let index = 0; index < text.length; index++, position++) {
		const code = text.charCodeAt(index)

		if (code !== 10 && code !== 13) {
			continue
		}

		const found = code === 13 && text.charCodeAt(index + 1) === 10 ? "\r\n" : code === 13 ? "\r" : "\n"

		if (found !== separator) {
			builder.add(position, position + 1, BREAKS[found] ?? new LineBreak(found))
		}

		index += found.length - 1
	}

	return builder.finish()
}

// The doc's text with `separator` between its lines, except where `breaks` keeps another.
export function joinLines(doc: Text, separator: string, breaks: LineBreaks): string {
	if (breaks.size === 0) {
		return doc.sliceString(0, doc.length, separator)
	}

	const parts: string[] = []
	let at = 0

	const cursor = breaks.iter()

	while (cursor.value !== null) {
		const position = cursor.to - 1

		// Still a line break: the end of a line that is not the last.
		if (position >= at && position < doc.length && doc.lineAt(position).to === position) {
			parts.push(doc.sliceString(at, position, separator), cursor.value.separator)
			at = position + 1
		}

		cursor.next()
	}

	parts.push(doc.sliceString(at, doc.length, separator))

	return parts.join("")
}

// Breaks an undone edit had deleted, at their positions once it is undone. Undo history keeps them with the edit and
// maps them through any later change.
const restoreBreaks = StateEffect.define<readonly { position: number; separator: string }[]>({
	map: (breaks, mapping) => breaks.map(({ position, separator }) => ({ position: mapping.mapPos(position, 1), separator }))
})

// The editor's breaks, mapped through every edit; `initial` stands for them before the editor exists. An edit that
// deletes some leaves them in its inverse (invertedEffects), so undoing it puts them back as they were.
export function lineBreaksField(initial: LineBreaks): { field: StateField<LineBreaks>; extension: Extension; initial: LineBreaks } {
	const field = StateField.define<LineBreaks>({
		create: () => initial,
		update: (breaks, transaction) => {
			let next = transaction.docChanged ? breaks.map(transaction.changes) : breaks

			for (const effect of transaction.effects) {
				if (effect.is(restoreBreaks)) {
					next = next.update({
						add: effect.value.map(({ position, separator }) =>
							(BREAKS[separator] ?? new LineBreak(separator)).range(position, position + 1)
						),
						sort: true
					})
				}
			}

			return next
		}
	})
	const remember = invertedEffects.of(transaction => {
		const before = transaction.startState.field(field, false)

		if (before === undefined || before.size === 0 || !transaction.docChanged) {
			return []
		}

		const deleted: { position: number; separator: string }[] = []

		transaction.changes.iterChangedRanges((fromA, toA) => {
			before.between(fromA, toA, (from, to, value) => {
				if (from >= fromA && to <= toA) {
					deleted.push({ position: from, separator: value.separator })
				}
			})
		})

		return deleted.length === 0 ? [] : [restoreBreaks.of(deleted)]
	})

	return { field, extension: [field, remember], initial }
}
