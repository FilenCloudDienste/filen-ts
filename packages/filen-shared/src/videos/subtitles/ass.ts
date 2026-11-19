import { CueBuilder, SubtitleLineReader, MAX_SUBTITLE_CHARS, normalizeCueText, parseSubtitleTimestamp, type CueStore } from "./cues"

const DEFAULT_COLUMNS = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]

// First `count - 1` comma-separated fields, then the rest as the final field (the text may contain commas).
function splitFields(line: string, from: number, count: number): string[] | null {
	const out: string[] = []
	let start = from

	for (let k = 0; k < count - 1; k++) {
		const comma = line.indexOf(",", start)

		if (comma === -1) {
			return null
		}

		out.push(line.slice(start, comma))
		start = comma + 1
	}

	out.push(line.slice(start))

	return out
}

// ASS/SSA reduced to plain text: `{...}` overrides are removed except `\anN` (cue alignment hint), `\N`/`\n` become line breaks,
// vector drawings are dropped. Returns null when over the size cap.
export function parseAss(input: string): CueStore | null {
	if (input.length > MAX_SUBTITLE_CHARS) {
		return null
	}

	const reader = new SubtitleLineReader(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input)
	const builder = new CueBuilder()
	let inEvents = false
	let columns = DEFAULT_COLUMNS
	let startIdx = 1
	let endIdx = 2
	let textIdx = 9

	for (let line = reader.next(); line !== null; line = reader.next()) {
		const t = line.trimStart()

		if (t.charCodeAt(0) === 91) {
			inEvents = t.slice(0, 8).toLowerCase() === "[events]"

			continue
		}

		if (!inEvents) {
			continue
		}

		const colon = t.indexOf(":")

		if (colon === -1 || colon > 10) {
			continue
		}

		const key = t.slice(0, colon).toLowerCase()

		if (key === "format") {
			const names = t
				.slice(colon + 1)
				.split(",", 32)
				.map(name => name.trim().toLowerCase())
			const s = names.indexOf("start")
			const e = names.indexOf("end")
			const x = names.indexOf("text")

			if (s !== -1 && e !== -1 && x !== -1) {
				columns = names
				startIdx = s
				endIdx = e
				textIdx = x
			}

			continue
		}

		if (key !== "dialogue") {
			continue
		}

		const fields = splitFields(t, colon + 1, columns.length)

		if (fields === null) {
			continue
		}

		const start = parseSubtitleTimestamp((fields[startIdx] as string).trim())
		const end = parseSubtitleTimestamp((fields[endIdx] as string).trim())

		if (start === null || end === null) {
			continue
		}

		const cleaned = normalizeCueText((fields[textIdx] as string).trimStart(), "ass")

		if (!cleaned.drawing) {
			builder.add(start.seconds, end.seconds, cleaned.text, cleaned.hint)
		}
	}

	return builder.finish()
}

// A Matroska S_TEXT/ASS or SSA block is "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text": the text is
// what follows the eighth comma. A block with fewer commas is taken whole.
export function assBlockText(line: string): string {
	let at = 0

	for (let commas = 0; commas < 8; commas++) {
		const next = line.indexOf(",", at)

		if (next === -1) {
			return line
		}

		at = next + 1
	}

	return line.slice(at)
}
