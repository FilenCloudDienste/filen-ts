// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { Dir, File as SdkFile, UuidStr } from "@filen/sdk-rs"
import { MAX_IMAGE_BYTES, NO_REVIEW, NO_VALUES, type DocxEditorCommand, type DocxEditorSnapshot } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxEditingHost } from "@filen/office/dom/docx/editing"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	htmlHoldsOnlyImages,
	insertPicture,
	isPictureFile,
	preparePicture,
	svgFallbackSize,
	webpSize,
	type PictureSource,
	type PreparedPicture
} from "@/features/preview/lib/docxImages.logic"

// The DOCX picture pipeline: sizes refused before reading at the 25 MB edge, WebP refused from its header past
// 20 megapixels before any decode, HEIC/AVIF named, SVG given its PNG, and media given back on every path a
// picture does not go in (refused, thrown, waiting, cancelled).

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }))
const sdk = vi.hoisted(() => ({ downloadFileBytes: vi.fn(), cancelPreviewDownload: vi.fn() }))
const previewCache = vi.hoisted(() => ({ loadPreviewBytes: vi.fn() }))

vi.mock("sonner", () => ({ toast: toasts }))
vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/features/preview/lib/previewCache", () => previewCache)
// Canvas decoding is the browser's: a converted WebP is a small PNG here.
vi.mock("@/features/preview/lib/docxImages", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/docxImages")>("@/features/preview/lib/docxImages")),
	BROWSER_PICTURE_CODECS: { webpToPng: () => Promise.resolve(png(4, 3)), svgToPng: () => Promise.resolve(png(4, 3)) }
}))

const { useDocxImageInsert } = await import("@/features/preview/components/docxImageInsert")
const { driveSource } = await import("@/features/preview/lib/docxImages")

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function ascii(text: string): number[] {
	const out: number[] = []

	for (let k = 0; k < text.length; k++) {
		out.push(text.charCodeAt(k))
	}

	return out
}

// A PNG's signature and IHDR (all the header sniffing reads).
function png(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0x89,
		...ascii("PNG\r\n\x1a\n"),
		...u32be(13),
		...ascii("IHDR"),
		...u32be(width),
		...u32be(height),
		8,
		6,
		0,
		0,
		0,
		...u32be(0),
		...u32be(0),
		...ascii("IEND"),
		...u32be(0)
	])
}

function u24le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
}

function riff(chunk: string, data: number[]): Uint8Array {
	const bytes = [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), data.length, 0, 0, 0, ...data]

	while (bytes.length < 32) {
		bytes.push(0)
	}

	return new Uint8Array(bytes)
}

// VP8X: the canvas size minus one, 24 bits each.
function webpX(width: number, height: number, animated = false): Uint8Array {
	return riff("VP8X", [animated ? 0x02 : 0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)])
}

function webpL(width: number, height: number): Uint8Array {
	const bits = ((width - 1) | ((height - 1) << 14)) >>> 0

	return riff("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff])
}

function webpLossy(width: number, height: number): Uint8Array {
	return riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, width >>> 8, height & 0xff, height >>> 8])
}

function source(bytes: Uint8Array, size = bytes.length): PictureSource {
	return { size, name: "picture", read: () => Promise.resolve(bytes) }
}

function codecs() {
	return {
		webpToPng: vi.fn(() => Promise.resolve(png(4, 3))),
		svgToPng: vi.fn((_bytes: Uint8Array, size: { width: number; height: number }) => Promise.resolve(png(size.width, size.height)))
	}
}

