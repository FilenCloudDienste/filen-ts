// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type PresentationDesignInfo } from "@filen/office/core/presentation"
import { FILEN_THEMES } from "@filen/office/core/templates"
import type { CommandResult, OpenInfo } from "@filen/office/dom/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import {
	defaultScale,
	deckThemePreview,
	emuToUnit,
	galleryPreview,
	previewFont,
	unitToEmu,
	validSlideLength
} from "@/features/presentation/components/design/design.logic"
import { designGroups } from "@/features/presentation/components/ribbon/design"
import { RibbonDialogsHost } from "@/features/presentation/components/ribbon/ribbonDialogs"
import { PresentationEditorContext, type PresentationEditorScope } from "@/features/presentation/hooks/usePresentationSession"
import "@/lib/i18n"

// The Design tab against a fake editor: the theme gallery (the presentation's own themes, Filen's eight, all slides or
// the selected ones), the variants of the current Filen theme, Slide Size and Format Background, each sending its op.

// The ribbon's width: room for every group, unless a test leaves none (every group under More commands).
const size = vi.hoisted(() => ({ width: 2000 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))

const SLIDES = [0, 1, 2].map(n => ({ ref: slideRef(256 + n), hidden: false }))
const MASTER = slideRef(1)
const LAYOUT = slideRef(2)
const DESIGN: PresentationDesignInfo = {
	themes: [
		{
			master: MASTER,
			key: "/ppt/slideMasters/slideMaster1.xml",
			name: "Filen filen 1",
			gallery: { id: "filen", variant: 0 },
			colors: { background: "FFFFFF", text: "000000", accents: ["2563EB", "F97316", "6B7280"] },
			fonts: { major: "Calibri Light", minor: "Calibri" }
		}
	]
}

function mount(
	format: "pptx" | "odp" = "pptx",
	hosted = false,
	options: {
		readonly hidesGraphics?: boolean
		readonly design?: PresentationDesignInfo
		readonly unit?: "cm" | "in"
		readonly refuseScaled?: boolean
	} = {}
): { readonly ops: DeckOp[]; readonly hideRibbon: () => void } {
	const ops: DeckOp[] = []
	const info = {
		format,
		slides: SLIDES,
		size: { cx: 12_192_000, cy: 6_858_000 },
		layouts: [{ ref: LAYOUT, master: MASTER, type: "obj" }],
		editable: true,
		design: options.design ?? DESIGN
	} as unknown as OpenInfo
	const current = SLIDES[1]?.ref
	const renders = new Map(
		current === undefined || options.hidesGraphics !== true ? [] : [[current, { ref: current, hidesMasterShapes: true }]]
	)

	vi.spyOn(navigator, "language", "get").mockReturnValue(options.unit === "cm" ? "de-DE" : "en-US")
	const scope = {
		editor: {
			store: {},
			session: {},
			editable: true,
			current: 1,
			currentRef: SLIDES[1]?.ref,
			currentLayout: LAYOUT,
			layouts: info.layouts,
			selection: [SLIDES[1]?.ref],
			document: { slides: SLIDES, info, renders },
			command: (op: DeckOp) => {
				ops.push(op)

				if (options.refuseScaled === true && op.family === "design" && op.kind === "setSize" && op.scale !== "none")
					return Promise.resolve({ ok: false, refusal: "locked" } as CommandResult)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true } as CommandResult)
			}
		},
		view: {}
	} as unknown as PresentationEditorScope

	const view = (ribbon: boolean) => (
		<PresentationEditorContext value={scope}>
			{hosted ? <RibbonDialogsHost editor={scope.editor as never} /> : null}
			{ribbon ? (
				<OfficeRibbon
					label="Ribbon"
					commandsLabel="Commands"
					tabs={[{ id: "design", label: "Design" }]}
					tab="design"
					onTab={() => undefined}
					file={null}
					groups={designGroups({
						editable: true,
						phone: false,
						selection: new Set(),
						t: i18n.t.bind(i18n),
						editor: scope.editor as never
					})}
				/>
			) : null}
		</PresentationEditorContext>
	)
	const rendered = render(view(true))

	return {
		ops,
		hideRibbon: () => {
			rendered.rerender(view(false))
		}
	}
}

afterEach(() => {
	cleanup()
	size.width = 2000
})

