// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"
import type { PdfSignatureImage, PdfSignatureRole, PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"
import type { SavedSignaturesView } from "@/features/pdf/fillSign/savedSignatures"

// The signature dialog: drawing with pointer events and stroke undo, typing, a picked image, the saved row and New,
// and Save for reuse. Canvas pixels and fonts are a browser's (checked in the real-browser smoke); here the encoders
// are fakes.

const typedImage: PdfSignatureImage = { kind: "image", png: new Uint8Array([1, 2, 3]), width: 300, height: 100 }
const pickedImage: PdfSignatureImage = { kind: "image", png: new Uint8Array([4, 5, 6]), width: 200, height: 100 }

function emptyView(): SavedSignaturesView {
	return { loaded: true, readOnly: false, signatures: [], initials: [] }
}

const hooks = vi.hoisted(() => ({
	view: emptyView(),
	online: true,
	save: vi.fn<(role: PdfSignatureRole, signature: PdfVisualSignature, style?: string) => Promise<unknown>>(),
	typed: vi.fn<(text: string, style: string) => Promise<PdfSignatureImage | null>>(),
	loadFonts: vi.fn<(styles: readonly string[], fallback: boolean) => Promise<void>>(),
	picked: vi.fn<(file: File) => Promise<PdfSignatureImage>>(),
	toastError: vi.fn()
}))

vi.mock("@/features/pdf/fillSign/savedSignatures", () => ({
	useSavedSignatures: () => hooks.view,
	loadSavedSignatures: () => Promise.resolve(),
	savedSignatures: { save: hooks.save },
	savedVisualSignature: (saved: SavedPdfSignature) => ({ ...saved.data, fromSaved: saved.id })
}))
vi.mock("@/features/pdf/fillSign/signatureRender", () => ({
	SIGNATURE_INK: "rgb(13 26 89)",
	loadSignatureFonts: hooks.loadFonts,
	renderTypedSignature: hooks.typed,
	imageFileSignature: hooks.picked,
	drawStrokes: () => undefined,
	strokesPath: () => "M0 0"
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => hooks.online }))
vi.mock("sonner", () => ({ toast: { error: hooks.toastError } }))

import "@/lib/i18n"
import { preview as EN } from "@/locales/en/preview"
import { SignatureDialog } from "@/features/pdf/fillSign/signatureDialog"

beforeEach(() => {
	hooks.view = emptyView()
	hooks.online = true
	hooks.save.mockResolvedValue(undefined)
	hooks.typed.mockResolvedValue(typedImage)
	hooks.loadFonts.mockResolvedValue(undefined)
	hooks.picked.mockResolvedValue(pickedImage)
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null)
	HTMLElement.prototype.setPointerCapture = () => undefined
	URL.createObjectURL = () => "blob:signature"
	URL.revokeObjectURL = () => undefined
})

afterEach(() => {
	vi.restoreAllMocks()
})

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

function open(role: PdfSignatureRole = "signature", defaultName?: string) {
	const onPlace = vi.fn<(signature: PdfVisualSignature) => void>()
	const onOpenChange = vi.fn<(open: boolean) => void>()

	render(createElement(SignatureDialog, { open: true, onOpenChange, role, onPlace, defaultName }))

	return { onPlace, onOpenChange }
}

function draw(points: readonly (readonly [number, number])[]): void {
	const pad = screen.getByRole("img", { name: EN.previewPdfSignaturePad })
	const [first, ...rest] = points

	if (first === undefined) return

	fireEvent.pointerDown(pad, { pointerId: 1, pointerType: "pen", button: 0, clientX: first[0], clientY: first[1] })

	for (const [x, y] of rest) fireEvent.pointerMove(pad, { pointerId: 1, pointerType: "pen", clientX: x, clientY: y })

	fireEvent.pointerUp(pad, { pointerId: 1, pointerType: "pen" })
}

const place = (): HTMLElement => screen.getByRole("button", { name: EN.previewPdfSignaturePlace })

