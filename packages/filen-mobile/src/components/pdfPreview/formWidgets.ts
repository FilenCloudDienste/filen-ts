/**
 * Neutralises the form widgets pdf.js renders from a document's own field definitions.
 *
 * pdf.js sets an input's type from the document's field flags and emits no autocomplete attribute at
 * all. This app is associated with the Filen web domains for password autofill, so without this a
 * hostile document can draw a convincing "re-enter your Filen password" box inside the real app and
 * have the platform's password manager offer the real credential to it.
 *
 * The name and id are rewritten as well: both platforms' autofill heuristics are driven by attribute
 * names, so a document-chosen `name="password"` is a hint that must not be forwarded. textarea and
 * select are swept too — neither can be type=password, so they are not the headline vector, but both
 * carry a document-chosen name that autofill will match on.
 *
 * A wrapping <form> is deliberately NOT added: it would create the element the security contract
 * verifies pdf.js never creates.
 *
 * Kept free of pdfjs and native imports so it is testable against a real DOM.
 */
/**
 * Naming state for ONE document.
 *
 * Must outlive a single sweep. Widget grouping is document-wide — pdf.js deliberately creates no
 * <form>, so same-named radios group across the whole tree — while sweeping happens per rendered
 * page and again per focused widget. A per-sweep counter therefore hands the same replacement name
 * to unrelated fields on different pages, and since the annotation layer resolves a change through
 * `document.getElementsByName`, ticking a box on one page clears the collided one on another — in
 * the DOM and in the annotation storage a save serialises from.
 */
export type FormWidgetScope = {
	/** Original name -> opaque replacement, so real grouping survives renaming. */
	readonly names: Map<string, string>
	nextId: number
}

/**
 * Marks a widget this sweep has already neutralised.
 *
 * The sweep runs per rendered page AND again on focus, over elements it has already processed. Its
 * rename map is keyed by the ORIGINAL name, so re-sweeping a widget whose name is now `pdfField-N`
 * finds no entry and mints another one — renaming it out of its own field group. For a radio group
 * that means the browser stops uncticking its siblings and pdf.js stops propagating to them, so two
 * options read as selected in the DOM and in the storage a save serialises from.
 */
const HARDENED_ATTRIBUTE = "data-filen-hardened"

export function createFormWidgetScope(): FormWidgetScope {
	return {
		names: new Map<string, string>(),
		nextId: 0
	}
}

export function hardenFormWidgets(root: ParentNode, scope: FormWidgetScope): void {
	const widgets = root.querySelectorAll("input, textarea, select")

	for (let index = 0; index < widgets.length; index++) {
		const widget = widgets[index]

		if (!(widget instanceof HTMLInputElement) && !(widget instanceof HTMLTextAreaElement) && !(widget instanceof HTMLSelectElement)) {
			continue
		}

		// Idempotent by construction. A re-rendered page builds fresh elements, which arrive unmarked
		// and get hardened; an element already seen is left exactly as it was.
		if (widget.hasAttribute(HARDENED_ATTRIBUTE)) {
			continue
		}

		widget.setAttribute(HARDENED_ATTRIBUTE, "")

		// Set as a property, not an attribute: the property is what the engine and the platform's
		// autofill actually consult.
		if (widget instanceof HTMLInputElement && widget.type === "password") {
			widget.type = "text"
		}

		widget.setAttribute("autocomplete", "off")
		widget.setAttribute("data-lpignore", "true")

		if (widget.name) {
			// Same original name -> same replacement, for the life of the document. That is what keeps a
			// radio group grouped, and what stops two pages minting the same name for different fields.
			const replacement = scope.names.get(widget.name) ?? `pdfField-${scope.names.size}`

			scope.names.set(widget.name, replacement)

			widget.name = replacement
		}

		if (widget.id) {
			widget.id = `pdfFieldId-${scope.nextId}`

			scope.nextId++
		}
	}
}
