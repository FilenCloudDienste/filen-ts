import type * as Mupdf from "mupdf"

// How a logged step names the annotations it works on when it runs again (a redo the journal cannot make, a rebuild).
// The page names an annotation (or a widget) by its object number, which a run of the same steps does not reproduce:
// MuPDF never reuses a number an undo freed, and a save adds objects of its own. So the history logs an annotation by
// its /NM (ISO 32000-2 §12.5.2, unique on its page): one without, or sharing it with another on its page, gets a new
// one inside the step, logged with its place in the page's /Annots, where the step's run finds it again (the same
// steps on the same file build the same arrays) and names it alike. An annotation a step makes is named in the step
// too. A widget is never renamed (a signature that allows filling in the form allows nothing else on it): it is logged
// by its place alone.

export interface PdfStepKey {
	// The /NM of the annotation the step works on; null when it works on none, or on a widget.
	readonly target: string | null
	// Its place in its page's /Annots when the step ran, where a run again finds it (and names it `target`); null when
	// it is found by its own /NM.
	readonly at: number | null
	// The /NM given to the annotation the step made, null when it made none.
	created: string | null
}

function annots(document: Mupdf.PDFDocument, page: number): Mupdf.PDFObject | null {
	if (!Number.isInteger(page) || page < 0 || page >= document.countPages()) return null

	const array = document.findPage(page).get("Annots")

	return array.isArray() ? array : null
}

function nameOf(entry: Mupdf.PDFObject): string | null {
	const name = entry.get("NM")

	return name.isString() ? name.asString() : null
}

function newName(): string {
	return `filen-${globalThis.crypto.randomUUID()}`
}

// The key of the annotation `id` on `page` as the step about to run on it logs it (`widget`: by its place only), and
// what names it first (name(): inside the step's journal operation). Null when the page has no such annotation (the
// command's own check refuses it).
export function targetKey(
	document: Mupdf.PDFDocument,
	page: number,
	id: number,
	widget: boolean
): { readonly key: PdfStepKey; readonly name: () => void } | null {
	const array = annots(document, page)

	if (array === null) return null

	let index = -1
	const names = new Map<string, number>()

	for (let at = 0; at < array.length; at++) {
		const entry = array.get(at)
		const name = nameOf(entry)

		if (name !== null) names.set(name, (names.get(name) ?? 0) + 1)
		if (index === -1 && entry.isIndirect() && entry.asIndirect() === id) index = at
	}

	if (index === -1) return null
	if (widget) return { key: { target: null, at: index, created: null }, name: () => undefined }

	const entry = array.get(index)
	const own = nameOf(entry)

	if (own !== null && names.get(own) === 1) return { key: { target: own, at: null, created: null }, name: () => undefined }

	const name = newName()

	return {
		key: { target: name, at: index, created: null },
		name: () => {
			entry.put("NM", document.newString(name))
		}
	}
}

// The object number of the annotation `key` names on `page`, as the step runs again (naming it as the first run did),
// or null when it is not there.
export function resolveTarget(document: Mupdf.PDFDocument, page: number, key: PdfStepKey): number | null {
	const array = annots(document, page)

	if (array === null) return null

	if (key.target !== null) {
		for (let at = 0; at < array.length; at++) {
			const entry = array.get(at)

			if (entry.isIndirect() && nameOf(entry) === key.target) return entry.asIndirect()
		}
	}

	if (key.at === null || key.at >= array.length) return null

	const entry = array.get(key.at)

	if (!entry.isIndirect()) return null
	if (key.target !== null) entry.put("NM", document.newString(key.target))

	return entry.asIndirect()
}

// Names the annotation a step made (`name`, or a new one), inside the step; the name it has, null when it is not on
// its page.
export function nameCreated(
	document: Mupdf.PDFDocument,
	created: { readonly page: number; readonly id: number },
	name: string | null
): string | null {
	const array = annots(document, created.page)

	if (array === null) return null

	for (let at = 0; at < array.length; at++) {
		const entry = array.get(at)

		if (entry.isIndirect() && entry.asIndirect() === created.id) {
			const given = name ?? newName()

			entry.put("NM", document.newString(given))

			return given
		}
	}

	return null
}
