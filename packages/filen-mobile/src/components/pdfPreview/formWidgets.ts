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
export function hardenFormWidgets(root: ParentNode): void {
	const widgets = root.querySelectorAll("input, textarea, select")
	// Original name -> opaque replacement. Radio buttons are grouped BY name, so replacing each with a
	// per-element index would split every group into single-option radios that can all be selected at
	// once. Mapping preserves whatever grouping the document intended while still removing the name a
	// platform's autofill heuristics would match on.
	const names = new Map<string, string>()

	for (let index = 0; index < widgets.length; index++) {
		const widget = widgets[index]

		if (!(widget instanceof HTMLInputElement) && !(widget instanceof HTMLTextAreaElement) && !(widget instanceof HTMLSelectElement)) {
			continue
		}

		// Set as a property, not an attribute: the property is what the engine and the platform's
		// autofill actually consult.
		if (widget instanceof HTMLInputElement && widget.type === "password") {
			widget.type = "text"
		}

		widget.setAttribute("autocomplete", "off")
		widget.setAttribute("data-lpignore", "true")

		if (widget.name) {
			const replacement = names.get(widget.name) ?? `pdfField-${names.size}`

			names.set(widget.name, replacement)

			widget.name = replacement
		}

		if (widget.id) {
			widget.id = `pdfField-${index}`
		}
	}
}
