import type { Transaction } from "prosemirror-state"
import type { XmlDocument } from "@filen/office/core/xml"
import { bytesSource } from "@filen/office/core/opc"
import {
	Region,
	layoutDocument,
	openDocxPackage,
	type DocumentLayout,
	type DocxPackage,
	type PageDisplayList
} from "@filen/office/core/docx"
import { DocxEditorSession, openDocxEditContext, type DocxEditContext } from "@filen/office/core/docx/edit"
import { DocumentEdits, PageIndex, PagedEditor, StoryEdits, type StoryChange } from "@filen/office/core/docx/paged"
import { saveDocx, writerProof } from "@filen/office/core/docx/write"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FragmentKind,
	HitTester,
	LINE_FLOATS,
	LINE_INTS,
	LineInt
} from "@filen/office/core/text"
import { HmtxMeasurer, LAYOUT_DATE, layOut, loadDocx } from "./layoutFixtures"

async function partXml(pkg: DocxPackage, kind: string): Promise<XmlDocument | undefined> {
	const name = pkg.part(kind)

	return name === undefined || !pkg.has(name) ? undefined : pkg.xml(name)
}

// An editing session over a laid-out document with the paged layout following each edit incrementally,
// and a digest to compare its pages with a fresh layout of the saved file.

export interface EditedLayout {
	readonly pkg: DocxPackage
	readonly context: DocxEditContext
	readonly session: DocxEditorSession
	readonly edits: DocumentEdits
	readonly story: StoryEdits
	readonly layout: DocumentLayout
	readonly index: PageIndex
	// Restart page and pages laid out by the last edit.
	readonly last: { restart: number; laidOut: number; resyncedAt: number }
	// Applies `tr` and lays the document out again for it.
	edit(tr: Transaction | ((session: DocxEditorSession) => boolean)): Promise<boolean>
	save(): Promise<Uint8Array>
}

export async function editedLayout(bytes: Uint8Array): Promise<EditedLayout> {
	const loaded = await loadDocx(bytes)
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const pkg = opened.package
	const context = await openDocxEditContext(pkg, loaded.model, { store: loaded.store, resolver: loaded.resolver })
	const edits = new DocumentEdits(loaded.model)

	edits.define({ context, styles: await partXml(pkg, "styles"), numbering: await partXml(pkg, "numbering") })
	const layout = layoutDocument(edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
		store: loaded.store,
		sliceMs: Infinity,
		recordMaps: true,
		date: LAYOUT_DATE,
		edits
	})

	await layout.done

	const session = new DocxEditorSession(context, { proof: writerProof(context) })
	const story = new StoryEdits(edits, session.story, session.state.doc, context)
	const index = new PageIndex(story, Region.BODY)
	const last = { restart: -1, laidOut: 0, resyncedAt: -1 }
	let pending: StoryChange | undefined

	for (const page of layout.pages) index.index(page)

	session.onApplied(transactions => {
		const planned = edits.plan(context.newLists, context.newStyles)

		if (planned !== undefined) layout.redefine(planned.styles, planned.numbering)

		const change = story.applyAll(transactions)

		if (change === undefined) return

		pending =
			pending === undefined
				? change
				: {
						dirty: pending.dirty.concat(change.dirty),
						replaced: pending.replaced.concat(change.replaced),
						around: pending.around.concat(change.around),
						whole: pending.whole || change.whole
					}
	})

	const changed = new Set<number>()

	layout.subscribe(event => {
		if (event.final) return

		for (let page = event.from; page < event.to; page++) changed.add(page)
	})

	const relayout = async (change: StoryChange): Promise<void> => {
		const first = change.whole ? 0 : index.restartPage([...change.replaced, ...change.around], page => layout.keepFrom(page))
		const restart = layout.beginEdit(first < 0 ? 0 : first, change.dirty)

		changed.clear()

		await finishLayout(layout)

		last.resyncedAt = layout.resyncedAt

		// Pages kept from before show old page numbers or counts until refreshed (a view does it when it shows
		// them); the comparison wants every page current.
		for (const page of [...layout.stale].sort((a, b) => a - b)) {
			const result = layout.stale.has(page) ? layout.refresh(page) : "done"

			if (result !== "done") {
				layout.beginEdit(page, result === "numbers" ? [] : undefined)

				await finishLayout(layout)
			}

			changed.add(page)
		}

		index.truncate(layout.pages.length)

		for (const page of changed) {
			const list = layout.pages[page]

			if (list !== undefined) index.index(list)
		}

		last.restart = restart
		last.laidOut = changed.size
	}

	return {
		pkg,
		context,
		session,
		edits,
		story,
		layout,
		index,
		last,
		async edit(tr) {
			const applied = typeof tr === "function" ? tr(session) : session.dispatch(tr)
			const change = pending

			pending = undefined

			if (change !== undefined) await relayout(change)

			return applied
		},
		async save() {
			const result = await saveDocx({ pkg, context, sessions: [session] })

			if (result.bytes === undefined) throw new Error("no bytes")

			return result.bytes
		}
	}
}

