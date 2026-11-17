// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, waitFor } from "@testing-library/react"
import type { File } from "@filen/sdk-rs"
import "@/lib/i18n"
import { testUuid } from "@/tests/support/uuid"

// Comparing the unsaved edits with a newer version: the edits as a save writes them begin with the file's mark, which
// the newer version's decoded text does not, so the mark never shows as a change; the newer version is read as Unicode
// where it is, else in the codepage the file was read in, else as the detector guesses.

const { compared, theirsBytes, guessed } = vi.hoisted(() => ({
	compared: [] as { theirs: string; mine: string }[],
	theirsBytes: { current: new Uint8Array(0) },
	guessed: { current: 0 }
}))

vi.mock("@filen/office/dom/code", async () => ({
	...(await vi.importActual<typeof import("@filen/office/dom/code")>("@filen/office/dom/code")),
	mountCodeCompare: ({ theirs, mine }: { theirs: string; mine: string }) => {
		compared.push({ theirs, mine })

		return () => undefined
	}
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: theirsBytes.current, refetch: vi.fn() })
}))
// The detector's wasm is not loaded here: it answers windows-1251, counting the asks.
vi.mock("@filen/encoding-detect", () => ({
	EncodingDetector: {
		instantiate: () =>
			Promise.resolve({
				guess: () => {
					guessed.current++

					return "windows-1251"
				}
			})
	}
}))

beforeEach(() => {
	vi.stubGlobal("fetch", () => Promise.resolve(new Response()))
	vi.stubGlobal("WebAssembly", { ...WebAssembly, compileStreaming: () => Promise.resolve({}) })
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
})

const { RemoteFileCompare } = await import("@/features/preview/components/remoteCompare")
const { narrowItem } = await import("@/features/drive/lib/item")

afterEach(() => {
	cleanup()
	compared.length = 0
	guessed.current = 0
})

const THEIRS = narrowItem({
	uuid: testUuid("theirs"),
	stableUUID: "lineage" as File["stableUUID"],
	parent: testUuid("parent"),
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "notes.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
})

// "При" in windows-1251.
const CYRILLIC = Uint8Array.of(0xcf, 0xf0, 0xe8)

describe("RemoteFileCompare", () => {
	it("compares a UTF-16 file with a mark without the mark", async () => {
		theirsBytes.current = Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00)

		render(
			<RemoteFileCompare
				theirs={THEIRS}
				mine={"﻿hi"}
				encoding="utf-16le"
			/>
		)

		await waitFor(() => {
			expect(compared.at(-1)).toEqual({ theirs: "hi", mine: "hi" })
		})
	})

	it("reads a legacy newer version in the codepage the file was read in", async () => {
		theirsBytes.current = CYRILLIC

		render(
			<RemoteFileCompare
				theirs={THEIRS}
				mine="x"
				encoding="koi8-r"
			/>
		)

		await waitFor(() => {
			expect(compared.at(-1)?.theirs).toBe(new TextDecoder("koi8-r").decode(CYRILLIC))
		})
		expect(guessed.current).toBe(0)
	})

	it("asks the detector when the file was read as Unicode", async () => {
		theirsBytes.current = CYRILLIC

		render(
			<RemoteFileCompare
				theirs={THEIRS}
				mine="x"
				encoding="utf-8"
			/>
		)

		await waitFor(() => {
			expect(compared.at(-1)?.theirs).toBe("При")
		})
		expect(guessed.current).toBe(1)
	})
})
