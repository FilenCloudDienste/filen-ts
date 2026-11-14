/**
 * What every form control showing a document's own field must carry, without touching the DOM: the
 * password-manager opt-outs, the idempotency marker and opaque per-document names. Used by the DOM sweep over
 * pdf.js widgets (formHardening.ts, mobile) and by controls the web PDF editor builds itself (@filen/office
 * dom/pdf/formWidgets.ts).
 *
 * A document's field names never reach the DOM: autofill heuristics are driven by attribute names, so a
 * document-chosen `name="password"` would be a hint that a hostile document can use to have the platform's
 * password manager offer the user's real Filen credential to a box it drew.
 */

/**
 * The opt-outs the common password-manager extensions read: 1Password, LastPass, Bitwarden, Dashlane, Proton Pass.
 * For any field that holds a secret which is not the user's Filen login, or text a document chose.
 */
export const PASSWORD_MANAGER_OPT_OUTS = {
	"data-1p-ignore": "true",
	"data-lpignore": "true",
	"data-bwignore": "true",
	"data-form-type": "other",
	"data-protonpass-ignore": "true"
} as const

/**
 * Marks a widget that has already been neutralised.
 *
 * The sweep runs per rendered page AND again on focus, over elements it has already processed. Its
 * rename map is keyed by the ORIGINAL name, so re-sweeping a widget whose name is now `pdfField-N`
 * finds no entry and mints another one — renaming it out of its own field group. For a radio group
 * that means the browser stops uncticking its siblings and pdf.js stops propagating to them, so two
 * options read as selected in the DOM and in the storage a save serialises from.
 */
export const HARDENED_ATTRIBUTE = "data-filen-hardened"

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

export function createFormWidgetScope(): FormWidgetScope {
	return {
		names: new Map<string, string>(),
		nextId: 0
	}
}

/**
 * The opaque name standing in for a document's field name: the same for one original name for the life of the
 * scope (a radio group stays grouped, across pages too), never shared by two different ones.
 */
export function opaqueFieldName(scope: FormWidgetScope, original: string): string {
	const replacement = scope.names.get(original) ?? `pdfField-${String(scope.names.size)}`

	scope.names.set(original, replacement)

	return replacement
}

/** A fresh element id, unique within the scope. */
export function opaqueFieldId(scope: FormWidgetScope): string {
	const id = `pdfFieldId-${String(scope.nextId)}`

	scope.nextId++

	return id
}
