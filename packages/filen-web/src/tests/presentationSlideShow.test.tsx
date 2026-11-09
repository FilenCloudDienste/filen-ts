// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type ShowSettings } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo } from "@filen/office/dom/presentation"
import { DEFAULT_SHOW_OPTIONS, type PresentationDocument, type PresentationStore, type ShowFrom } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { slideShowGroups } from "@/features/presentation/components/ribbon/slideShow"
import {
	setUpForm,
	setUpOptions,
	setUpRangeValid,
	showSettingsOf,
	KIOSK_RESTART_MS
} from "@/features/presentation/components/slideshow/setUpDialog.logic"
import { SetUpShowHost } from "@/features/presentation/components/slideshow/setUpHost"
import { useChosenShowOptions } from "@/features/presentation/components/slideshow/showSettings"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import "@/lib/i18n"

// The Slide Show tab against a fake editor: the show starts from the beginning, from the slide in view, as a custom
// show or with the presenter view; Set Up Slide Show gives the options every later show uses (a kiosk loops, uses
// timings and restarts), and refuses a slide range outside the deck.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const SLIDES = [0, 1, 2, 3].map(n => ({ ref: slideRef(256 + n), hidden: false }))
const FIRST = slideRef(256)
const LAST = slideRef(259)

function info(customShows: OpenInfo["customShows"]): OpenInfo {
	return { slides: SLIDES, size: { cx: 9144000, cy: 6858000 }, customShows, editable: true } as unknown as OpenInfo
}

interface Mounted {
	readonly started: (ShowFrom | undefined)[]
	readonly presented: ShowFrom[]
	readonly store: PresentationStore
	readonly chosen: () => unknown
}

function mount(
	customShows: OpenInfo["customShows"],
	presenter = true,
	editing?: { readonly command: (op: DeckOp) => Promise<CommandResult>; readonly show?: ShowSettings; readonly format?: "odp" }
): Mounted {
	const started: (ShowFrom | undefined)[] = []
	const presented: ShowFrom[] = []
	const store = {} as PresentationStore
	let chosen: unknown

	function Probe() {
		chosen = useChosenShowOptions(store)

		return null
	}

	const scope = {
		editor: {
			store,
			current: 2,
			document: { slides: SLIDES, info: info(customShows) },
			...(editing === undefined ? {} : { editable: true, command: editing.command })
		},
		view: {
			startShowFrom: (from?: ShowFrom) => started.push(from),
			...(presenter ? { startPresenter: (from: ShowFrom) => presented.push(from) } : {})
		}
	} as unknown as PresentationEditorScope

	render(
		<PresentationEditorContext value={scope}>
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "slideShow", label: "Slide Show" }]}
				tab="slideShow"
				onTab={() => undefined}
				file={null}
				groups={slideShowGroups({ editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n) })}
			/>
			<SetUpShowHost
				store={store}
				deck={
					{
						slides: SLIDES,
						info: { ...info(customShows), show: editing?.show, format: editing?.format ?? "pptx" }
					} as unknown as PresentationDocument
				}
			/>
			<Probe />
		</PresentationEditorContext>
	)

	return { started, presented, store, chosen: () => chosen }
}

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

