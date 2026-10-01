// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { BlockSource, bytesReadRange, type ReadRange } from "@/lib/media/blockSource"
import { classifyMediaError, mediaFailureDTO, reportMediaFailure, type MediaFailureKind } from "@/lib/media/mediaFailure"
import { errorLabel } from "@/lib/i18n/errorLabel"

const MEDIA_ERR_ABORTED = 1
const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

function readable(size = 16): BlockSource {
	return new BlockSource(size, bytesReadRange(new Uint8Array(size)))
}

function unreadable(): { source: BlockSource; read: ReturnType<typeof vi.fn<ReadRange>> } {
	const read = vi.fn<ReadRange>(() => Promise.reject(new Error("range read answered 404")))

	return { source: new BlockSource(16, read), read }
}

describe("classifyMediaError", () => {
	it("blames the format for a decode error without reading the file", async () => {
		const { source, read } = unreadable()

		expect(await classifyMediaError(MEDIA_ERR_DECODE, source)).toBe("format")
		expect(read).not.toHaveBeenCalled()
	})

	it("never blames the format for a network or aborted fetch", async () => {
		expect(await classifyMediaError(MEDIA_ERR_NETWORK, readable())).toBe("other")
		expect(await classifyMediaError(MEDIA_ERR_ABORTED, readable())).toBe("other")
	})

	it("tells an unplayable source from an unreachable one by reading its first bytes", async () => {
		const { source, read } = unreadable()

		expect(await classifyMediaError(MEDIA_ERR_SRC_NOT_SUPPORTED, readable())).toBe("format")
		expect(await classifyMediaError(MEDIA_ERR_SRC_NOT_SUPPORTED, source)).toBe("other")
		expect(read).toHaveBeenCalledTimes(1)
	})

	it("blames the format for an empty file, which has nothing to read", async () => {
		const read = vi.fn<ReadRange>()

		expect(await classifyMediaError(MEDIA_ERR_SRC_NOT_SUPPORTED, new BlockSource(0, read))).toBe("format")
		expect(read).not.toHaveBeenCalled()
	})
})

describe("mediaFailureDTO", () => {
	it("labels each kind through the errors catalog", () => {
		expect(errorLabel(mediaFailureDTO("format"))).toBe("Your browser can't play this file's format.")
		expect(errorLabel(mediaFailureDTO("other"))).toBe("This file couldn't be played.")
	})
})

function failedElement(code: number | null): HTMLMediaElement {
	const element = document.createElement("video")
	const error = code === null ? null : ({ code } as MediaError)

	Object.defineProperty(element, "error", { configurable: true, get: () => error })

	return element
}

describe("reportMediaFailure", () => {
	it("reports a failure once it is classified", async () => {
		const onFailure = vi.fn<(kind: MediaFailureKind) => void>()

		reportMediaFailure(failedElement(MEDIA_ERR_SRC_NOT_SUPPORTED), readable(), onFailure)

		await vi.waitFor(() => {
			expect(onFailure).toHaveBeenCalledExactlyOnceWith("format")
		})
	})

	it("drops a failure whose element has moved on to another source by the time it is classified", async () => {
		const element = failedElement(MEDIA_ERR_SRC_NOT_SUPPORTED)
		const onFailure = vi.fn<(kind: MediaFailureKind) => void>()
		let release: (() => void) | undefined
		const source = new BlockSource(
			4,
			() =>
				new Promise<Uint8Array>(resolve => {
					release = () => {
						resolve(new Uint8Array(4))
					}
				})
		)

		reportMediaFailure(element, source, onFailure)
		// A new src resets the element's error.
		Object.defineProperty(element, "error", { configurable: true, get: () => null })
		release?.()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(onFailure).not.toHaveBeenCalled()
	})

	it("ignores an error event with no error on the element", async () => {
		const onFailure = vi.fn<(kind: MediaFailureKind) => void>()

		reportMediaFailure(failedElement(null), readable(), onFailure)
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(onFailure).not.toHaveBeenCalled()
	})
})
