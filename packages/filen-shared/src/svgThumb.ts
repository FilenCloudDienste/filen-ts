import { svgRootStart } from "./svgProlog"

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

const WHITESPACE = /\s/

// End of a start tag: the first ">" outside a quoted attribute value.
function startTagEnd(text: string, from: number): number {
	let quote: string | null = null

	for (let index = from; index < text.length; index++) {
		const char = text.charAt(index)

		if (quote !== null) {
			if (char === quote) {
				quote = null
			}
		} else if (char === "\"" || char === "'") {
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
	const rootStart = svgRootStart(text)

	if (rootStart === "unsafe") {
		return { type: "rejected", reason: "unsupported" }
	}

	if (rootStart === "corrupt") {
		return { type: "rejected", reason: "corrupt" }
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
