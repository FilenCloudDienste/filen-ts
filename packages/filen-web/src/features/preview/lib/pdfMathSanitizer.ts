import DOMPurify from "dompurify"

// A tagged PDF's formulas (their MathML, from the file) for the structure tree screen readers read: a DOMPurify
// instance of its own, allowing MathML elements only, so no other sanitizer's configuration or hooks reach it.
const purifier = DOMPurify(window)

export function sanitizePdfMathML(markup: string): Node | null {
	try {
		return mathFragment(markup)
	} finally {
		// What the run removed holds its parsed document until the next run.
		purifier.removed.length = 0
	}
}

function mathFragment(markup: string): Node | null {
	const fragment = purifier.sanitize(markup, {
		USE_PROFILES: { mathMl: true },
		// Reading a formula needs none of these: an id could shadow the structure tree's own (aria-owns targets) or the
		// app's, a link would be activatable from the canvas's fallback content.
		FORBID_ATTR: ["id", "href", "xlink:href", "style"],
		RETURN_DOM_FRAGMENT: true
	})

	return fragment.childNodes.length === 0 ? null : fragment
}