async function openThemes(): Promise<HTMLElement> {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Themes" }))
		await Promise.resolve()
	})

	return screen.findByRole("menu")
}

describe("Design tab", () => {
	it("lists the presentation's own theme and Filen's eight, and applies one to every slide", async () => {
		const { ops } = mount()
		const menu = await openThemes()

		expect(within(menu).getByText("In this presentation")).toBeTruthy()
		expect(within(menu).getByRole("menuitem", { name: "Filen, variant 1" })).toBeTruthy()
		const gallery = within(menu).getAllByRole("group", { name: "Filen themes" })[0]

		if (gallery === undefined) throw new Error("no Filen themes")

		expect(
			within(gallery)
				.getAllByRole("menuitem")
				.map(item => item.getAttribute("aria-label"))
		).toEqual(["Filen", "Slate", "Harbor", "Ember", "Meadow", "Ledger", "Studio", "Typewriter"])

		fireEvent.click(within(menu).getByRole("menuitem", { name: "Slate" }))

		expect(ops).toEqual([
			{
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "slate", variant: 0 },
				slides: SLIDES.map(slide => slide.ref)
			}
		])
	})

	it("applies a theme to the selected slides only when asked", async () => {
		const { ops } = mount()
		const menu = await openThemes()

		fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Apply to selected slides only" }))
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Ledger" }))

		expect(ops[0]).toMatchObject({ theme: { kind: "gallery", id: "ledger" }, slides: [SLIDES[1]?.ref] })
	})

	it("applies a Filen theme and switches its variant in an OpenDocument presentation", async () => {
		const { ops } = mount("odp", false, {
			design: { themes: [{ master: MASTER, key: "/styles.xml#Filen-slate-1", gallery: { id: "slate", variant: 0 } }] }
		})
		const menu = await openThemes()
		const slate = within(menu).getByRole("menuitem", { name: "Slate" })

		expect(slate.getAttribute("aria-disabled")).toBeNull()
		fireEvent.click(slate)
		fireEvent.click(within(screen.getByRole("group", { name: "Variants" })).getByRole("button", { name: "Variant 2" }))

		expect(ops).toEqual([
			{
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "slate", variant: 0 },
				slides: SLIDES.map(slide => slide.ref)
			},
			{ family: "design", kind: "setVariant", master: MASTER, variant: 1 }
		])
	})

	it("says why a scaled size change was refused and stays open for Don't scale", async () => {
		const { ops } = mount("pptx", false, { refuseScaled: true })

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Slide size" }))
			await Promise.resolve()
		})
		fireEvent.click(await screen.findByRole("menuitem", { name: "Standard (4:3)" }))

		const dialog = await screen.findByRole("dialog", { name: "Slide size" })

		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		expect(await within(dialog).findByText(/can't be moved or scaled here/u)).toBeTruthy()

		fireEvent.click(within(dialog).getByRole("radio", { name: /Don't scale/u }))
		expect(within(dialog).queryByText(/can't be moved or scaled here/u)).toBeNull()
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops.at(-1)).toMatchObject({ kind: "setSize", scale: "none" })
		})
	})

	it("keeps why the variants are off reachable: the swatches stay hoverable while disabled", () => {
		mount("pptx", false, { design: { themes: [{ master: MASTER, key: "k", name: "Office" }] } })

		const variant = within(screen.getByRole("group", { name: "Variants" })).getByRole("button", { name: "Variant 1" })

		expect(variant.getAttribute("aria-disabled")).toBe("true")
		expect(variant.hasAttribute("disabled")).toBe(false)
	})

	it("switches the current slide's master to another variant", () => {
		const { ops } = mount()
		const variants = screen.getByRole("group", { name: "Variants" })

		expect(within(variants).getByRole("button", { name: "Variant 1" }).getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(within(variants).getByRole("button", { name: "Variant 3" }))

		expect(ops).toEqual([{ family: "design", kind: "setVariant", master: MASTER, variant: 2 }])
	})

	it("sets a 4:3 slide size with the content fitted, through the dialog the preset opens", async () => {
		const { ops } = mount()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Slide size" }))
			await Promise.resolve()
		})
		fireEvent.click(await screen.findByRole("menuitem", { name: "Standard (4:3)" }))

		const dialog = await screen.findByRole("dialog", { name: "Slide size" })

		expect(
			within(dialog)
				.getByRole("radio", { name: /Ensure fit/u })
				.getAttribute("aria-checked")
		).toBe("true")
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		await waitFor(() => {
			expect(ops).toEqual([
				{ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, type: "screen4x3", scale: "ensureFit" }
			])
		})
	})

	it("formats the selected slides' background with a theme color, applies it to all, and resets it", async () => {
		const { ops } = mount()
		const open = async (): Promise<HTMLElement> => {
			fireEvent.click(screen.getByRole("button", { name: "Format background" }))

			return screen.findByRole("dialog", { name: "Format background" })
		}

		let dialog = await open()

		fireEvent.click(within(dialog).getByRole("button", { name: "Color: Background 1" }))
		fireEvent.click(await screen.findByRole("button", { name: "Accent 1" }))
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops[0]).toEqual({
				family: "design",
				kind: "setBackground",
				slides: [SLIDES[1]?.ref],
				background: { kind: "fill", fill: { kind: "solid", color: { kind: "scheme", slot: "accent1" } } }
			})
		})

		dialog = await open()
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply to all" }))
		await waitFor(() => {
			expect(ops[1]).toMatchObject({ slides: SLIDES.map(slide => slide.ref) })
		})
		expect(ops[1]).not.toHaveProperty("hideGraphics")

		dialog = await open()
		fireEvent.click(within(dialog).getByRole("button", { name: "Reset background" }))
		await waitFor(() => {
			expect(ops[2]).toEqual({ family: "design", kind: "setBackground", slides: [SLIDES[1]?.ref], background: undefined })
		})
	})

	it("starts from the slide's hidden background graphics and sends the switch only once changed", async () => {
		const { ops } = mount("pptx", false, { hidesGraphics: true })

		fireEvent.click(screen.getByRole("button", { name: "Format background" }))

		let dialog = await screen.findByRole("dialog", { name: "Format background" })
		const graphics = within(dialog).getByRole("switch", { name: "Hide background graphics" })

		expect(graphics.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).not.toHaveProperty("hideGraphics")

		fireEvent.click(screen.getByRole("button", { name: "Format background" }))
		dialog = await screen.findByRole("dialog", { name: "Format background" })
		fireEvent.click(within(dialog).getByText("Hide background graphics"))
		expect(within(dialog).getByRole("switch", { name: "Hide background graphics" }).getAttribute("aria-checked")).toBe("false")
		fireEvent.click(within(dialog).getByRole("button", { name: "Reset background" }))
		await waitFor(() => {
			expect(ops[1]).toMatchObject({ background: undefined, hideGraphics: false })
		})
	})

	it("names the theme's colors and writes sRGB in an OpenDocument presentation", async () => {
		const { ops } = mount("odp")

		fireEvent.click(screen.getByRole("button", { name: "Format background" }))

		const dialog = await screen.findByRole("dialog", { name: "Format background" })

		fireEvent.click(within(dialog).getByRole("button", { name: "Color: Background 1" }))
		fireEvent.click(await screen.findByRole("button", { name: "Accent 2" }))
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops[0]).toMatchObject({ background: { kind: "fill", fill: { kind: "solid", color: { kind: "srgb", rgb: "F97316" } } } })
		})
	})

	it("applies a preset's exact size in centimetres, centring the content on a larger slide", async () => {
		const { ops } = mount("pptx", false, {
			unit: "cm",
			design: DESIGN
		})

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Slide size" }))
			await Promise.resolve()
		})
		fireEvent.click(await screen.findByRole("menuitem", { name: "A4 paper" }))

		const dialog = await screen.findByRole("dialog", { name: "Slide size" })
		const width = within(dialog).getByRole("textbox", { name: "Width (cm)" })

		expect((width as HTMLInputElement).value).toBe("27.52")
		fireEvent.change(width, { target: { value: "33,87" } })
		fireEvent.change(within(dialog).getByRole("textbox", { name: "Height (cm)" }), { target: { value: "19.05" } })
		expect(within(dialog).getByRole("combobox", { name: "Size" }).textContent).toContain("Widescreen")
		expect(
			within(dialog)
				.getByRole("radio", { name: /Don't scale/u })
				.getAttribute("aria-checked")
		).toBe("true")

		fireEvent.change(width, { target: { value: "40" } })
		expect(
			within(dialog)
				.getByRole("radio", { name: /Ensure fit/u })
				.getAttribute("aria-checked")
		).toBe("true")
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		await waitFor(() => {
			expect(ops).toEqual([{ family: "design", kind: "setSize", cx: 14_400_000, cy: 6_858_000, scale: "ensureFit" }])
		})
	})

	it("keeps a dialog asked for from the ribbon open after the ribbon's group goes (an overflow menu closing)", async () => {
		const { hideRibbon } = mount("pptx", true)

		fireEvent.click(screen.getByRole("button", { name: "Format background" }))
		await screen.findByRole("dialog", { name: "Format background" })
		hideRibbon()

		expect(screen.getByRole("dialog", { name: "Format background" })).toBeTruthy()
	})

	it("opens Slide size and Format background from More commands, which closes as they run", async () => {
		size.width = 40
		const { ops } = mount("pptx", true)

		fireEvent.click(screen.getByRole("button", { name: "More commands" }))
		fireEvent.click(await screen.findByRole("button", { name: "Format background" }))
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Format background" })).toBeNull()
		})
		fireEvent.click(within(await screen.findByRole("dialog", { name: "Format background" })).getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Format background" })).toBeNull()
		})

		fireEvent.click(screen.getByRole("button", { name: "More commands" }))
		fireEvent.click(await screen.findByRole("button", { name: "Slide size" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Standard (4:3)" }))

		const dialog = await screen.findByRole("dialog", { name: "Slide size" })

		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops.at(-1)).toMatchObject({ family: "design", kind: "setSize" })
		})
		// The overflow closed with the menu's item: focus goes back to its trigger, More commands.
		await act(async () => {
			await new Promise(resolve => requestAnimationFrame(resolve))
			await new Promise(resolve => requestAnimationFrame(resolve))
		})
		expect(screen.queryByRole("button", { name: "Slide size" })).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})

	it("offers every fill kind in an OpenDocument presentation", async () => {
		const { ops } = mount("odp")

		fireEvent.click(screen.getByRole("button", { name: "Format background" }))

		const dialog = await screen.findByRole("dialog", { name: "Format background" })

		fireEvent.click(within(dialog).getByRole("radio", { name: "Gradient" }))
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops[0]).toMatchObject({ background: { kind: "fill", fill: { kind: "gradient" } } })
		})
	})
})

