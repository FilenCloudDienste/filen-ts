import { describe, expect, it, vi } from "vitest"
import {
	HEIC_CONVERTED_BACKLOG,
	heicUploadConversionEnabled,
	isHeicUploadCandidate,
	maybeConvertHeicUpload,
	renameToJpg,
	type HeicUploadConvertDeps,
	type HeicUploadDeps,
	withConvertedHeic
} from "@/features/drive/lib/heicUpload"

function mockFile(name: string, bytes = new Uint8Array([1, 2, 3])): File {
	return new File([bytes], name)
}

describe("isHeicUploadCandidate", () => {
	it("is true for a .heic file, case-insensitive", () => {
		expect(isHeicUploadCandidate(mockFile("photo.heic"))).toBe(true)
		expect(isHeicUploadCandidate(mockFile("PHOTO.HEIC"))).toBe(true)
	})

	it("is true for a .heif file", () => {
		expect(isHeicUploadCandidate(mockFile("photo.heif"))).toBe(true)
	})

	// Fujifilm's HEIF extension, written uppercase by the camera.
	it("is true for a Fujifilm .HIF file", () => {
		expect(isHeicUploadCandidate(mockFile("DSCF0001.HIF"))).toBe(true)
		expect(isHeicUploadCandidate(mockFile("DSCF0001.hif"))).toBe(true)
	})

	it("is false for a non-HEIC file, including other image formats", () => {
		expect(isHeicUploadCandidate(mockFile("photo.jpg"))).toBe(false)
		expect(isHeicUploadCandidate(mockFile("report.pdf"))).toBe(false)
		expect(isHeicUploadCandidate(mockFile("noextension"))).toBe(false)
	})
})

describe("renameToJpg", () => {
	it("swaps the extension for .jpg", () => {
		expect(renameToJpg("photo.heic")).toBe("photo.jpg")
		expect(renameToJpg("photo.HEIC")).toBe("photo.jpg")
		expect(renameToJpg("DSCF0001.HIF")).toBe("DSCF0001.jpg")
	})

	it("preserves dots within the base name, only swapping the trailing extension", () => {
		expect(renameToJpg("vacation.2024.heic")).toBe("vacation.2024.jpg")
	})

	it("appends .jpg to a name with no extension at all", () => {
		expect(renameToJpg("noextension")).toBe("noextension.jpg")
	})
})

