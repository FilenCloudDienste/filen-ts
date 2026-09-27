// Readies an untrusted SVG document for rasterising into a thumbnail. The security boundary is not
// here: the markup is only ever loaded as an <img>, where the SVG spec's secure mode runs no script,
// fires no event handler and fetches no external resource. This module only refuses what that mode
// does not cover (an entity-expansion bomb in the DOCTYPE, which the XML parser would expand before
// rendering starts) and stamps a thumbnail-sized width and height on the root, which every engine
// needs to draw the image crisply and Firefox needs to draw it at all.
//
// Only the prolog and the root start tag are read, never the whole document: the browser parses it
// once, for the <img>, and a second DOM parse here would double the main-thread cost for nothing.

export type SvgThumbSource =
	{ type: "ok"; markup: string; width: number; height: number } | { type: "rejected"; reason: "unsupported" | "corrupt" }

const SVG_NS = "http://www.w3.org/2000/svg"

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

// Index just past the root element's prolog (XML declaration, comments, processing instructions, the
// DOCTYPE), or a rejection. The DOCTYPE's internal subset is checked on the way past.
function skipProlog(text: string): number | SvgThumbSource {
	let index = skipWhitespace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0)

	for (;;) {
		if (text.startsWith("<?", index)) {
			const end = text.indexOf("?>", index + 2)

			if (end === -1) {
				return { type: "rejected", reason: "corrupt" }
			}

			index = skipWhitespace(text, end + 2)
		} else if (text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4)

			if (end === -1) {
				return { type: "rejected", reason: "corrupt" }
			}

			index = skipWhitespace(text, end + 3)
		} else if (text.startsWith("<!DOCTYPE", index)) {
			const doctype = doctypeEnd(text, index + "<!DOCTYPE".length)

			if (doctype === null) {
				return { type: "rejected", reason: "corrupt" }
			}

			if (doctype.subset !== undefined && isDangerousSubset(doctype.subset)) {
				return { type: "rejected", reason: "unsupported" }
			}

			index = skipWhitespace(text, doctype.end + 1)
		} else {
			return index
		}
	}
}

// End of a start tag: the first ">" outside a quoted attribute value.
function startTagEnd(text: string, from: number): number {
	let quote: string | null = null

	for (let index = from; index < text.length; index++) {
		const char = text.charAt(index)

		if (quote !== null) {
			if (char === quote) {
				quote = null
			}
		} else if (char === '"' || char === "'") {
			quote = char
		} else if (char === ">") {
			return index
		}
	}

	return -1
}

function attribute(attributes: string, name: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)

	return match === null ? undefined : (match[1] ?? match[2])
}

// A plain or px length; percentages and relative units say nothing about the drawing's own extent.
function absoluteLength(value: string | undefined): number | undefined {
	if (value === undefined) {
		return undefined
	}

	const match = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(?:px)?\s*$/i.exec(value)
	const length = match?.[1] === undefined ? Number.NaN : Number(match[1])

	return Number.isFinite(length) && length > 0 ? length : undefined
}

function viewBoxSize(value: string | undefined): { width: number; height: number } | undefined {
	const parts = value
		?.trim()
		.split(/[\s,]+/)
		.map(Number)

	if (parts?.length !== 4) {
		return undefined
	}

	const [, , width = Number.NaN, height = Number.NaN] = parts

	return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined
}

// `maxDim` is the long side of the result: a vector scales up losslessly, so a 16px icon renders at
// thumbnail size rather than as a speck.
export function prepareSvgThumb(text: string, maxDim: number): SvgThumbSource {
	const rootStart = skipProlog(text)

	if (typeof rootStart !== "number") {
		return rootStart
	}

	const afterName = text.charAt(rootStart + 4)

	if (!text.startsWith("<svg", rootStart) || !(afterName === ">" || afterName === "/" || WHITESPACE.test(afterName))) {
		return { type: "rejected", reason: "unsupported" }
	}

	const tagEnd = startTagEnd(text, rootStart + 4)

	if (tagEnd === -1) {
		return { type: "rejected", reason: "corrupt" }
	}

	const selfClosing = text.charAt(tagEnd - 1) === "/"
	const attributes = text.slice(rootStart + 4, selfClosing ? tagEnd - 1 : tagEnd)
	const viewBox = viewBoxSize(attribute(attributes, "viewBox"))
	const declaredWidth = absoluteLength(attribute(attributes, "width"))
	const declaredHeight = absoluteLength(attribute(attributes, "height"))
	// Without a viewBox, a changed width and height would only resize the viewport around a drawing
	// that stays at its own scale; one derived from the declared size scales the drawing with it.
	const derivedViewBox =
		viewBox === undefined && declaredWidth !== undefined && declaredHeight !== undefined
			? { width: declaredWidth, height: declaredHeight }
			: undefined
	const extent = viewBox ?? derivedViewBox
	const aspect = extent === undefined ? 1 : extent.width / extent.height
	const width = Math.max(1, Math.round(aspect >= 1 ? maxDim : maxDim * aspect))
	const height = Math.max(1, Math.round(aspect >= 1 ? maxDim / aspect : maxDim))

	// A derived viewBox replaces an unusable one: a second viewBox attribute would make the document malformed.
	const replaced =
		derivedViewBox === undefined
			? /(^|\s)(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*')/g
			: /(^|\s)(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*')/g
	let rootAttributes = attributes.replace(replaced, "$1").trimEnd()

	rootAttributes += ` width="${String(width)}" height="${String(height)}"`

	if (derivedViewBox !== undefined) {
		rootAttributes += ` viewBox="0 0 ${String(derivedViewBox.width)} ${String(derivedViewBox.height)}"`
	}

	// Loaded as image/svg+xml, a root outside the SVG namespace renders as bare XML, which is nothing.
	if (attribute(attributes, "xmlns") === undefined) {
		rootAttributes += ` xmlns="${SVG_NS}"`
	}

	return {
		type: "ok",
		markup: `${text.slice(0, rootStart)}<svg${rootAttributes.startsWith(" ") ? "" : " "}${rootAttributes}${selfClosing ? "/" : ""}${text.slice(tagEnd)}`,
		width,
		height
	}
}