describe("Design tab logic", () => {
	it("previews a Filen theme's variant: a dark one on dk1 with lt1 text, a gradient's end colour", () => {
		const studio = FILEN_THEMES.find(theme => theme.id === "studio")

		if (studio === undefined) throw new Error("no studio")

		expect(galleryPreview(studio, 3)).toMatchObject({
			background: "0B0A1F",
			backgroundTo: "1E1B4B",
			text: "EEF2FF",
			decoration: "corner"
		})
		expect(
			deckThemePreview({ master: MASTER, key: "k", colors: { background: "112233", text: "FFFFFF", accents: [] } }, () => undefined)
		).toMatchObject({
			background: "112233",
			decoration: "none"
		})
	})

	it("draws a theme font with the bundled substitute first", () => {
		expect(previewFont("Calibri Light")).toBe('"carlito", "Calibri Light", sans-serif')
		expect(previewFont("Georgia")).toBe('"gelasio", "Georgia", serif')
		expect(previewFont("Segoe UI")).toBe('"selawik", "Segoe UI", sans-serif')
	})

	it("converts lengths in the user's unit and bounds slide sizes as PowerPoint does", () => {
		expect(emuToUnit(12_192_000, "cm")).toBe("33.87")
		expect(emuToUnit(12_192_000, "in")).toBe("13.33")
		expect(unitToEmu("25,4", "cm")).toBe(9_144_000)
		expect(validSlideLength(unitToEmu("0.5", "in"))).toBe(false)
		expect(validSlideLength(unitToEmu("56", "in"))).toBe(true)
		expect(defaultScale({ cx: 12_192_000, cy: 6_858_000 }, { cx: 9_144_000, cy: 6_858_000 })).toBe("ensureFit")
		expect(defaultScale({ cx: 9_144_000, cy: 6_858_000 }, { cx: 12_192_000, cy: 6_858_000 })).toBe("ensureFit")
	})
})