// Every page's lines (geometry, flags, text) and fragments (geometry, text range, the style's font and
// size): two layouts of the same text agree whatever parts and items their sources came from.
export function pageDigest(layout: DocumentLayout): string[] {
	return layout.pages.map(page => digestPage(layout, page))
}

function round(value: number | undefined): number {
	return Math.round((value ?? 0) * 100) / 100
}

function digestPage(layout: DocumentLayout, page: PageDisplayList): string {
	const text = page.text
	const out: string[] = [`${page.number} ${round(page.width)}x${round(page.height)} lines ${text.lineCount}`]

	for (let line = 0; line < text.lineCount; line++) {
		const f = line * LINE_FLOATS
		const i = line * LINE_INTS
		const source = text.lineInts[i + LineInt.SOURCE] ?? -1
		const content = page.sourceTexts[source] ?? ""
		const start = text.lineInts[i + LineInt.TEXT_START] ?? 0
		const end = text.lineInts[i + LineInt.TEXT_END] ?? 0
		const parts = [
			round(text.lineFloats[f]),
			round(text.lineFloats[f + 1]),
			round(text.lineFloats[f + 2]),
			round(text.lineFloats[f + 3]),
			round(text.lineFloats[f + 4]),
			text.lineInts[i + LineInt.FLAGS] ?? 0,
			page.sourceRegion(source),
			JSON.stringify(content.slice(start, end))
		]
		const first = text.lineInts[i + LineInt.FIRST_FRAGMENT] ?? 0
		const count = text.lineInts[i + LineInt.FRAGMENT_COUNT] ?? 0

		for (let k = first; k < first + count; k++) {
			const style = layout.styles.get(text.fragmentInts[k * FRAGMENT_INTS + 2] ?? 0)
			const info = text.fragmentInts[k * FRAGMENT_INTS + 3] ?? 0

			parts.push(
				`[${round(text.fragmentFloats[k * FRAGMENT_FLOATS])} ${round(text.fragmentFloats[k * FRAGMENT_FLOATS + 1])} ${
					(text.fragmentInts[k * FRAGMENT_INTS] ?? 0) - start
				}-${(text.fragmentInts[k * FRAGMENT_INTS + 1] ?? 0) - start} ${style.font.family}:${style.font.weight}:${String(style.font.italic)}/${style.size} ${info} ${
					(info & FRAGMENT_KIND_MASK) === FragmentKind.TAB ? (text.fragmentInts[k * FRAGMENT_INTS + 4] ?? 0) : ""
				}]`
			)
		}

		out.push(parts.join(" "))
	}

	return out.join("\n")
}

// A fresh layout of `bytes` (what was saved), digested.
export async function savedDigest(bytes: Uint8Array): Promise<string[]> {
	return pageDigest(await layOut(bytes, { date: LAYOUT_DATE }))
}

// A paged editor over a laid-out document, measured with the test fonts' metrics.
// `budgetMs`: how long an edit lays out in its own task (the rest continues in slices).
export async function pagedEditor(
	bytes: Uint8Array,
	budgetMs = Infinity
): Promise<{ editor: PagedEditor; pkg: DocxPackage; context: DocxEditContext }> {
	const loaded = await loadDocx(bytes)
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const context = await openDocxEditContext(opened.package, loaded.model, { store: loaded.store, resolver: loaded.resolver })
	const edits = new DocumentEdits(loaded.model)

	edits.define({ context, styles: await partXml(opened.package, "styles"), numbering: await partXml(opened.package, "numbering") })
	const layout = layoutDocument(edits.model, loaded.resolver, loaded.fonts, new HmtxMeasurer(), {
		store: loaded.store,
		sliceMs: Infinity,
		recordMaps: true,
		date: LAYOUT_DATE,
		edits
	})

	await layout.done

	const editor = new PagedEditor({
		session: new DocxEditorSession(context),
		edits,
		layout,
		tester: new HitTester(layout.styles),
		options: { budgetMs }
	})

	return { editor, pkg: opened.package, context }
}

// Lays the layout out to the end, loading fonts as it asks; throws rather than spin when it never ends.
export async function finishLayout(layout: DocumentLayout): Promise<void> {
	for (let round = 0; round < 10_000; round++) {
		const result = layout.advance(Infinity)

		if (result === "done") return
		if (result === "fonts") await layout.prepareFonts()
	}

	throw new Error("Layout did not finish")
}

// Lays out what edits left for later and brings every page up to date, synchronously.
export async function settleAll(editor: PagedEditor): Promise<void> {
	const layout = editor.layout

	for (let round = 0; round < 100; round++) {
		await finishLayout(layout)

		await Promise.resolve()
		editor.setVisible(0, layout.pages.length - 1)

		if (layout.final && layout.stale.size === 0) {
			await Promise.resolve()

			return
		}
	}

	throw new Error("Pages did not settle")
}
