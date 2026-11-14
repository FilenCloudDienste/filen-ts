import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"

// What a form asks before it is saved: a hybrid form loses its XFA data on its first save (asked, then removed as one
// undoable step, so the AcroForm entries are what every viewer shows), and required fields still empty are warned
// about (the save goes ahead; the fields are marked). The answer may turn a Save into a Save as copy or cancel it.

export type PdfFormSaveChoice = "version" | "copy" | "cancel"

export interface PdfFormSaveDeps {
	// The XFA confirm: Save, Save as copy or Cancel.
	readonly askXfa: () => Promise<PdfFormSaveChoice>
	// Required fields are still empty: `count` of them.
	readonly warnRequired: (count: number) => void
}

export async function pdfFormSaveGate(
	session: PdfEditSessionModel,
	requested: "version" | "copy",
	deps: PdfFormSaveDeps
): Promise<PdfFormSaveChoice> {
	let choice: PdfFormSaveChoice = requested

	if (session.getSnapshot().state.form.xfa === "hybrid") {
		choice = await deps.askXfa()

		if (choice === "cancel") return choice

		await session.dispatch("forms.removeXfa", {})
	}

	if (session.getSnapshot().state.form.fields > 0) {
		const required = await session.engine.call("requiredFields", {})

		if (required.count > 0) deps.warnRequired(required.count)
	}

	return choice
}
