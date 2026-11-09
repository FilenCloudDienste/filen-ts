import { bytesSource } from "@filen/office/core/opc"
import {
	PropertyResolver,
	PropsStore,
	buildDocxModel,
	layoutDocument,
	openDocxPackage,
	parseStyles,
	styleSettings,
	type DocumentLayout,
	type DocxPackage,
	type FontSource
} from "@filen/office/core/docx"
import { DocxEditorSession, openDocxEditContext, type DocxEditContext } from "@filen/office/core/docx/edit"
import { DocumentEdits, PagedEditor } from "@filen/office/core/docx/paged"
import type { ResolvedFont } from "@filen/office/core/fonts"
import { HitTester, type TextMeasurer } from "@filen/office/core/text"

// A paged editor for DOM tests (no font files): every font measures half its size per character.

const METRICS = {
	unitsPerEm: 1000,
	hheaAscender: 800,
	hheaDescender: -200,
	hheaLineGap: 0,
	typoAscender: 800,
	typoDescender: -200,
	typoLineGap: 0,
	winAscent: 800,
	winDescent: 200,
	useTypoMetrics: false
}

const FONTS: FontSource = {
	prepare: () => Promise.resolve(),
	resolve: request =>
		({
			id: (request.bold ? 2 : 1) + (request.italic ? 2 : 0),
			family: null,
			generic: "sans-serif",
			weight: request.bold ? 700 : 400,
			italic: request.italic,
			scale: 1,
			widthScale: 1,
			metrics: METRICS,
			metricsBasis: "original",
			source: "generic"
		}) satisfies ResolvedFont
}

function sizeOf(font: string): number {
	return Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16)
}

const MEASURER: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = sizeOf(font)

		for (let k = 0; k < count; k++) widths[k] = (texts[k]?.length ?? 0) * size * 0.5
	},
	fontExtents: font => ({ ascent: sizeOf(font) * 0.8, descent: sizeOf(font) * 0.2 })
}

export async function pagedEditor(
	bytes: Uint8Array
): Promise<{ editor: PagedEditor; layout: DocumentLayout; pkg: DocxPackage; context: DocxEditContext }> {
	const opened = await openDocxPackage(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const pkg = opened.package
	const model = await buildDocxModel(pkg)
	const store = new PropsStore()
	const stylesName = pkg.part("styles")
	const styles = stylesName === undefined ? undefined : parseStyles(await pkg.xml(stylesName), store)
	const resolver = new PropertyResolver({ styles, numbering: undefined, theme: undefined, settings: styleSettings(model.settings) })
	const context = await openDocxEditContext(pkg, model, { store, resolver, ...(styles === undefined ? {} : { styles }) })
	const edits = new DocumentEdits(model)
	const layout = layoutDocument(edits.model, resolver, FONTS, MEASURER, { store, sliceMs: Infinity, recordMaps: true, edits })

	await layout.done

	const editor = new PagedEditor({
		session: new DocxEditorSession(context),
		edits,
		layout,
		tester: new HitTester(layout.styles),
		options: { budgetMs: Infinity }
	})

	return { editor, layout, pkg, context }
}

// Lays out what an edit left for later, synchronously.
export async function settle(editor: PagedEditor): Promise<void> {
	for (let round = 0; round < 1000 && !editor.layout.final; round++) {
		if (editor.layout.advance(Infinity) === "fonts") await editor.layout.prepareFonts()
	}

	await Promise.resolve()
}
