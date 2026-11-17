// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { FontInfo } from "@filen/office/core/fonts"
import "@/lib/i18n"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// The font viewer registers the file as a face of its own family and removes it on unmount, shows the specimen in it,
// the glyphs the worker read, and the A4 card when the browser refuses the font.

const { faces, inspect, loadOutcome } = vi.hoisted(() => ({
	faces: { added: [] as unknown[], deleted: [] as unknown[] },
	inspect: vi.fn<(bytes: Uint8Array) => Promise<FontInfo>>(),
	loadOutcome: { fails: false }
}))

vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new Uint8Array([0, 1, 0, 0]), refetch: () => undefined })
}))
vi.mock("@/features/preview/lib/fontInspect", () => ({ inspectFont: inspect }))

class FakeFontFace {
	readonly family: string

	constructor(family: string) {
		this.family = family
	}

	load(): Promise<this> {
		return loadOutcome.fails ? Promise.reject(new Error("OTS parsing error")) : Promise.resolve(this)
	}
}

const INFO: FontInfo = {
	container: "woff2",
	outlines: "cff",
	glyphCount: 2548,
	unitsPerEm: 1000,
	weight: 700,
	italic: false,
	fsType: 0,
	names: [
		{ id: 1, value: "Probe Sans" },
		{ id: 2, value: "Bold" },
		{ id: 13, value: "Open Font License" }
	],
	axes: [{ tag: "wght", min: 100, default: 400, max: 900, name: "Weight", hidden: false }],
	codePoints: Uint32Array.of(0x20, 0x7e),
	codePointCount: 95
}

beforeEach(() => {
	faces.added.length = 0
	faces.deleted.length = 0
	loadOutcome.fails = false
	inspect.mockResolvedValue(INFO)
	vi.stubGlobal("FontFace", FakeFontFace)
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: {
			add: (face: unknown) => faces.added.push(face),
			delete: (face: unknown) => faces.deleted.push(face)
		}
	})
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

async function renderViewer() {
	const { FontViewer } = await import("@/features/preview/components/fontViewer")
	const item = linkedFileItem("ProbeSans-Bold.woff2")

	return { item, ...render(<FontViewer item={item} />) }
}

describe("FontViewer", () => {
	it("shows the specimen in its own family and removes the face on unmount", async () => {
		const { item, unmount } = await renderViewer()

		await screen.findAllByText("The quick brown fox jumps over the lazy dog")
		expect(screen.getByText("Probe Sans · Bold · WOFF2 · 2,548 glyphs")).toBeTruthy()
		expect((faces.added[0] as FakeFontFace).family).toBe(`filen-preview-${item.data.uuid}`)
		expect(screen.getByText("Weight")).toBeTruthy()

		unmount()

		expect(faces.deleted).toEqual(faces.added)
	})

	it("previews typed text", async () => {
		await renderViewer()

		fireEvent.change(await screen.findByRole("textbox", { name: "Preview text" }), { target: { value: "Hamburgefonstiv" } })

		expect(screen.getAllByText("Hamburgefonstiv")).toHaveLength(6)
	})

	it("shows the card when the browser refuses the font, and keeps its info", async () => {
		loadOutcome.fails = true
		await renderViewer()

		expect(await screen.findByText("This font couldn't be loaded.")).toBeTruthy()

		fireEvent.click(screen.getByRole("tab", { name: "Info" }))

		await waitFor(() => {
			expect(screen.getByText("Open Font License")).toBeTruthy()
		})
	})

	it("says so when neither the browser nor the reader can read it", async () => {
		loadOutcome.fails = true
		inspect.mockRejectedValue(new Error("corrupt"))
		await renderViewer()

		expect(await screen.findByText("This font couldn't be loaded.")).toBeTruthy()
		expect(screen.queryByRole("tab")).toBeNull()
	})
})