describe("maybeConvertHeicUpload", () => {
	function harness(): { deps: HeicUploadConvertDeps; transform: ReturnType<typeof vi.fn> } {
		const transform = vi.fn<HeicUploadConvertDeps["transform"]>()
		return { deps: { transform }, transform }
	}

	it("returns the original File untouched when the preference is off, without reading any bytes", async () => {
		const h = harness()
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, false)

		expect(result).toBe(file)
		expect(h.transform).not.toHaveBeenCalled()
	})

	it("returns the original File untouched for a non-HEIC name, even with the preference on", async () => {
		const h = harness()
		const file = mockFile("photo.jpg")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).toBe(file)
		expect(h.transform).not.toHaveBeenCalled()
	})

	it("converts a HEIC file to a renamed, image/jpeg-typed File when enabled", async () => {
		const h = harness()
		const jpegBytes = new Blob([new Uint8Array([9, 9, 9])], { type: "image/jpeg" })
		h.transform.mockResolvedValue(jpegBytes)
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).not.toBe(file)
		expect(result.name).toBe("photo.jpg")
		expect(result.type).toBe("image/jpeg")
		expect(h.transform).toHaveBeenCalledTimes(1)
	})

	it("preserves the original lastModified timestamp on the converted File", async () => {
		const h = harness()
		h.transform.mockResolvedValue(new Blob([new Uint8Array([1])]))
		const file = new File([new Uint8Array([1, 2, 3])], "photo.heic", { lastModified: 1_700_000_000_000 })

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result.lastModified).toBe(1_700_000_000_000)
	})

	// A batch starts every conversion at once; only two may hold a source buffer at a time.
	it("converts at most two files at a time, reading the next only as one finishes", async () => {
		const pending: (() => void)[] = []
		const transform = vi.fn<HeicUploadConvertDeps["transform"]>(
			() =>
				new Promise<Blob>(resolve => {
					pending.push(() => {
						resolve(new Blob([new Uint8Array([9])]))
					})
				})
		)
		const files = ["a", "b", "c", "d", "e"].map(name => mockFile(`${name}.heic`))

		const all = Promise.all(files.map(file => maybeConvertHeicUpload({ transform }, file, true)))

		await vi.waitFor(() => {
			expect(transform).toHaveBeenCalledTimes(2)
		})
		await new Promise(resolve => setTimeout(resolve, 10))
		expect(transform).toHaveBeenCalledTimes(2)

		pending.shift()?.()

		await vi.waitFor(() => {
			expect(transform).toHaveBeenCalledTimes(3)
		})

		while (pending.length > 0 || transform.mock.calls.length < files.length) {
			pending.shift()?.()
			await new Promise(resolve => setTimeout(resolve, 0))
		}

		const results = await all

		expect(results.map(file => file.name)).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"])
	})

	it("releases its slot when the transform rejects, so later files still convert", async () => {
		const h = harness()
		h.transform
			.mockRejectedValueOnce(new Error("a"))
			.mockRejectedValueOnce(new Error("b"))
			.mockResolvedValue(new Blob([new Uint8Array([1])]))

		const results = await Promise.all(["a", "b", "c"].map(name => maybeConvertHeicUpload(h.deps, mockFile(`${name}.heic`), true)))

		expect(results.map(file => file.name)).toEqual(["a.heic", "b.heic", "c.jpg"])
	})

	it("falls back to the original File when the transform rejects — an upload must never be blocked by a failed opportunistic re-encode", async () => {
		const h = harness()
		h.transform.mockRejectedValue(new Error("decode failed"))
		const file = mockFile("photo.heic")

		const result = await maybeConvertHeicUpload(h.deps, file, true)

		expect(result).toBe(file)
	})
})