const signal = (): AbortSignal => new AbortController().signal

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("preparePicture", () => {
	it("refuses a file over 25 MB before reading it, and reads one of exactly 25 MB", async () => {
		const read = vi.fn(() => Promise.resolve(png(10, 10)))

		expect(await preparePicture({ size: MAX_IMAGE_BYTES + 1, read }, codecs(), signal())).toEqual({ ok: false, refusal: "tooLarge" })
		expect(read).not.toHaveBeenCalled()

		const prepared = await preparePicture({ size: MAX_IMAGE_BYTES, read }, codecs(), signal())

		expect(read).toHaveBeenCalledTimes(1)
		expect(prepared.ok && prepared.value.info.format).toBe("png")
	})

	it("refuses bytes over 25 MB whatever size was announced", async () => {
		const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1)

		bytes.set(png(10, 10))
		expect(await preparePicture(source(bytes, 100), codecs(), signal())).toEqual({ ok: false, refusal: "tooLarge" })
	})

	it("refuses HEIC and AVIF by name before reading, and a non-picture over 25 MB as no picture", async () => {
		const read = vi.fn(() => Promise.resolve(png(10, 10)))

		expect(await preparePicture({ size: 10, name: "IMG_0001.HEIC", read }, codecs(), signal())).toEqual({ ok: false, refusal: "heic" })
		expect(await preparePicture({ size: 10, name: "shot", type: "image/avif", read }, codecs(), signal())).toEqual({
			ok: false,
			refusal: "avif"
		})
		expect(await preparePicture({ size: MAX_IMAGE_BYTES + 1, name: "report.pdf", read }, codecs(), signal())).toEqual({
			ok: false,
			refusal: "format"
		})
		expect(await preparePicture({ size: MAX_IMAGE_BYTES + 1, name: "photo.png", read }, codecs(), signal())).toEqual({
			ok: false,
			refusal: "tooLarge"
		})
		expect(await preparePicture({ size: MAX_IMAGE_BYTES + 1, read }, codecs(), signal())).toEqual({ ok: false, refusal: "tooLarge" })
		expect(read).not.toHaveBeenCalled()
	})

	it("keeps an animated WebP's first frame, saying so", async () => {
		const animated = await preparePicture(source(webpX(10, 10, true)), codecs(), signal())

		expect(animated.ok && animated.value.animated).toBe(true)

		const still = await preparePicture(source(webpX(10, 10)), codecs(), signal())

		expect(still.ok && still.value.animated).toBeUndefined()
	})

	it("reads a WebP picture's size from its header in all three forms", () => {
		expect(webpSize(webpX(5000, 4000))).toEqual({ width: 5000, height: 4000 })
		expect(webpSize(webpL(300, 200))).toEqual({ width: 300, height: 200 })
		expect(webpSize(webpLossy(640, 480))).toEqual({ width: 640, height: 480 })
		expect(webpSize(png(1, 1))).toBeUndefined()
	})

	it("converts WebP of exactly 20 megapixels and refuses one past it before decoding", async () => {
		const at = codecs()
		const converted = await preparePicture(source(webpX(5000, 4000)), at, signal())

		expect(at.webpToPng).toHaveBeenCalledTimes(1)
		expect(converted.ok && converted.value.info.format).toBe("png")

		const past = codecs()

		expect(await preparePicture(source(webpX(5000, 4001)), past, signal())).toEqual({ ok: false, refusal: "pixels" })
		expect(past.webpToPng).not.toHaveBeenCalled()
	})

	it("refuses a WebP picture whose PNG is over 25 MB, never downscaling it", async () => {
		const big = new Uint8Array(MAX_IMAGE_BYTES + 1)

		big.set(png(4000, 4000))

		const used = codecs()

		used.webpToPng.mockResolvedValueOnce(big)
		expect(await preparePicture(source(webpL(4000, 4000)), used, signal())).toEqual({ ok: false, refusal: "tooLarge" })
	})

	it("refuses a PNG past 20 megapixels by its header", async () => {
		expect(await preparePicture(source(png(5000, 4000)), codecs(), signal())).toMatchObject({ ok: true })
		expect(await preparePicture(source(png(5000, 4001)), codecs(), signal())).toEqual({ ok: false, refusal: "pixels" })
	})

	it("names HEIC and AVIF pictures, and refuses anything else Word cannot show", async () => {
		const ftyp = (brand: string): Uint8Array =>
			new Uint8Array([0, 0, 0, 24, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0, ...ascii("mif1heic")])

		expect(await preparePicture(source(ftyp("heic")), codecs(), signal())).toEqual({ ok: false, refusal: "heic" })
		expect(await preparePicture(source(ftyp("mif1")), codecs(), signal())).toEqual({ ok: false, refusal: "heic" })
		expect(await preparePicture(source(ftyp("avif")), codecs(), signal())).toEqual({ ok: false, refusal: "avif" })
		expect(await preparePicture(source(new Uint8Array(ascii("%PDF-1.7 ..."))), codecs(), signal())).toEqual({
			ok: false,
			refusal: "format"
		})
	})

	it("gives an SVG picture its PNG at its own size", async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>')
		const used = codecs()
		const prepared = await preparePicture(source(svg), used, signal())

		expect(used.svgToPng).toHaveBeenCalledWith(svg, { width: 120, height: 80 }, expect.any(AbortSignal))
		expect(prepared.ok && prepared.value.info.format).toBe("svg")
		expect(prepared.ok && prepared.value.fallback?.length).toBeGreaterThan(0)
	})

	it("draws an SVG's PNG within the pixel limit", () => {
		expect(svgFallbackSize(120, 80)).toEqual({ width: 120, height: 80 })

		const large = svgFallbackSize(10_000, 10_000)

		expect(large.width * large.height).toBeLessThanOrEqual(20_000_000)
		expect(large.width).toBe(large.height)
	})

	it("refuses a picture a codec fails on, and rejects once cancelled", async () => {
		const failing = codecs()

		failing.webpToPng.mockRejectedValueOnce(new Error("decode"))
		expect(await preparePicture(source(webpL(10, 10)), failing, signal())).toEqual({ ok: false, refusal: "failed" })

		const controller = new AbortController()
		const slow: PictureSource = {
			size: 10,
			read: () => {
				controller.abort()

				return Promise.resolve(png(1, 1))
			}
		}

		await expect(preparePicture(slow, codecs(), controller.signal)).rejects.toThrow()
	})
})

