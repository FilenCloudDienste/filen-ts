// Where an untrusted SVG document's root element starts, past its prolog (XML declaration, comments,
// processing instructions, the DOCTYPE). Only the prolog is read, never the whole document. A DOCTYPE
// whose internal subset could expand is refused: an XML parser expands an entity bomb before anything is
// drawn, whatever secure mode the SVG is shown in.

export type SvgPrologRefusal = "unsafe" | "corrupt"

// A DOCTYPE internal subset that could expand: any entity or character reference (the amplification a
// "billion laughs" document relies on), a parameter entity, or an external entity. Judged over the
// whole subset, never per declaration, so no quoting inside a value can hide one. A plain string
// entity, which Illustrator exports declare for their namespaces, is fine.
function isDangerousSubset(subset: string): boolean {
	return /[&%]/.test(subset) || /<!ENTITY\s+\S+\s+(?:SYSTEM|PUBLIC)\b/i.test(subset)
}

const WHITESPACE = /\s/

function skipWhitespace(text: string, from: number): number {
	let index = from

	while (index < text.length && WHITESPACE.test(text.charAt(index))) {
		index++
	}

	return index
}

// The index of the ">" closing a DOCTYPE whose name starts at `from`, and its internal subset, if any; null
// when it never closes. Tokenised, never searched for: a quoted literal, a comment or a processing
// instruction may contain "]>" or ">", and a scan that stopped there would judge only a prefix of the
// subset (letting an entity chain after it through) or take a "<svg" inside it for the root.
function doctypeEnd(text: string, from: number): { end: number; subset?: string } | null {
	let subsetStart = -1

	for (let index = from; index < text.length; index++) {
		const char = text.charAt(index)

		if (subsetStart !== -1 && text.startsWith("<!--", index)) {
			const close = text.indexOf("-->", index + 4)

			if (close === -1) {
				return null
			}

			index = close + 2
		} else if (subsetStart !== -1 && text.startsWith("<?", index)) {
			const close = text.indexOf("?>", index + 2)

			if (close === -1) {
				return null
			}

			index = close + 1
		} else if (char === '"' || char === "'") {
			const close = text.indexOf(char, index + 1)

			if (close === -1) {
				return null
			}

			index = close
		} else if (char === "[" && subsetStart === -1) {
			subsetStart = index
		} else if (char === "]" && subsetStart !== -1) {
			const close = skipWhitespace(text, index + 1)

			return text.charAt(close) === ">" ? { end: close, subset: text.slice(subsetStart, index + 1) } : null
		} else if (char === ">" && subsetStart === -1) {
			return { end: index }
		}
	}

	return null
}

// Index just past the prolog of `text` (a leading byte order mark skipped), where the root element should
// start; "unsafe" for a DOCTYPE that could expand, "corrupt" for a prolog that never ends.
export function svgRootStart(text: string): number | SvgPrologRefusal {
	let index = skipWhitespace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)

	for (;;) {
		if (text.startsWith("<?", index)) {
			const end = text.indexOf("?>", index + 2)

			if (end === -1) {
				return "corrupt"
			}

			index = skipWhitespace(text, end + 2)
		} else if (text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4)

			if (end === -1) {
				return "corrupt"
			}

			index = skipWhitespace(text, end + 3)
		} else if (text.startsWith("<!DOCTYPE", index)) {
			const doctype = doctypeEnd(text, index + "<!DOCTYPE".length)

			if (doctype === null) {
				return "corrupt"
			}

			if (doctype.subset !== undefined && isDangerousSubset(doctype.subset)) {
				return "unsafe"
			}

			index = skipWhitespace(text, doctype.end + 1)
		} else {
			return index
		}
	}
}