describe("presentation Slide Show tab", () => {
	it("starts the show from the beginning, from the slide in view, as a custom show and with the presenter view", async () => {
		const show = mount([{ id: 4, name: "Short version", slides: [LAST, FIRST] }])

		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Start slide show", "Set Up"])

		fireEvent.click(within(commands()).getByRole("button", { name: "From Beginning" }))
		fireEvent.click(within(commands()).getByRole("button", { name: "From Current Slide" }))
		fireEvent.click(within(commands()).getByRole("button", { name: "Custom slide show" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Short version" }))
		fireEvent.click(within(commands()).getByRole("button", { name: "Presenter View" }))

		// From Beginning: the show's own first slide (a Set Up range or custom show starts there).
		expect(show.started).toEqual([undefined, { index: 2 }, { customShow: 4 }])
		expect(show.presented).toEqual([{ index: 2 }])
	})

	it("says when the deck has no custom shows, and offers no presenter view without one", async () => {
		mount([], false)

		fireEvent.click(within(commands()).getByRole("button", { name: "Custom slide show" }))
		expect(await screen.findByText("This presentation has no custom shows.")).toBeTruthy()
		expect(within(commands()).queryByRole("button", { name: "Presenter View" })).toBeNull()
	})

	it("sets up a kiosk show for the shows that follow", async () => {
		const show = mount([])

		fireEvent.click(within(commands()).getByRole("button", { name: "Set up slide show" }))

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		fireEvent.click(within(dialog).getByRole("radio", { name: "Browsed at a kiosk" }))
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		expect(show.chosen()).toEqual({ kiosk: true, loop: true, useTimings: true, restartMs: KIOSK_RESTART_MS })
	})

	it("sets up a show browsed by an individual, in a window", async () => {
		const show = mount([])

		fireEvent.click(within(commands()).getByRole("button", { name: "Set up slide show" }))

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		fireEvent.click(within(dialog).getByRole("radio", { name: "Browsed by an individual (window)" }))
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		expect(show.chosen()).toEqual({ ...DEFAULT_SHOW_OPTIONS, browse: true })
	})
})

describe("Set Up Slide Show saved in the presentation", () => {
	it("saves the settings in an editable deck as one op, keeping what the dialog does not show", async () => {
		const ops: DeckOp[] = []
		const pen = { kind: "srgb", hex: "00B050", mods: [] } as unknown as NonNullable<ShowSettings["penColor"]>
		const show = mount([{ id: 4, name: "Short version", slides: [LAST, FIRST] }], true, {
			command: op => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: 2, dirty: true })
			},
			show: {
				kind: "browse",
				loop: false,
				showNarration: false,
				showAnimation: false,
				useTimings: true,
				range: { kind: "all" },
				penColor: pen
			}
		})

		fireEvent.click(within(commands()).getByRole("button", { name: "Set up slide show" }))

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		expect(within(dialog).getByText(/saved with the presentation/u)).toBeTruthy()
		fireEvent.click(within(dialog).getByRole("radio", { name: "From slide to slide" }))
		fireEvent.change(within(dialog).getByRole("textbox", { name: "From" }), { target: { value: "2" } })
		fireEvent.change(within(dialog).getByRole("textbox", { name: "To" }), { target: { value: "3" } })
		fireEvent.click(within(dialog).getByRole("radio", { name: "Manually" }))
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{
				family: "presentation",
				kind: "setShow",
				show: {
					kind: "browse",
					loop: false,
					showNarration: false,
					showAnimation: false,
					useTimings: false,
					range: { kind: "range", start: 2, end: 3 },
					penColor: pen
				}
			}
		])
		// The deck's own settings (now the file's) are what the shows use.
		expect(show.chosen()).toBeUndefined()
	})

	it("offers in an OpenDocument presentation only what it can save: no kiosk, a range to the last slide", async () => {
		const ops: DeckOp[] = []

		mount([], true, {
			command: op => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: 2, dirty: true })
			},
			format: "odp"
		})
		fireEvent.click(within(commands()).getByRole("button", { name: "Set up slide show" }))

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		expect(within(dialog).getByRole("radio", { name: "Browsed at a kiosk" }).getAttribute("aria-disabled")).toBe("true")
		expect(within(dialog).getByText(/OpenDocument presentations can't be saved as kiosk shows/u)).toBeTruthy()
		fireEvent.click(within(dialog).getByRole("radio", { name: "From slide to slide" }))

		const to = within(dialog).getByRole("textbox", { name: "To" })

		expect(to.hasAttribute("disabled")).toBe(true)
		expect((to as HTMLInputElement).value).toBe("4")
		fireEvent.change(within(dialog).getByRole("textbox", { name: "From" }), { target: { value: "2" } })
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
			await Promise.resolve()
		})
		expect(ops).toMatchObject([
			{ family: "presentation", kind: "setShow", show: { kind: "present", range: { kind: "range", start: 2, end: 4 } } }
		])
	})

	it("keeps a refused change for this session's shows", async () => {
		const show = mount([], true, { command: () => Promise.resolve({ ok: false, refusal: "locked" }) })

		fireEvent.click(within(commands()).getByRole("button", { name: "Set up slide show" }))

		const dialog = await screen.findByRole("dialog", { name: "Set up slide show" })

		fireEvent.click(within(dialog).getByRole("radio", { name: "Browsed at a kiosk" }))
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
			await Promise.resolve()
		})
		expect(show.chosen()).toEqual({ kiosk: true, loop: true, useTimings: true, restartMs: KIOSK_RESTART_MS })
	})

	it("gives a kiosk PowerPoint's restart, keeps the file's own, and leaves a kiosk for a speaker", () => {
		const kiosk = setUpOptions({ ...setUpForm(DEFAULT_SHOW_OPTIONS, 4), kiosk: true })
		const own: ShowSettings = {
			kind: "kiosk",
			loop: true,
			showNarration: true,
			showAnimation: true,
			useTimings: true,
			range: { kind: "all" },
			restartMs: 60_000
		}

		expect(showSettingsOf(kiosk, undefined)).toMatchObject({ kind: "kiosk", loop: true, restartMs: KIOSK_RESTART_MS })
		expect(showSettingsOf(kiosk, own).restartMs).toBe(60_000)
		expect(showSettingsOf(DEFAULT_SHOW_OPTIONS, own)).toEqual({
			kind: "present",
			loop: false,
			showNarration: true,
			showAnimation: true,
			useTimings: true,
			range: { kind: "all" }
		})
		expect(showSettingsOf({ ...DEFAULT_SHOW_OPTIONS, customShow: 7 }, undefined).range).toEqual({ kind: "customShow", id: 7 })
	})
})

