import { describe, expect, it } from "vitest"
import { editedCopyName } from "@/features/drive/lib/copyName"
import { FILTER_PRESETS, effectiveAdjustments } from "@/features/preview/imageEdit/lib/filters"
import { COALESCE_MS, HISTORY_LIMIT, createHistory } from "@/features/preview/imageEdit/lib/history"
import { identityRecipe } from "@/features/preview/imageEdit/lib/recipe"
import { inPlaceFormatByName, isEditableSource, saveTargets } from "@/features/preview/imageEdit/lib/targets"
import type { ImageEditRecipe, SourceInfo } from "@/features/preview/imageEdit/types"

function withContrast(contrast: number): ImageEditRecipe {
	const recipe = identityRecipe()

	return { ...recipe, adjustments: { ...recipe.adjustments, contrast } }
}

function clock() {
	let time = 1000

	return {
		now: () => time,
		advance: (ms: number) => {
			time += ms
		}
	}
}

describe("createHistory", () => {
	it("undoes and redoes, and a push drops the redo branch", () => {
		const initial = identityRecipe()
		const a = withContrast(10)
		const b = withContrast(20)
		const c = withContrast(30)
		const history = createHistory(initial)

		expect(history.canUndo).toBe(false)
		history.push(a)
		history.push(b)
		expect(history.current).toBe(b)
		expect(history.undo()).toBe(a)
		expect(history.canRedo).toBe(true)
		expect(history.redo()).toBe(b)
		expect(history.redo()).toBe(b)
		history.undo()
		history.push(c)
		expect(history.canRedo).toBe(false)
		expect(history.undo()).toBe(a)
		expect(history.undo()).toBe(initial)
		expect(history.undo()).toBe(initial)
	})

	it("merges same-key pushes within the window into one step", () => {
		const time = clock()
		const history = createHistory(identityRecipe(), time.now)

		history.push(withContrast(1), "contrast")
		time.advance(100)
		history.push(withContrast(2), "contrast")
		time.advance(COALESCE_MS)
		history.push(withContrast(3), "contrast")
		expect(history.current.adjustments.contrast).toBe(3)
		expect(history.undo()).toEqual(identityRecipe())
	})

	it("starts a new step after the window, on another key, after seal() or after an undo", () => {
		const time = clock()
		const history = createHistory(identityRecipe(), time.now)

		history.push(withContrast(1), "contrast")
		time.advance(COALESCE_MS + 1)
		history.push(withContrast(2), "contrast")
		expect(history.undo().adjustments.contrast).toBe(1)
		history.redo()

		history.push(withContrast(3), "brightness")
		expect(history.undo().adjustments.contrast).toBe(2)
		history.redo()

		history.seal()
		history.push(withContrast(4), "brightness")
		expect(history.undo().adjustments.contrast).toBe(3)

		history.push(withContrast(5), "brightness")
		expect(history.undo().adjustments.contrast).toBe(3)
	})

	it("never merges into the initial entry and ignores pushing the current recipe", () => {
		const initial = identityRecipe()
		const history = createHistory(initial)

		history.push(initial, "x")
		expect(history.canUndo).toBe(false)
		history.push(withContrast(1), "x")
		expect(history.undo()).toBe(initial)
	})

	it(`keeps at most ${String(HISTORY_LIMIT)} entries`, () => {
		const history = createHistory(identityRecipe())

		for (let i = 1; i <= HISTORY_LIMIT + 50; i++) {
			history.push(withContrast(i % 100))
		}

		let undos = 0

		while (history.canUndo) {
			history.undo()
			undos++
		}

		expect(undos).toBe(HISTORY_LIMIT - 1)
	})
})

describe("filters", () => {
	it("has unique ids and i18n keys", () => {
		expect(new Set(FILTER_PRESETS.map(p => p.id)).size).toBe(FILTER_PRESETS.length)
		expect(FILTER_PRESETS.every(p => p.labelKey.startsWith("previewImageEditFilter"))).toBe(true)
	})

	it("adds the preset to the user's adjustments, clamped", () => {
		const recipe = { ...withContrast(90), filter: "noir" }
		const effective = effectiveAdjustments(recipe)

		expect(effective.saturation).toBe(-100)
		expect(effective.contrast).toBe(100)
		expect(effective.vignette).toBe(30)
		expect(recipe.adjustments.contrast).toBe(90)
	})

	it("returns the user's own adjustments without a filter or for an unknown one", () => {
		const recipe = withContrast(5)

		expect(effectiveAdjustments(recipe)).toBe(recipe.adjustments)
		expect(effectiveAdjustments({ ...recipe, filter: "gone" })).toBe(recipe.adjustments)
	})

	it("keeps vignette at or above 0", () => {
		const recipe = identityRecipe()
		const effective = effectiveAdjustments({ ...recipe, adjustments: { ...recipe.adjustments, vignette: -50 }, filter: "noir" })

		expect(effective.vignette).toBe(0)
	})
})

