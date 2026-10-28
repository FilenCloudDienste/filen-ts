// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render as renderUi, screen, waitFor } from "@testing-library/react"
import type { ReactElement } from "react"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import type { PresentationEvent, PresentationOpenOptions, PresentationSessionApi, SourceSpec } from "@filen/office/dom/presentation"
import type { PresentationConnection } from "@filen/office/react/presentation"
import "@/lib/i18n"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import { presentationVerdict } from "@/features/presentation/lib/fileKind"

// The viewer around an open deck: a rename or a favourite (a new item for the same file) keeps the deck's range
// port; a wrong password is said so in the prompt; arrows in an open menu stay the menu's.

const { sdk, engine } = vi.hoisted(() => ({
	sdk: {
		openRangePort: vi.fn(() => Promise.resolve()),
		openLinkedRangePortAnon: vi.fn(() => Promise.resolve()),
		cancelPreviewDownload: vi.fn(() => Promise.resolve())
	},
	engine: {
		listener: null as ((event: PresentationEvent) => void) | null,
		opens: [] as { source: SourceSpec; options: PresentationOpenOptions }[],
		unlocks: [] as string[]
	}
}))

vi.mock("comlink", () => ({ transfer: (value: unknown) => value }))
// Slides are not painted here: the tests look at the viewer around them.
vi.mock("@filen/office/react/presentation", async importOriginal => ({
	...(await importOriginal<typeof import("@filen/office/react/presentation")>()),
	paintSlide: (_render: unknown, context: { document: Document }) => ({
		root: context.document.createElement("div"),
		release: () => undefined
	})
}))
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
			render: () => new Promise(() => undefined),
			thumbnails: () => new Promise(() => undefined),
			image: () => Promise.resolve(null),
			close: () => undefined
		} as unknown as PresentationSessionApi

		return {
			session,
			unlock: password => {
				engine.unlocks.push(password)
			},
			dispose: () => undefined
		}
	}
}))

const { PresentationViewer } = await import("@/features/presentation/components/presentationViewer")
const { registerAllActions } = await import("@/lib/keymap/actions")

// The viewer binds registered actions (Mod+P).
registerAllActions()

function render(ui: ReactElement) {
	return renderUi(ui, { wrapper: queryClientWrapper(createTestQueryClient()) })
}

const UUID = "aaaaaaaa-0000-0000-0000-000000000077"

function deckItem(name = "deck.pptx") {
	return linkedFileItem(name, {
		uuid: UUID,
		mime: { Decrypted: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
		size: 5000n
	})
}

function emit(event: PresentationEvent): Promise<void> {
	return act(async () => {
		engine.listener?.(event)
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

const opened: PresentationEvent = {
	type: "opened",
	info: {
		format: "pptx",
		variant: "pptx",
		slides: [
			{ ref: 1, hidden: false },
			{ ref: 2, hidden: false }
		] as never,
		size: { cx: 12_192_000, cy: 6_858_000 },
		notesSize: { cx: 6_858_000, cy: 9_144_000 },
		sections: [],
		customShows: [],
		protection: { writeProtected: false, encrypted: false },
		gate: [],
		editable: true,
		locks: 0,
		packageBytes: 5000,
		source: "range"
	}
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	engine.listener = null
	engine.opens = []
	engine.unlocks = []
})

describe("presentation viewer session", () => {
	it("keeps the deck's range port when the item is renamed or favourited", async () => {
		const view = render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit(opened)

		view.rerender(
			<PresentationViewer
				item={deckItem("renamed.pptx")}
				alt="renamed.pptx"
			/>
		)
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(sdk.cancelPreviewDownload).not.toHaveBeenCalled()
		expect(sdk.openRangePort).toHaveBeenCalledTimes(1)
		expect(engine.opens).toHaveLength(1)
	})

	it("says a password was wrong, in the prompt that stayed up while it was checked", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit({ type: "error", reason: "needsPassword", message: "" })

		const field = await screen.findByLabelText("Password")

		fireEvent.change(field, { target: { value: "nope" } })
		fireEvent.click(screen.getByRole("button", { name: "Open" }))

		await waitFor(() => {
			expect(engine.unlocks).toEqual(["nope"])
		})
		expect(screen.getByLabelText("Password")).toBeTruthy()

		await emit({ type: "error", reason: "wrongPassword", message: "" })

		expect(await screen.findByText("That password isn't right. Try again.")).toBeTruthy()
	})

	it("says a deck with no slides has none: a zero counter, a message on the stage, no notes or show", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit({ ...opened, info: { ...opened.info, slides: [] } })

		expect(screen.getByText("This presentation has no slides.")).toBeDefined()
		expect(screen.getByLabelText<HTMLInputElement>("Page number").value).toBe("0")
		expect(screen.queryByRole("img", { name: /Slide/u })).toBeNull()
		expect(screen.getByRole("button", { name: "Present" }).hasAttribute("disabled")).toBe(true)
	})

	it("leaves arrow keys to an open menu", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit(opened)

		const region = screen.getByRole("region", { name: "deck.pptx" })
		const menu = document.createElement("div")

		menu.setAttribute("role", "menu")
		menu.setAttribute("data-open", "")
		region.append(menu)
		fireEvent.keyDown(menu, { key: "ArrowRight" })

		expect(screen.getByRole("group", { name: "Slide 1 of 2" })).toBeTruthy()

		menu.remove()
		fireEvent.keyDown(region, { key: "ArrowRight" })

		expect(screen.getByRole("group", { name: "Slide 2 of 2" })).toBeTruthy()
	})
})

