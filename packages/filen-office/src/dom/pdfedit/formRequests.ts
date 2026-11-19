import { PdfEngineRefusal } from "./context"
import { missingRequiredFields } from "./fillSign"
import type { PdfRequestHandler } from "./requests"

// The form's requests beside its commands: the required fields still empty, read before a save to warn (a save is
// never refused for them). Only pages with fields are loaded.

export const FORM_REQUESTS: { readonly requiredFields: PdfRequestHandler<"requiredFields"> } = {
	requiredFields: context => {
		const { document, edit } = context.open()

		if (edit === null) throw new PdfEngineRefusal("badRequest", "the document is not open for editing")

		const missing = missingRequiredFields(document, pageObject => edit.pageOf(document, pageObject))
		const first = missing[0]

		return { value: { count: missing.length, first: first === undefined ? null : { page: first.page, widget: first.widget } } }
	}
}