describe("withConvertedHeic", () => {
	const jpeg = (): Promise<Blob> => Promise.resolve(new Blob([new Uint8Array([9])], { type: "image/jpeg" }))

	async function idle(): Promise<void> {
		for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0))
	}

	it("runs a file that needs no conversion as it is, holding nothing", async () => {
		const transform = vi.fn<HeicUploadConvertDeps["transform"]>()
		const file = mockFile("report.pdf")

		await expect(withConvertedHeic({ transform }, file, true, prepared => Promise.resolve(prepared))).resolves.toBe(file)
		expect(transform).not.toHaveBeenCalled()
	})

	it("holds at most the backlog of converted files whose upload has not settled, one more per settled upload", async () => {
		const transform = vi.fn<HeicUploadConvertDeps["transform"]>(jpeg)
		const uploads: PromiseWithResolvers<string>[] = []
		const runs = Array.from({ length: HEIC_CONVERTED_BACKLOG + 3 }, (_, index) =>
			withConvertedHeic({ transform }, mockFile(`photo${String(index)}.heic`), true, () => {
				const upload = Promise.withResolvers<string>()

				uploads.push(upload)

				return upload.promise
			})
		)
		// Handled from the start: one upload below fails long before the batch is awaited.
		const settledRuns = Promise.allSettled(runs)

		await idle()
		expect(transform).toHaveBeenCalledTimes(HEIC_CONVERTED_BACKLOG)

		uploads[0]?.resolve("done")
		await idle()
		expect(transform).toHaveBeenCalledTimes(HEIC_CONVERTED_BACKLOG + 1)

		// A failed upload gives its permit back too.
		uploads[1]?.reject(new Error("upload failed"))
		await idle()
		expect(transform).toHaveBeenCalledTimes(HEIC_CONVERTED_BACKLOG + 2)

		for (const upload of uploads) upload.resolve("done")
		await idle()
		for (const upload of uploads) upload.resolve("done")

		const settled = await settledRuns

		expect(transform).toHaveBeenCalledTimes(HEIC_CONVERTED_BACKLOG + 3)
		expect(settled.filter(result => result.status === "rejected")).toHaveLength(1)
	})

	it("gives the permit back at once for a cancelled file and for a failed conversion", async () => {
		// Cancelled while being prepared: the run answers at once without uploading.
		const cancelled = await Promise.all(
			Array.from({ length: HEIC_CONVERTED_BACKLOG * 2 }, (_, index) =>
				withConvertedHeic({ transform: jpeg }, mockFile(`c${String(index)}.heic`), true, () => Promise.resolve("cancelled"))
			)
		)

		expect(cancelled).toHaveLength(HEIC_CONVERTED_BACKLOG * 2)

		// Failed conversions upload their disk-backed originals without holding a permit.
		const failing = vi.fn<HeicUploadConvertDeps["transform"]>(() => Promise.reject(new Error("decode failed")))
		const pending = Promise.withResolvers<string>()
		const originals = Array.from({ length: HEIC_CONVERTED_BACKLOG }, (_, index) =>
			withConvertedHeic({ transform: failing }, mockFile(`f${String(index)}.heic`), true, () => pending.promise)
		)

		await idle()
		expect(failing).toHaveBeenCalledTimes(HEIC_CONVERTED_BACKLOG)

		const transform = vi.fn<HeicUploadConvertDeps["transform"]>(jpeg)

		await expect(
			withConvertedHeic({ transform }, mockFile("next.heic"), true, prepared => Promise.resolve(prepared.name))
		).resolves.toBe("next.jpg")

		pending.resolve("done")
		await Promise.all(originals)
	})
})

describe("heicUploadConversionEnabled", () => {
	function harness(preference: boolean): { deps: HeicUploadDeps; readPreference: ReturnType<typeof vi.fn> } {
		const readPreference = vi.fn<HeicUploadDeps["readPreference"]>().mockResolvedValue(preference)

		return { deps: { convert: { transform: vi.fn() }, readPreference }, readPreference }
	}

	it("is false and never reads the preference for a batch with no candidate", async () => {
		const h = harness(true)

		expect(await heicUploadConversionEnabled(h.deps, [mockFile("a.jpg"), mockFile("b.png")])).toBe(false)
		expect(h.readPreference).not.toHaveBeenCalled()
	})

	it("is false when a candidate is present but the preference is off", async () => {
		const h = harness(false)

		expect(await heicUploadConversionEnabled(h.deps, [mockFile("a.jpg"), mockFile("b.heic")])).toBe(false)
		expect(h.readPreference).toHaveBeenCalledTimes(1)
	})

	it("is true when a candidate is present and the preference is on", async () => {
		const h = harness(true)

		expect(await heicUploadConversionEnabled(h.deps, [mockFile("a.heif")])).toBe(true)
	})

	it("reads the preference exactly once for a batch holding many candidates", async () => {
		const h = harness(true)

		await heicUploadConversionEnabled(h.deps, [mockFile("a.heic"), mockFile("b.heic"), mockFile("c.heic")])

		expect(h.readPreference).toHaveBeenCalledTimes(1)
	})

	it("is false, not a rejection, when the preference read fails", async () => {
		const h = harness(true)
		h.readPreference.mockRejectedValue(new Error("db rpc timeout: kvGet"))

		expect(await heicUploadConversionEnabled(h.deps, [mockFile("a.heic")])).toBe(false)
	})

	it("never reads the preference for an empty batch", async () => {
		const h = harness(true)

		expect(await heicUploadConversionEnabled(h.deps, [])).toBe(false)
		expect(h.readPreference).not.toHaveBeenCalled()
	})
})