describe("presentation refused actions", () => {
	it("says so for a moment when a refused action is clicked", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit(opened)
		await emit({
			type: "slides",
			final: true,
			renders: [
				{
					ref: 1,
					index: 0,
					revision: 0,
					hidden: false,
					background: { width: 960, height: 540, itemCount: 0 },
					layers: [
						{
							shape: { slide: 1, id: 2 },
							drawing: { width: 100, height: 50, itemCount: 0 },
							matrix: [1, 0, 0, 1, 10, 10],
							role: "shape",
							alt: "Run",
							actions: { click: { kind: "refused", what: "program" } }
						},
						{
							shape: { slide: 1, id: 3 },
							drawing: { width: 100, height: 50, itemCount: 0 },
							matrix: [1, 0, 0, 1, 200, 10],
							role: "shape",
							actions: { click: { kind: "media" } }
						}
					],
					notesText: "",
					animated: false
				} as never
			]
		})

		expect(screen.queryByText("This action can't run here.")).toBeNull()
		// Hotspots are named by the shape's alt text and what the action does, never by a bare shape id.
		expect(screen.getByRole("button", { name: "Play media" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "3" })).toBeNull()
		fireEvent.click(await screen.findByRole("button", { name: "Run, an action that can't run here" }))
		expect(screen.getByRole("status").textContent).toContain("This action can't run here.")
	})
})

describe("presentation worker failure", () => {
	it("says an open deck stopped working, not that it couldn't be opened", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit(opened)
		await emit({ type: "error", reason: "failed", message: "The presentation worker failed" })

		expect(screen.getByText("This presentation stopped working. Try opening it again.")).toBeTruthy()
		expect(screen.queryByText("This presentation couldn't be opened.")).toBeNull()
	})

	it("still says a deck that never opened couldn't be opened", async () => {
		render(
			<PresentationViewer
				item={deckItem()}
				alt="deck.pptx"
			/>
		)

		await waitFor(() => {
			expect(engine.opens).toHaveLength(1)
		})
		await emit({ type: "error", reason: "failed", message: "The presentation worker failed" })

		expect(screen.getByText("This presentation couldn't be opened.")).toBeTruthy()
	})
})

describe("presentation .pot verdict", () => {
	it("records no verdict for a zip deck, so it opens as a deck again", () => {
		expect(presentationVerdict("pptx")).toBeUndefined()
		expect(presentationVerdict("odp")).toBeUndefined()
		expect(presentationVerdict("ppt")).toBe("presentationBinary")
		expect(presentationVerdict("text")).toBe("notPresentationBinary")
	})
})
