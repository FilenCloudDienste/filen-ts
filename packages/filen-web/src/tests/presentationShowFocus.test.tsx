// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useRef } from "react"
import i18n from "i18next"
import { slideRef } from "@filen/office/core/presentation"
import type { OpenInfo } from "@filen/office/dom/presentation"
import { IDLE_PRESENTATION, type PresentationDocument, type PresentationStore } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { slideShowGroups } from "@/features/presentation/components/ribbon/slideShow"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import "@/lib/i18n"

// Where focus goes when a show, or Set Up Slide Show, started from the Slide Show tab ends: More commands when it ran
// from the overflow (which closed), the command when it is still there, the slide when no command started it (a key).

const size = vi.hoisted(() => ({ width: 40 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set<string>(), refetch: () => Promise.resolve() })
}))
vi.mock("@/lib/media/fullscreen", () => ({ fullscreenSupported: () => false }))

const stage = vi.hoisted(() => ({ onEnd: (): void => undefined }))

vi.mock("@/features/presentation/components/slideshow/deckSlideShow", () => ({
	DeckSlideShow: (props: { onEnd: () => void }) => {
		stage.onEnd = props.onEnd

		return <div data-testid="stage" />
	}
}))

// The show asks for no full screen here; a test sets one to stand for the browser's.
let fullscreen: Element | null = null

Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen })

const { useDeckPresentation } = await import("@/features/presentation/hooks/useDeckPresentation")

const SLIDES = [0, 1].map(n => ({ ref: slideRef(256 + n), hidden: false }))
const INFO = { slides: SLIDES, size: { cx: 9144000, cy: 6858000 }, customShows: [], editable: true } as unknown as OpenInfo
const deck: PresentationDocument = { ...IDLE_PRESENTATION, status: "ready", slides: SLIDES, info: INFO }
const store = {} as PresentationStore

function Page({
	onShow = () => undefined,
	namesake = false,
	bare = false
}: {
	onShow?: (start: () => void) => void
	// A button outside the ribbon named as one of its commands.
	namesake?: boolean
	// The ribbon without its command row.
	bare?: boolean
}) {
	const focusSlide = useRef<HTMLElement | null>(null)
	const show = useDeckPresentation({ store, deck, index: 0, go: () => undefined, focusSlide })
	const scope = {
		editor: { store, current: 0, document: { slides: SLIDES, info: INFO } },
		view: { startShowFrom: show.startShowFrom }
	} as unknown as PresentationEditorScope

	onShow(show.startShow)

	return (
		<PresentationEditorContext value={scope}>
			{namesake ? (
				<button
					type="button"
					aria-label="From Current Slide"
				/>
			) : null}
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "slideShow", label: "Slide Show" }]}
				tab="slideShow"
				onTab={() => undefined}
				file={null}
				replacement={bare ? <span /> : undefined}
				groups={slideShowGroups({ editable: true, phone: true, selection: new Set(), t: i18n.t.bind(i18n) })}
			/>
			<div
				ref={element => {
					focusSlide.current = element
				}}
				tabIndex={-1}
				aria-label="Slide"
			/>
			{show.layer}
		</PresentationEditorContext>
	)
}

async function settled(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => requestAnimationFrame(resolve))
		await new Promise(resolve => requestAnimationFrame(resolve))
	})
}

async function endShow(): Promise<void> {
	await screen.findByTestId("stage")
	act(() => {
		stage.onEnd()
	})
	await waitFor(() => {
		expect(screen.queryByTestId("stage")).toBeNull()
	})
	await settled()
}

async function fromOverflow(name: string): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "More commands" }))
	fireEvent.click(await screen.findByRole("button", { name }))
	await waitFor(() => {
		expect(screen.queryByRole("button", { name })).toBeNull()
	})
}

afterEach(() => {
	fullscreen = null
	size.width = 40
	cleanup()
})