describe("SignatureDialog", () => {
	it("places drawn strokes, undoes and redoes a stroke, and saves a new signature for reuse", async () => {
		const { onPlace, onOpenChange } = open()
		const pad = screen.getByRole("img", { name: EN.previewPdfSignaturePad })

		expect(place()).toHaveProperty("disabled", true)

		draw([
			[10, 10],
			[40, 60],
			[80, 20],
			[120, 70]
		])
		draw([
			[20, 80],
			[140, 80]
		])

		expect(pad.dataset["strokes"]).toBe("2")

		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureUndoStroke }))
		expect(pad.dataset["strokes"]).toBe("1")
		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureRedoStroke }))
		expect(pad.dataset["strokes"]).toBe("2")

		// A second pointer while one draws is ignored.
		fireEvent.pointerDown(pad, { pointerId: 1, pointerType: "touch", clientX: 5, clientY: 5 })
		fireEvent.pointerDown(pad, { pointerId: 2, pointerType: "touch", clientX: 50, clientY: 50 })
		fireEvent.pointerUp(pad, { pointerId: 2, pointerType: "touch" })
		expect(pad.dataset["strokes"]).toBe("2")
		fireEvent.pointerUp(pad, { pointerId: 1, pointerType: "touch" })
		expect(pad.dataset["strokes"]).toBe("3")
		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureUndoStroke }))

		fireEvent.click(place())
		await settle()

		expect(onPlace).toHaveBeenCalledTimes(1)

		const placed = onPlace.mock.calls[0]?.[0]

		expect(placed?.kind).toBe("strokes")
		expect(placed?.kind === "strokes" ? placed.strokes.length : 0).toBe(2)
		expect(Math.max(placed?.width ?? 0, placed?.height ?? 0)).toBe(1000)
		expect(hooks.save).toHaveBeenCalledWith("signature", placed)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it("clears the drawing (undoably)", () => {
		open()
		draw([
			[0, 0],
			[10, 10]
		])
		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureClear }))

		expect(place()).toHaveProperty("disabled", true)

		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureUndoStroke }))
		expect(place()).toHaveProperty("disabled", false)
	})

	it("types initials derived from the author name; nothing saved when Save for reuse is off", async () => {
		const { onPlace } = open("initials", "jane van doe")

		fireEvent.click(screen.getByRole("tab", { name: EN.previewPdfSignatureType }))
		await settle()

		const input = screen.getByLabelText(EN.previewPdfInitialsTypeLabel)

		expect(input).toHaveProperty("value", "JVD")

		fireEvent.change(input, { target: { value: "JD" } })
		fireEvent.click(screen.getByLabelText(EN.previewPdfSignatureSaveForReuse))
		fireEvent.click(place())
		await settle()

		expect(hooks.typed).toHaveBeenCalledWith("JD", "dancing-script")
		expect(onPlace).toHaveBeenCalledWith(typedImage)
		expect(hooks.save).not.toHaveBeenCalled()
	})

	it("draws the typed name in each handwriting style, picked from a radio group, and saves the style with it", async () => {
		const { onPlace } = open("signature", "Zoë Łukasz Ştefan")

		fireEvent.click(screen.getByRole("tab", { name: EN.previewPdfSignatureType }))
		await settle()

		const group = screen.getByRole("radiogroup", { name: EN.previewPdfSignatureStyle })
		const radios = screen.getAllByRole("radio")
		const checked = () => radios.map(radio => radio.getAttribute("aria-checked"))

		expect(radios.map(radio => radio.textContent)).toEqual([
			`Zoë Łukasz Ştefan${EN.previewPdfSignatureStyleFlowing}`,
			`Zoë Łukasz Ştefan${EN.previewPdfSignatureStyleQuick}`,
			`Zoë Łukasz Ştefan${EN.previewPdfSignatureStyleFormal}`
		])
		expect(screen.getByRole("radio", { name: EN.previewPdfSignatureStyleQuick })).toBe(radios[1])
		// The first style by default; the fonts of all three (the name needs no fallback) load for the previews.
		expect(checked()).toEqual(["true", "false", "false"])
		expect(hooks.loadFonts).toHaveBeenLastCalledWith(["dancing-script", "ms-madi", "pinyon-script"], false)

		fireEvent.click(screen.getByRole("radio", { name: EN.previewPdfSignatureStyleFormal }))
		expect(checked()).toEqual(["false", "false", "true"])
		expect(group.contains(radios[2] ?? null)).toBe(true)

		fireEvent.click(screen.getByRole("radio", { name: EN.previewPdfSignatureStyleQuick }))
		expect(checked()).toEqual(["false", "true", "false"])

		fireEvent.click(place())
		await settle()

		expect(hooks.typed).toHaveBeenCalledWith("Zoë Łukasz Ştefan", "ms-madi")
		expect(onPlace).toHaveBeenCalledWith(typedImage)
		expect(hooks.save).toHaveBeenCalledWith("signature", typedImage, "ms-madi")
	})

	it("starts on the style of the newest saved typed signature, and loads the fallback only for text that needs it", async () => {
		hooks.view = {
			...emptyView(),
			signatures: [
				{ id: "drawn", role: "signature", at: 3, data: { kind: "strokes", width: 10, height: 10, strokes: [[0, 0, 10, 10]] } },
				{
					id: "typed",
					role: "signature",
					at: 2,
					data: { kind: "image", width: 10, height: 5, png: "AAAA", style: "pinyon-script" }
				},
				{ id: "older", role: "signature", at: 1, data: { kind: "image", width: 10, height: 5, png: "AAAA", style: "ms-madi" } }
			]
		}
		open("signature", "Jane")

		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureNew }))
		fireEvent.click(screen.getByRole("tab", { name: EN.previewPdfSignatureType }))
		await settle()

		expect(screen.getByRole("radio", { name: EN.previewPdfSignatureStyleFormal }).getAttribute("aria-checked")).toBe("true")
		expect(hooks.loadFonts).toHaveBeenLastCalledWith(["dancing-script", "ms-madi", "pinyon-script"], false)
		expect(place()).toHaveProperty("disabled", false)

		// Cyrillic is in none of the styles: Gelasio Italic draws it, and Place waits for it.
		hooks.loadFonts.mockReturnValueOnce(new Promise(() => undefined))
		fireEvent.change(screen.getByLabelText(EN.previewPdfSignatureTypeLabel), { target: { value: "Жанна" } })
		await settle()

		expect(hooks.loadFonts).toHaveBeenLastCalledWith(["dancing-script", "ms-madi", "pinyon-script"], true)
		expect(place()).toHaveProperty("disabled", true)
	})

	it("places a picked image, and says when a file is not one", async () => {
		const { onPlace } = open()

		fireEvent.click(screen.getByRole("tab", { name: EN.previewPdfSignatureImage }))

		const input = document.querySelector<HTMLInputElement>('input[type="file"]')

		if (input === null) throw new Error("no file input")

		hooks.picked.mockRejectedValueOnce(new Error("not an image"))
		fireEvent.change(input, { target: { files: [new File(["x"], "notes.txt")] } })
		await settle()

		expect(screen.getByRole("alert").textContent).toBe(EN.previewPdfSignatureImageFailed)

		fireEvent.change(input, { target: { files: [new File(["png"], "signature.heic")] } })
		await settle()
		fireEvent.click(place())
		await settle()

		expect(hooks.picked).toHaveBeenLastCalledWith(expect.objectContaining({ name: "signature.heic" }))
		expect(onPlace).toHaveBeenCalledWith(pickedImage)
	})

	it("offers saved signatures first, and New for another", async () => {
		const savedOne: SavedPdfSignature = {
			id: "one",
			role: "signature",
			at: 2,
			data: { kind: "strokes", width: 100, height: 50, strokes: [[0, 0, 100, 50]] }
		}
		const savedTwo: SavedPdfSignature = {
			id: "two",
			role: "signature",
			at: 1,
			data: { kind: "image", width: 10, height: 5, png: "AAAA" }
		}

		hooks.view = { ...emptyView(), signatures: [savedOne, savedTwo] }

		const { onPlace } = open()

		expect(screen.queryByRole("tab")).toBeNull()
		expect(screen.getByRole("button", { name: "Saved signature 1" }).getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: "Saved signature 2" }))
		fireEvent.click(place())
		await settle()

		expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ fromSaved: "two" }))
		expect(hooks.save).not.toHaveBeenCalled()
	})

	it("shows the tabs after New; saving for reuse is off offline", () => {
		hooks.view = {
			...emptyView(),
			signatures: [
				{ id: "one", role: "signature", at: 1, data: { kind: "strokes", width: 10, height: 10, strokes: [[0, 0, 10, 10]] } }
			]
		}
		hooks.online = false
		open()

		fireEvent.click(screen.getByRole("button", { name: EN.previewPdfSignatureNew }))

		expect(screen.getByRole("tab", { name: EN.previewPdfSignatureDraw })).toBeTruthy()
		expect(screen.getByLabelText(EN.previewPdfSignatureSaveForReuse)).toHaveProperty("disabled", true)
	})
})