describe("Set Up Slide Show form", () => {
	it("starts from the options in use and gives them back unchanged", () => {
		const options = { ...DEFAULT_SHOW_OPTIONS, range: { start: 2, end: 3 } }

		expect(setUpOptions(setUpForm(options, 4))).toEqual(options)
		expect(setUpOptions(setUpForm({ ...DEFAULT_SHOW_OPTIONS, customShow: 7 }, 4))).toEqual({ ...DEFAULT_SHOW_OPTIONS, customShow: 7 })
	})

	it("keeps the file's show without animation or narration and pen colour, which the form does not show", () => {
		const options = { ...DEFAULT_SHOW_OPTIONS, withoutAnimation: true, withoutNarration: true, penColor: "0070C0" }

		expect(setUpOptions({ ...setUpForm(options, 4), loop: true }, options)).toEqual({ ...options, loop: true })
	})

	it("keeps the file's narration setting as it was, adding none to a file that leaves it out", () => {
		const base: ShowSettings = { kind: "present", loop: false, showAnimation: true, useTimings: true, range: { kind: "all" } }

		expect(showSettingsOf(DEFAULT_SHOW_OPTIONS, base)).not.toHaveProperty("showNarration")
		expect(showSettingsOf(DEFAULT_SHOW_OPTIONS, undefined)).not.toHaveProperty("showNarration")
		expect(showSettingsOf(DEFAULT_SHOW_OPTIONS, { ...base, showNarration: false }).showNarration).toBe(false)
	})

	it("offers a file's range that ends past the last slide up to the last slide", () => {
		expect(setUpForm({ ...DEFAULT_SHOW_OPTIONS, range: { start: 2, end: 9 } }, 4)).toMatchObject({ from: "2", to: "4" })
	})

	it("accepts a slide range only within the deck, the first not after the last", () => {
		const form = setUpForm(DEFAULT_SHOW_OPTIONS, 4)

		expect(setUpRangeValid({ ...form, slides: "range", from: "2", to: "4" }, 4)).toBe(true)
		expect(setUpRangeValid({ ...form, slides: "range", from: "0", to: "4" }, 4)).toBe(false)
		expect(setUpRangeValid({ ...form, slides: "range", from: "3", to: "2" }, 4)).toBe(false)
		expect(setUpRangeValid({ ...form, slides: "range", from: "2", to: "5" }, 4)).toBe(false)
		expect(setUpRangeValid({ ...form, slides: "range", from: "x", to: "2" }, 4)).toBe(false)
	})
})