function info(overrides: Partial<SourceInfo>): SourceInfo {
	return {
		mime: "image/jpeg",
		width: 10,
		height: 10,
		orientation: 1,
		hasAlpha: false,
		animated: false,
		pngTruecolor8: false,
		webpLossless: false,
		jpegQuality: null,
		icc: null,
		exif: null,
		needsTail: false,
		...overrides
	}
}

const JPEG_COPY = { kind: "copy", mime: "image/jpeg", extension: "jpg" }
const PNG_COPY = { kind: "copy", mime: "image/png", extension: "png" }

describe("saveTargets", () => {
	it("follows the table", () => {
		expect(saveTargets(info({ mime: "image/jpeg" }), false)).toEqual({
			primary: { kind: "inPlace", mime: "image/jpeg" },
			copy: JPEG_COPY
		})
		expect(saveTargets(info({ mime: "image/png", pngTruecolor8: true, hasAlpha: true }), false)).toEqual({
			primary: { kind: "inPlace", mime: "image/png" },
			copy: PNG_COPY
		})
		expect(saveTargets(info({ mime: "image/png", pngTruecolor8: false }), false)).toEqual({ primary: PNG_COPY, copy: PNG_COPY })
		expect(saveTargets(info({ mime: "image/webp" }), true)).toEqual({
			primary: { kind: "inPlace", mime: "image/webp" },
			copy: JPEG_COPY
		})
		expect(saveTargets(info({ mime: "image/webp", hasAlpha: true }), true)).toEqual({
			primary: { kind: "inPlace", mime: "image/webp" },
			copy: PNG_COPY
		})
		expect(saveTargets(info({ mime: "image/webp", hasAlpha: true }), false)).toEqual({ primary: PNG_COPY, copy: PNG_COPY })
		expect(saveTargets(info({ mime: "image/heic" }), true)).toEqual({ primary: JPEG_COPY, copy: JPEG_COPY })
		expect(saveTargets(info({ mime: "image/avif", hasAlpha: true }), true)).toEqual({ primary: PNG_COPY, copy: PNG_COPY })
		expect(saveTargets(info({ mime: "image/bmp" }), true)).toEqual({ primary: JPEG_COPY, copy: JPEG_COPY })
		expect(saveTargets(info({ mime: "image/x-icon", hasAlpha: true }), true)).toEqual({ primary: PNG_COPY, copy: PNG_COPY })
		expect(saveTargets(info({ mime: "image/gif" }), true)).toEqual({ primary: PNG_COPY, copy: PNG_COPY })
	})

	it("names in-place formats by extension only", () => {
		expect(inPlaceFormatByName("a.JPG")).toBe("image/jpeg")
		expect(inPlaceFormatByName("a.jfif")).toBe("image/jpeg")
		expect(inPlaceFormatByName("a.png")).toBe("image/png")
		expect(inPlaceFormatByName("a.webp")).toBe("image/webp")
		expect(inPlaceFormatByName("a.heic")).toBeNull()
		expect(inPlaceFormatByName("png")).toBeNull()
	})

	it("refuses animations and bytes that are not what the name says", () => {
		expect(isEditableSource(info({ mime: "image/jpeg" }), "a.jpeg")).toBe(true)
		expect(isEditableSource(info({ mime: "image/heic" }), "a.HIF")).toBe(true)
		expect(isEditableSource(info({ mime: "image/png" }), "a.jpg")).toBe(false)
		expect(isEditableSource(info({ mime: "image/gif", animated: true }), "a.gif")).toBe(false)
		expect(isEditableSource(info({ mime: "image/jpeg" }), "noextension")).toBe(false)
	})
})

describe("editedCopyName", () => {
	const suffix = (n: number) => (n === 1 ? "edited" : `edited ${String(n)}`)

	it("suffixes the base and counts past taken names, case-insensitively", () => {
		expect(editedCopyName("photo.HEIC", "jpg", suffix, new Set())).toBe("photo (edited).jpg")
		expect(editedCopyName("photo.jpg", "jpg", suffix, new Set(["photo (edited).jpg", "photo (edited 2).jpg"]))).toBe(
			"photo (edited 3).jpg"
		)
		expect(editedCopyName("Photo.jpg", "jpg", suffix, new Set(["photo (edited).jpg"]))).toBe("Photo (edited 2).jpg")
	})

	it("keeps a dot-file's whole name as the base", () => {
		expect(editedCopyName(".hidden", "png", suffix, new Set())).toBe(".hidden (edited).png")
	})
})