describe("focus after a show started from the Slide Show tab", () => {
	it("goes to More commands when the show ran from the overflow", async () => {
		render(<Page />)

		await fromOverflow("From Beginning")
		await endShow()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})

	it("goes to More commands when the ribbon rendered it again during the show (full screen refits the ribbon)", async () => {
		const rendered = render(<Page />)

		await fromOverflow("From Beginning")

		const before = screen.getByRole("button", { name: "More commands" })

		// Wide in full screen: every command fits and More commands goes; narrow again after it.
		size.width = 3000
		rendered.rerender(<Page />)
		expect(screen.queryByRole("button", { name: "More commands" })).toBeNull()
		size.width = 40
		rendered.rerender(<Page />)
		await endShow()

		const after = screen.getByRole("button", { name: "More commands" })

		expect(after).not.toBe(before)
		expect(document.activeElement).toBe(after)
	})

	it("waits for full screen to be left before it gives focus back", async () => {
		render(<Page />)

		await fromOverflow("From Beginning")
		fullscreen = document.documentElement
		await endShow()
		expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "More commands" }))

		fullscreen = null
		act(() => {
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		await settled()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})

	it("puts focus back by the rule when the ribbon refits after it was given back", async () => {
		size.width = 3000
		const rendered = render(<Page />)

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "From Beginning" }))
		await endShow()
		expect(document.activeElement?.getAttribute("aria-label")).toBe("From Beginning")

		// The page narrows: the command goes under More commands and its focus with it.
		size.width = 40
		rendered.rerender(<Page />)
		expect(screen.queryByRole("button", { name: "From Beginning" })).toBeNull()
		await settled()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})

	it("moves focus from the slide to the command once the ribbon shows it again", async () => {
		size.width = 3000
		const rendered = render(<Page />)

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "From Beginning" }))
		await screen.findByTestId("stage")
		// The ribbon shows no commands as the show ends: focus falls back to the slide.
		rendered.rerender(<Page bare />)
		await endShow()
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Slide")

		rendered.rerender(<Page />)
		await settled()

		expect(document.activeElement).toBe(
			within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "From Beginning" })
		)
	})

	it("looks a re-rendered command up in the ribbon only", async () => {
		size.width = 3000
		const rendered = render(<Page namesake />)
		const ribbon = within(screen.getByRole("toolbar", { name: "Commands" }))

		fireEvent.click(ribbon.getByRole("button", { name: "From Current Slide" }))
		await screen.findByTestId("stage")
		size.width = 40
		rendered.rerender(<Page namesake />)
		size.width = 3000
		rendered.rerender(<Page namesake />)
		await endShow()

		expect(document.activeElement).toBe(
			within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "From Current Slide" })
		)
	})

	it("goes back to the command when it is still there", async () => {
		size.width = 3000
		render(<Page />)

		const opener = within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "From Current Slide" })

		fireEvent.click(opener)
		await endShow()

		expect(document.activeElement).toBe(opener)
	})

	it("goes to the slide when a key started the show", async () => {
		let start: () => void = () => undefined

		render(
			<Page
				onShow={value => {
					start = value
				}}
			/>
		)
		act(() => {
			start()
		})
		await endShow()

		expect(document.activeElement?.getAttribute("aria-label")).toBe("Slide")
	})

	it("goes to More commands when Set Up Slide Show, opened from the overflow, closes", async () => {
		render(<Page />)

		await fromOverflow("Set up slide show")

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Set up slide show" })).toBeNull()
		})
		await settled()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})
})

describe("what the running show covers", () => {
	function InPreview({ onShow }: { onShow: (start: () => void) => void }) {
		return (
			<div
				role="dialog"
				aria-label="Preview"
			>
				<button
					type="button"
					aria-label="Close preview"
				/>
				<div
					inert
					data-testid="already-inert"
				/>
				<div>
					<Page onShow={onShow} />
				</div>
			</div>
		)
	}

	it("is out of reach while the show runs, up to the preview's dialog, and comes back as it ends", async () => {
		let start: () => void = () => undefined

		render(
			<InPreview
				onShow={value => {
					start = value
				}}
			/>
		)
		act(() => {
			start()
		})

		const stage = await screen.findByTestId("stage")
		const close = screen.getByRole("button", { name: "Close preview", hidden: true })

		expect(close.closest("[inert]")).not.toBeNull()
		expect(screen.getByRole("toolbar", { name: "Commands", hidden: true }).closest("[inert]")).not.toBeNull()
		expect(screen.getByLabelText("Slide").closest("[inert]")).not.toBeNull()
		expect(stage.closest("[inert]")).toBeNull()
		expect(screen.getByRole("dialog", { name: "Preview" }).hasAttribute("inert")).toBe(false)

		await endShow()

		expect(close.closest("[inert]")).toBeNull()
		expect(screen.getByRole("toolbar", { name: "Commands" }).closest("[inert]")).toBeNull()
		expect(screen.getByTestId("already-inert").hasAttribute("inert")).toBe(true)
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Slide")
	})
})
