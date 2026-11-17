import DOMPurify from "dompurify"

// A tagged PDF's formulas (their MathML, from the file) for the structure tree screen readers read: a DOMPurify
// instance of its own, allowing MathML elements only, so no other sanitizer's configuration or hooks reach it.
const purifier = DOMPurify(window)

export function sanitizePdfMathML(markup: string): Node | null {
	const fragment = purifier.sanitize(markup, {
		USE_PROFILES: { mathMl: true },
		RETURN_DOM_FRAGMENT: true
	})

	return fragment.childNodes.length === 0 ? null : fragment
}