describe("insertPicture", () => {
	const picture: PreparedPicture = {
		bytes: png(4, 4),
		info: { format: "svg", contentType: "image/svg+xml", extension: "svg", width: 4, height: 4, dpiX: 96, dpiY: 96 },
		fallback: png(4, 4)
	}

	function media(handles: (number | undefined)[]) {
		return { addMedia: vi.fn(() => handles.shift()), releaseMedia: vi.fn() }
	}

	it("inserts the picture with its fallback and keeps the media", () => {
		const store = media([1, 2])
		const run = vi.fn((_command: DocxEditorCommand) => "inserted" as const)

		expect(insertPicture(picture, store, run)).toEqual({ status: "inserted" })
		expect(run).toHaveBeenCalledWith({ type: "image.insert", media: 1, fallback: 2 })
		expect(store.releaseMedia).not.toHaveBeenCalled()
	})

	it("refuses when the store is full, giving back what it took", () => {
		const none = media([undefined])

		expect(insertPicture(picture, none, vi.fn())).toEqual({ status: "refused", refusal: "full" })
		expect(none.releaseMedia).not.toHaveBeenCalled()

		const half = media([1, undefined])

		expect(insertPicture(picture, half, vi.fn())).toEqual({ status: "refused", refusal: "full" })
		expect(half.releaseMedia).toHaveBeenCalledWith(1)
	})

	it("gives the media back when the insert is refused or throws", () => {
		const refused = media([1, 2])

		expect(insertPicture(picture, refused, () => "refused")).toEqual({ status: "refused", refusal: "place" })
		expect(refused.releaseMedia.mock.calls).toEqual([[1], [2]])

		const thrown = media([3, 4])

		expect(() =>
			insertPicture(picture, thrown, () => {
				throw new Error("boom")
			})
		).toThrow("boom")
		expect(thrown.releaseMedia.mock.calls).toEqual([[3], [4]])
	})

	it("gives the media back once a wait for the author's name is settled", () => {
		const store = media([1, 2])
		const result = insertPicture(picture, store, () => "waiting")

		expect(store.releaseMedia).not.toHaveBeenCalled()
		expect(result.status).toBe("waiting")

		if (result.status === "waiting") {
			result.settle()
		}

		expect(store.releaseMedia.mock.calls).toEqual([[1], [2]])
	})
})

