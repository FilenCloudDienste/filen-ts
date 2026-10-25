// @vitest-environment happy-dom

import { createElement, type ComponentType } from "react"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { transformFileSync } from "@babel/core"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// What a keystroke costs the toolbar, the review layer and the pages' overlays: nothing. The tests run uncompiled, so the editor's view and its toolbar
// are compiled here the way vite.config.ts compiles them (into a git-ignored directory inside the package);
// the toolbar and its formatting slot count their renders.

const { renders, hosts, compiledPath } = vi.hoisted(() => ({
	compiledPath: (name: string) => `${process.cwd()}/test-results/docx-compiled-${String(process.pid)}/${name}.jsx`,
	renders: { toolbar: 0, format: 0, reviewLayer: 0, pageOverlay: 0, handles: 0 },
	hosts: [] as DocxEditingHost[]
}))

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

vi.mock("@/features/preview/lib/docxEngine", () => ({ DOCX_FONT_URLS: {} }))
vi.mock("@/features/preview/lib/docxEditing", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/lib/docxEditing")>("@/features/preview/lib/docxEditing")
	const { inThreadEditingHost } = await vi.importActual<typeof import("@filen/office/dom/docx/editing")>("@filen/office/dom/docx/editing")
	const { prepareDocxSave, writerProof } =
		await vi.importActual<typeof import("@filen/office/core/docx/write")>("@filen/office/core/docx/write")

	return {
		...actual,
		docxEditingHost: () => {
			const host = inThreadEditingHost(
				() => ({
					fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
					replayFonts: false,
					fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
					measurer,
					yield: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
					sliceMs: 8
				}),
				{ proof: writerProof, writer: { prepare: prepareDocxSave } }
			)

			hosts.push(host)

			return host
		}
	}
})
vi.mock("@/features/spellcheck/lib/spellcheck", () => ({
	defaultSpellingLanguage: () => "en-US",
	documentSpellingChecker: {
		dictionaryFor: () => undefined,
		known: () => undefined,
		check: () => Promise.resolve(),
		suggest: () => Promise.resolve([]),
		addToDictionary: () => Promise.resolve(),
		subscribe: () => () => undefined
	}
}))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	saveOfficeAutosave: () => Promise.resolve(),
	useOfficeSettings: () => ({ authorName: null, autosave: false, loaded: true })
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
// The row is wide enough for every group (the formatting slot's pickers included).
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2400, height: 800 }) }))
vi.mock("@/features/preview/components/docxEditToolbar", async () => {
	const compiled = (await import(
		/* @vite-ignore */ compiledPath("docxEditToolbar")
	)) as typeof import("@/features/preview/components/docxEditToolbar")

	return {
		...compiled,
		DocxEditToolbar: (props: Parameters<typeof compiled.DocxEditToolbar>[0]) => {
			renders.toolbar++

			return compiled.DocxEditToolbar(props)
		}
	}
})
vi.mock("@/features/preview/components/docxFormatControls", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/components/docxFormatControls")>(
		"@/features/preview/components/docxFormatControls"
	)

	return {
		...actual,
		DocxFormatControls: (props: Parameters<typeof actual.DocxFormatControls>[0]) => {
			renders.format++

			return actual.DocxFormatControls(props)
		}
	}
})

vi.mock("@/features/preview/components/docxReviewLayer", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/components/docxReviewLayer")>(
		"@/features/preview/components/docxReviewLayer"
	)

	return {
		...actual,
		DocxReviewLayer: (props: Parameters<typeof actual.DocxReviewLayer>[0]) => {
			renders.reviewLayer++

			return actual.DocxReviewLayer(props)
		},
		DocxReviewPageOverlay: (props: Parameters<typeof actual.DocxReviewPageOverlay>[0]) => {
			renders.pageOverlay++

			return actual.DocxReviewPageOverlay(props)
		}
	}
})
vi.mock("@/features/preview/components/docxObjectHandles", async () => {
	const actual = await vi.importActual<typeof import("@/features/preview/components/docxObjectHandles")>(
		"@/features/preview/components/docxObjectHandles"
	)

	return {
		...actual,
		DocxObjectHandles: (props: Parameters<typeof actual.DocxObjectHandles>[0]) => {
			renders.handles++

			return actual.DocxObjectHandles(props)
		}
	}
})

registerAllActions()

const BYTES = new Uint8Array(readFileSync(join(process.cwd(), "../filen-office/src/tests/fixtures/01-plain.docx")))

let DocxEditView: ComponentType<import("@/features/preview/components/docxEditor").DocxEditViewProps>

beforeAll(async () => {
	mkdirSync(dirname(compiledPath("x")), { recursive: true })

	for (const [source, name] of [
		["src/features/preview/components/docxEditor.tsx", "docxEditor"],
		["src/features/preview/components/docxEditToolbar.tsx", "docxEditToolbar"]
	] as const) {
		const result = transformFileSync(source, {
			babelrc: false,
			configFile: false,
			presets: ["@babel/preset-typescript"],
			plugins: ["@babel/plugin-syntax-jsx", "babel-plugin-react-compiler"]
		})

		writeFileSync(compiledPath(name), result?.code ?? "")
	}

	DocxEditView = (
		(await import(/* @vite-ignore */ compiledPath("docxEditor"))) as typeof import("@/features/preview/components/docxEditor")
	).DocxEditView
	// Compiling the view and the ribbon and importing them takes long on a loaded runner.
}, 60_000)

afterAll(() => {
	rmSync(dirname(compiledPath("x")), { recursive: true, force: true })
})

function typeAt(editor: PagedEditor, text: string): void {
	act(() => {
		editor.dispatch(editor.state.tr.insertText(text, editor.selection().from))
	})
}

describe("DocxEditView render counts", () => {
	it("re-renders neither the toolbar nor its formatting controls on a keystroke", async () => {
		render(
			createElement(DocxEditView, {
				bytes: BYTES,
				alt: "report.docx",
				writable: true,
				renamed: false,
				onDirtyChange: () => undefined,
				saveRef: { current: null },
				onAutosave: () => true,
				viewer: () => null
			})
		)

		const host = hosts.at(-1)

		if (host === undefined) {
			throw new Error("no editing host")
		}

		const editor = await act(() => host.editor)

		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Font" })).toBeTruthy()
		})
		act(() => {
			editor.selectParagraph(1)
		})
		// The first edit turns undo on: the toolbar shows that once.
		typeAt(editor, "a")
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		const before = { ...renders }

		typeAt(editor, "b")
		typeAt(editor, "c")
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		expect(editor.state.doc.textContent).toContain("bc")
		expect(renders.toolbar - before.toolbar).toBe(0)
		expect(renders.format - before.format).toBe(0)
		// Nor the review layer, nor any page's overlays (the pages lay out again and ask for them).
		expect(renders.reviewLayer - before.reviewLayer).toBe(0)
		expect(renders.pageOverlay - before.pageOverlay).toBe(0)
		expect(renders.handles - before.handles).toBe(0)
		expect(before.pageOverlay).toBeGreaterThan(0)
		expect(before.format).toBeGreaterThan(0)

		// What the toolbar shows changing does re-render it.
		act(() => {
			void editor.execute({ type: "format.bold" })
		})
		await waitFor(() => {
			expect(renders.toolbar).toBeGreaterThan(before.toolbar)
		})
	})
})
