// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { TFunction } from "i18next"
import i18n from "i18next"
import {
	slideRef,
	type DeckOp,
	type ParaProps,
	type RunProps,
	type TextBody,
	type TextCommand,
	type Xfrm
} from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender, TextSeed } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, type TextEditController, type TextEditing } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { homeTextGroups, presentationTextLabels } from "@/features/presentation/components/ribbon/homeText"
import { linkOfChoice } from "@/features/presentation/components/ribbon/homeText.logic"
import type { PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import "@/lib/i18n"

// The Home tab's Font and Paragraph groups against a fake editor: with a body open each control runs its command on
// the body and shows the body's format; with text shapes selected and no body open a command formats their whole
// text (seed, command, setText per shape); nothing text-bearing selected turns them off; a narrow row collapses
// them; links take only http, https, mailto and slides.

const size = vi.hoisted(() => ({ width: 2400 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const EMU = 9525
const ref = slideRef(256)
const box = (x: number): Xfrm => ({ x: x * EMU, y: 0, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false })

function renderOf(roles: readonly SlideLayer["role"][]): SlideRender {
	const layers = roles.map(
		(role, index) =>
			({
				shape: { slide: ref, id: index + 2 },
				role,
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				box: { id: index + 2, xfrm: box(index * 150) }
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

const INFO = {
	slides: [
		{ ref, hidden: false },
		{ ref: slideRef(257), hidden: false }
	],
	customShows: [],
	editable: true
} as unknown as OpenInfo

const BODY: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Title", rPr: { lang: "en-GB" } }] }] }

interface Mounted {
	readonly ops: DeckOp[]
	readonly runs: TextCommand[]
	readonly bodyPrs: unknown[]
	readonly session: PresentationSessionApi
}

function fakeController(
	run: Partial<RunProps>,
	paragraph: Partial<ParaProps>,
	runs: TextCommand[],
	bodyPrs: unknown[]
): TextEditController {
	return {
		shape: { slide: ref, id: 2 },
		defaults: { paragraph: () => ({}) },
		format: () => ({ run, paragraph, bodyPr: {} }),
		run: (command: TextCommand) => {
			runs.push(command)

			return true
		},
		setBodyPr: (patch: unknown) => {
			bodyPrs.push(patch)
		},
		subscribe: () => () => undefined
	} as unknown as TextEditController
}

function mount(options: {
	readonly roles?: readonly SlideLayer["role"][]
	readonly selected?: readonly number[]
	readonly body?: { readonly run: Partial<RunProps>; readonly paragraph?: Partial<ParaProps> }
	readonly editable?: boolean
}): Mounted {
	const selection = createShapeSelection()
	const text: TextEditing = createTextEditing()
	const ops: DeckOp[] = []
	const runs: TextCommand[] = []
	const bodyPrs: unknown[] = []
	const command = (op: DeckOp): Promise<CommandResult> => {
		ops.push(op)

		return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
	}
	const session = {
		textSeed: (shape: { slide: number; id: number }) =>
			Promise.resolve({
				shape,
				revision: 1,
				body: BODY,
				resolved: [{ pPr: {}, runs: [{}] }],
				page: {},
				layout: {},
				matrix: []
			} as unknown as TextSeed),
		command
	} as unknown as PresentationSessionApi

	selection.show(ref)
	selection.set(options.selected ?? [])

	if (options.body !== undefined) text.set(fakeController(options.body.run, options.body.paragraph ?? {}, runs, bodyPrs))

	const context = {
		editable: options.editable ?? true,
		phone: false,
		selection: new Set(),
		t: i18n.t.bind(i18n) as TFunction,
		editor: { info: INFO, render: renderOf(options.roles ?? ["placeholder", "picture"]), selection, command, session, text }
	} as unknown as PresentationRibbonContext

	render(
		<OfficeRibbon
			label="Ribbon"
			commandsLabel="Commands"
			tabs={[{ id: "home", label: "Home" }]}
			tab="home"
			onTab={() => undefined}
			file={null}
			groups={homeTextGroups(context)}
		/>
	)

	return { ops, runs, bodyPrs, session }
}

afterEach(() => {
	cleanup()
	size.width = 2400
	vi.restoreAllMocks()
})

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

describe("presentation Home text groups", () => {
	it("shows Font and Paragraph, none without the editor's text or in a deck only viewed", () => {
		mount({ body: { run: {} } })

		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Font", "Paragraph"])
		expect(homeTextGroups({ editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n) })).toEqual([])
		cleanup()
		mount({ body: { run: {} }, editable: false })
		expect(screen.queryByRole("group", { name: "Font" })).toBeNull()
	})

	it("shows the open body's format and runs each command on it", () => {
		const mounted = mount({ body: { run: { b: true, u: "sng" }, paragraph: { algn: "ctr" } } })
		const bar = commands()

		expect(within(bar).getByRole("button", { name: "Bold" }).getAttribute("aria-pressed")).toBe("true")
		expect(within(bar).getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("false")
		expect(within(bar).getByRole("button", { name: "Underline" }).getAttribute("aria-pressed")).toBe("true")
		expect(within(bar).getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe("true")

		for (const name of ["Bold", "Italic", "Superscript", "Clear formatting", "Increase list level", "Justify"]) {
			fireEvent.click(within(bar).getByRole("button", { name }))
		}

		expect(mounted.runs).toHaveLength(6)
		expect(mounted.ops).toEqual([])
	})

	it("sets the box's text direction, anchoring and columns on the open body", async () => {
		const mounted = mount({ body: { run: {} } })

		fireEvent.click(within(commands()).getByRole("button", { name: "Columns" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "2 columns" }))
		expect(mounted.bodyPrs).toEqual([{ columns: 2 }])
	})

	it("formats the selected text shapes whole when no body is open, and is off with nothing text-bearing selected", async () => {
		const mounted = mount({ selected: [2] })

		fireEvent.click(within(commands()).getByRole("button", { name: "Italic" }))
		await waitFor(() => {
			expect(mounted.ops).toHaveLength(1)
		})
		expect(mounted.ops[0]).toMatchObject({
			family: "text",
			kind: "setText",
			target: { slide: ref, id: 2 },
			body: { paragraphs: [{ runs: [{ kind: "r", text: "Title", rPr: { lang: "en-GB", i: true } }] }] }
		})
		cleanup()

		mount({ selected: [3] })
		expect(within(commands()).getByRole<HTMLButtonElement>("button", { name: "Bold" }).disabled).toBe(true)
	})

	it("leaves the font box empty with no text to read a font from, and says several only for an open body's mix", () => {
		mount({})
		expect(within(commands()).getByRole("combobox", { name: "Font" }).textContent).not.toContain("Several fonts")
		cleanup()

		mount({ selected: [2] })
		expect(within(commands()).getByRole("combobox", { name: "Font" }).textContent).not.toContain("Several fonts")
		cleanup()

		mount({ body: { run: {} } })
		expect(within(commands()).getByRole("combobox", { name: "Font" }).textContent).toContain("Several fonts")
	})

	it("collapses its groups into buttons on a narrow row", () => {
		size.width = 200
		mount({ body: { run: {} } })

		expect(within(commands()).queryByRole("button", { name: "Bold" })).toBeNull()
		expect(within(commands()).getAllByRole("button").length).toBeGreaterThan(0)
	})

	it("opens More text formats with its labelled case and spacing groups, and sets small caps", async () => {
		const mounted = mount({ body: { run: {} } })

		fireEvent.click(within(commands()).getByRole("button", { name: "More text formats" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Small caps" }))
		expect(mounted.runs).toHaveLength(1)
	})

	it("links to http, https or mailto addresses and to slides only", async () => {
		// Stored as the save path classifies it: trimmed, spaces percent-encoded.
		expect(linkOfChoice("url", " https://filen.io ", "", INFO)).toEqual({ kind: "url", href: "https://filen.io" })
		expect(linkOfChoice("url", "https://filen.io/my file.pdf", "", INFO)).toEqual({
			kind: "url",
			href: "https://filen.io/my%20file.pdf"
		})
		expect(linkOfChoice("url", "mailto:a@b.c", "", INFO)).toEqual({ kind: "url", href: "mailto:a@b.c" })
		expect(linkOfChoice("url", "javascript:alert(1)", "", INFO)).toBeNull()
		expect(linkOfChoice("url", "file:///etc/passwd", "", INFO)).toBeNull()
		expect(linkOfChoice("slide", "", String(slideRef(257)), INFO)).toEqual({ kind: "slide", slide: slideRef(257) })
		expect(linkOfChoice("slide", "", "999", INFO)).toBeNull()

		const mounted = mount({ body: { run: {} } })

		fireEvent.click(within(commands()).getByRole("button", { name: "Link" }))

		const dialog = await screen.findByRole("dialog", { name: "Link" })
		const address = within(dialog).getByRole("textbox", { name: "Address" })

		fireEvent.change(address, { target: { value: "javascript:alert(1)" } })
		expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Apply" }).disabled).toBe(true)
		fireEvent.change(address, { target: { value: "https://filen.io" } })

		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
			await Promise.resolve()
		})
		expect(mounted.runs).toHaveLength(1)
	})

	it("names the text editor's area", () => {
		expect(presentationTextLabels(i18n.getFixedT(null, "preview"))).toEqual({ editor: "Slide text" })
	})
})