describe("isPictureFile", () => {
	function file(name: string): DriveItem {
		return narrowItem({
			uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
			stableUUID: undefined,
			parent: "parent-0000-0000-0000-000000000000" as UuidStr,
			size: 1n,
			favorited: false,
			region: "de-1",
			bucket: "filen-1",
			timestamp: 0n,
			chunks: 1n,
			canMakeThumbnail: false,
			meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "key", version: 2 } }
		} satisfies SdkFile)
	}

	it("offers pictures (HEIC too, refused with its reason) and Word's own formats, nothing else", () => {
		const dir = narrowItem({
			uuid: "dir-0000-0000-0000-000000000000" as UuidStr,
			parent: "parent-0000-0000-0000-000000000000" as UuidStr,
			color: "default",
			timestamp: 0n,
			favorited: false,
			meta: { type: "decoded", data: { name: "Photos" } }
		} satisfies Dir)

		expect(["a.png", "b.JPG", "c.webp", "d.svg", "e.heic", "f.tiff", "g.emf"].map(name => isPictureFile(file(name)))).toEqual([
			true,
			true,
			true,
			true,
			true,
			true,
			true
		])
		expect(isPictureFile(file("notes.docx"))).toBe(false)
		expect(isPictureFile(dir)).toBe(false)
		// Only our own decoders read it: Word could not show it.
		expect(isPictureFile(file("h.qoi"))).toBe(false)
	})
})

