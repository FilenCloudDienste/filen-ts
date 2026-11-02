// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render as renderUi, waitFor } from "@testing-library/react"
import { createRef, type ReactElement } from "react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type {
	PresentationEvent,
	PresentationOpenOptions,
	PresentationSessionApi,
	SlideRender,
	SourceSpec
} from "@filen/office/dom/presentation"
import type { PresentationConnection } from "@filen/office/react/presentation"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import type { PresentationSaveSource } from "@/features/drive/lib/previewSave.logic"
import type { PresentationEditing } from "@/features/presentation/hooks/usePresentationSession"

// The editor's empty-placeholder prompts: an editable deck opens with the locale's prompt strings, its slides are
// rendered asking for them and painted by the editor's painter; a deck opened view-only gets neither.

const { sdk, engine } = vi.hoisted(() => ({
	sdk: {
		openRangePort: vi.fn(() => Promise.resolve()),
		openLinkedRangePortAnon: vi.fn(() => Promise.resolve()),
		cancelPreviewDownload: vi.fn(() => Promise.resolve())
	},
	engine: {
		listener: null as ((event: PresentationEvent) => void) | null,
		opens: [] as { source: SourceSpec; options: PresentationOpenOptions }[],
		renders: [] as { refs: readonly number[]; options: unknown }[],
		painters: [] as string[]
	}
}))

vi.mock("comlink", () => ({ transfer: (value: unknown) => value }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => Promise.resolve(),
	useOfficeSettings: () => ({ loaded: true, autosave: true, authorName: null }),
	saveOfficeAutosave: () => Promise.resolve()
}))
// Slides are not painted here: the tests look at which painter the slide view was given.
vi.mock("@filen/office/react/presentation", async importOriginal => {
	const painter = (name: string) => (_render: unknown, context: { document: Document }) => {
		engine.painters.push(name)

		return { root: context.document.createElement("div"), release: () => undefined }
	}

	return {
		...(await importOriginal<typeof import("@filen/office/react/presentation")>()),
		paintSlide: painter("paintSlide"),
		paintEditorSlide: painter("paintEditorSlide")
	}
})
vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/features/presentation/lib/presentationEngine", () => ({
	presentationPool: {},
	connectPresentation: (
		_pool: unknown,
		source: SourceSpec,
		listener: (event: PresentationEvent) => void,
		options: PresentationOpenOptions
	): PresentationConnection => {
		engine.listener = listener
		engine.opens.push({ source, options })

		const session = {
			render: (refs: number[], renderOptions?: unknown) => {
				engine.renders.push({ refs, options: renderOptions })

				return Promise.resolve(refs.map(ref => slideRender(ref)))
			},
			thumbnails: () => new Promise(() => undefined),
			image: () => Promise.resolve(null),
			review: () => new Promise(() => undefined),
			close: () => undefined
		} as unknown as PresentationSessionApi

		return { session, unlock: () => undefined, dispose: () => undefined }
	}
}))

const { PresentationViewer } = await import("@/features/presentation/components/presentationViewer")

registerAllActions()

const UUID = "aaaaaaaa-0000-0000-0000-000000000079"
const SLIDES = [1, 2, 3, 4, 5]

function slideRender(ref: number): SlideRender {
	return {
		ref,
		index: ref - 1,
		revision: 0,
		hidden: false,
		background: { width: 960, height: 540, itemCount: 0 },
		layers: [],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

function editing(writable: boolean): PresentationEditing {
	return {
		writable,
		renamed: false,
		onDirtyChange: vi.fn(),
		saveRef: createRef<PresentationSaveSource | null>(),
		onSave: vi.fn(() => true),
		onAutosave: vi.fn(() => true)
	}
}

function render(ui: ReactElement) {
	return renderUi(ui, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

function emit(event: PresentationEvent): Promise<void> {
	return act(async () => {
		engine.listener?.(event)
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

async function open(writable: boolean): Promise<void> {
	render(
		<PresentationViewer
			item={linkedFileItem("deck.pptx", {
				uuid: UUID,
				mime: { Decrypted: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
				size: 5000n
			})}
			alt="deck.pptx"
			variant="drive"
			editing={editing(writable)}
		/>
	)
	await waitFor(() => {
		expect(engine.opens).toHaveLength(1)
	})
	await emit({
		type: "opened",
		info: {
			format: "pptx",
			variant: "pptx",
			slides: SLIDES.map(ref => ({ ref, hidden: false })) as never,
			layouts: [],
			size: { cx: 12_192_000, cy: 6_858_000 },
			notesSize: { cx: 6_858_000, cy: 9_144_000 },
			sections: [],
			customShows: [],
			protection: { writeProtected: false, encrypted: false },
			gate: [],
			editable: writable,
			locks: 0,
			packageBytes: 5000,
			source: "range"
		}
	})
	// The open window streams in; the rest of the render window is asked for after it.
	await emit({ type: "slides", renders: [1, 2, 3].map(slideRender), final: true })
	await waitFor(() => {
		expect(engine.renders.length).toBeGreaterThan(0)
	})
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	engine.listener = null
	engine.opens = []
	engine.renders = []
	engine.painters = []
})

describe("presentation editor placeholder prompts", () => {
	it("opens an editable deck with the locale's prompts, renders asking for them and paints with the editor's painter", async () => {
		await open(true)

		expect(engine.opens[0]?.options.prompts).toEqual({
			title: "Click to add title",
			subtitle: "Click to add subtitle",
			text: "Click to add text",
			picture: "Click to add picture",
			chart: "Click to add chart",
			table: "Click to add table",
			smartart: "Click to add SmartArt graphic",
			media: "Click to add media",
			clipArt: "Click to add clip art"
		})
		expect(engine.renders.every(call => (call.options as { prompts?: boolean } | undefined)?.prompts === true)).toBe(true)
		expect(engine.painters).toContain("paintEditorSlide")
		expect(engine.painters).not.toContain("paintSlide")
	})

	it("opens a deck it may not save without prompts, painted as the viewer paints", async () => {
		await open(false)

		expect(engine.opens[0]?.options.prompts).toBeUndefined()
		expect(engine.renders.every(call => call.options === undefined)).toBe(true)
		expect(engine.painters).toContain("paintSlide")
		expect(engine.painters).not.toContain("paintEditorSlide")
	})
})