describe("useDocxImageInsert", () => {
	function snapshot(): DocxEditorSnapshot {
		return {
			version: 1,
			readOnly: false,
			readOnlyReasons: [],
			dirty: false,
			canUndo: false,
			canRedo: false,
			selection: { empty: true, from: 1, to: 1, locked: null, paragraphs: 1 },
			formats: { bold: "off", italic: "off", underline: "off", strike: "off" },
			paragraph: { style: "normal", styleName: null, align: "start", list: "none", level: null },
			values: NO_VALUES,
			context: {
				story: { kind: "body", index: 0 },
				table: null,
				drawing: null,
				control: null,
				field: null,
				link: null,
				comment: null,
				equation: null
			},
			review: NO_REVIEW,
			enabled: new Proxy({}, { get: () => true }) as DocxEditorSnapshot["enabled"]
		}
	}

	function setup(inserts: boolean) {
		const state = { doc: {} }
		const editor = {
			get state() {
				return state
			},
			subscribe: vi.fn(() => () => undefined),
			select: vi.fn()
		} as unknown as PagedEditor
		const addMedia = vi.fn((_chunks: unknown, _info: unknown) => 7)
		const releaseMedia = vi.fn()
		const host = { addMedia, releaseMedia } as unknown as DocxEditingHost
		const execute = vi.fn(() => {
			if (inserts) {
				state.doc = {}
			}
		})
		const hook = renderHook(() =>
			useDocxImageInsert({
				host,
				editor,
				handleRef: { current: null },
				snapshot: snapshot(),
				readOnly: false,
				execute,
				surface: "pages",
				inputRequest: null,
				requestInput: vi.fn(),
				onInputDone: vi.fn()
			})
		)

		return { hook, addMedia, releaseMedia, execute }
	}

	const picked = (): File => new File([png(8, 8) as Uint8Array<ArrayBuffer>], "shot.png", { type: "image/png" })

	it("inserts a pasted picture with no text, and leaves text with pictures to the editor", async () => {
		const { hook, addMedia, releaseMedia, execute } = setup(true)

		expect(hook.result.current.paste({ text: "copied", files: [picked()] })).toBe(false)

		await act(async () => {
			expect(hook.result.current.paste({ files: [picked()] })).toBe(true)
			await vi.waitFor(() => {
				expect(execute).toHaveBeenCalledWith({ type: "image.insert", media: 7 })
			})
		})

		expect(addMedia).toHaveBeenCalledWith(expect.any(Uint8Array), { contentType: "image/png", name: "shot.png" })
		expect(releaseMedia).not.toHaveBeenCalled()
	})

	it("inserts the picture of a copied image (its HTML only the <img>), but not one of copied text", async () => {
		expect(
			htmlHoldsOnlyImages(
				'<html><body><!--StartFragment--><img src="https://example.com/a.png" alt="a"/><!--EndFragment--></body></html>'
			)
		).toBe(true)
		expect(htmlHoldsOnlyImages('<meta charset="utf-8"><p><img src="a.png"> caption</p>')).toBe(false)
		expect(htmlHoldsOnlyImages("<p>text</p>")).toBe(false)
		expect(htmlHoldsOnlyImages(undefined)).toBe(false)

		const { hook, execute } = setup(true)

		await act(async () => {
			expect(
				hook.result.current.paste({
					text: "https://example.com/a.png",
					html: '<img src="https://example.com/a.png">',
					files: [picked()]
				})
			).toBe(true)
			await vi.waitFor(() => {
				expect(execute).toHaveBeenCalledWith({ type: "image.insert", media: 7 })
			})
		})
		expect(hook.result.current.paste({ text: "Some words", html: '<p>Some words <img src="a.png"></p>', files: [picked()] })).toBe(
			false
		)
	})

	it("says an animated WebP went in as its first frame", async () => {
		const { hook } = setup(true)
		const animated = new File([webpX(10, 10, true) as Uint8Array<ArrayBuffer>], "loop.webp", { type: "image/webp" })

		await act(async () => {
			hook.result.current.paste({ files: [animated] })
			await vi.waitFor(() => {
				expect(toasts.info).toHaveBeenCalledWith("This picture is animated. Its first frame was inserted.")
			})
		})
	})

	it("reads a drive picture through the SDK, never into the preview cache; HEIC never downloads", async () => {
		const drive = (name: string): DriveItem =>
			narrowItem({
				uuid: `${name}-0000-0000-0000-000000000000` as UuidStr,
				stableUUID: undefined,
				parent: "parent-0000-0000-0000-000000000000" as UuidStr,
				size: 100n,
				favorited: false,
				region: "de-1",
				bucket: "filen-1",
				timestamp: 0n,
				chunks: 1n,
				canMakeThumbnail: false,
				meta: { type: "decoded", data: { name, mime: "image/png", modified: 0n, size: 100n, key: "key", version: 2 } }
			} satisfies SdkFile)

		sdk.downloadFileBytes.mockResolvedValue(png(8, 8))

		const prepared = await preparePicture(driveSource(drive("a.png")), codecs(), signal())

		expect(prepared.ok).toBe(true)
		expect(sdk.downloadFileBytes).toHaveBeenCalledTimes(1)
		expect(previewCache.loadPreviewBytes).not.toHaveBeenCalled()
		expect(await preparePicture(driveSource(drive("b.heic")), codecs(), signal())).toEqual({ ok: false, refusal: "heic" })
		expect(sdk.downloadFileBytes).toHaveBeenCalledTimes(1)
	})

	it("gives the media back when the host does not run the insert", async () => {
		const { hook, releaseMedia } = setup(false)

		await act(async () => {
			hook.result.current.paste({ files: [picked()] })
			await vi.waitFor(() => {
				expect(releaseMedia).toHaveBeenCalledWith(7)
			})
		})

		expect(toasts.error).toHaveBeenCalledWith("A picture can't be inserted here.")
	})

	it("refuses a dropped file over 25 MB without reading it", async () => {
		const { hook, addMedia } = setup(true)
		const huge = picked()

		Object.defineProperty(huge, "size", { value: MAX_IMAGE_BYTES + 1 })

		const read = vi.spyOn(huge, "arrayBuffer")
		const event = {
			dataTransfer: { files: [huge], types: ["Files"] },
			clientX: 0,
			clientY: 0,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn()
		}

		await act(async () => {
			hook.result.current.handlers.onDropCapture?.(event as never)
			await vi.waitFor(() => {
				expect(toasts.error).toHaveBeenCalledWith(expect.stringContaining("25 MB"))
			})
		})

		expect(event.preventDefault).toHaveBeenCalled()
		expect(read).not.toHaveBeenCalled()
		expect(addMedia).not.toHaveBeenCalled()
	})
})
