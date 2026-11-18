// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { Ambiguity, AmbiguityTable } from "@filen/shared"
import "@/lib/i18n"

// A row whose usual meaning is no kind at all (a `.zzz` that a read may find to be a PDF), with a head read, and an
// extensionless read: the gate admits such a file on every surface, runs its read before the viewer, and leaves it
// unknown on the negative verdict.

const ROW: Ambiguity = { fallback: "zzz", wordBinary: "pdf", notWordBinary: null, mimeHint: false, sniff: "wordTemplate" }
const TABLE: AmbiguityTable = new Map([["zzz", ROW]])

vi.mock("@filen/shared", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/shared")>()

	return {
		...actual,
		resolveFileKind: (...args: Parameters<typeof actual.resolveFileKind>) => actual.resolveFileKind(args[0], args[1], TABLE),
		verdictChangesKind: (...args: Parameters<typeof actual.verdictChangesKind>) =>
			actual.verdictChangesKind(args[0], args[1], args[2], TABLE),
		sniffForExtension: (extension: string) => actual.sniffForExtension(extension, TABLE),
		sniffCandidates: (extension: string) => actual.sniffCandidates(extension, TABLE)
	}
})

const decide = vi.fn((head: Uint8Array) => (head[0] === 0x25 ? "wordBinary" : "notWordBinary"))

vi.mock("@/features/preview/lib/contentSniff.logic", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/preview/lib/contentSniff.logic")>()

	return {
		...actual,
		SNIFFERS: { ...actual.SNIFFERS, wordTemplate: { mode: "head", headBytes: 4, decide } },
		EXTENSIONLESS_SNIFF: { id: "wordTemplate", cap: 1_000n }
	}
})

const { canOpenAsText, canPreview, needsContentSniff, previewType } = await import("@/features/drive/lib/preview.logic")
const { anonPreviewability } = await import("@/features/publicLinks/lib/download.logic")
const { canOpenEntry, entryAwaitsSniff, sniffedEntryCategory } = await import("@/features/archive/lib/entryAccess.logic")
const { ContentSniffGate } = await import("@/features/preview/components/contentSniffGate")
const { PreviewByteOriginProvider } = await import("@/features/preview/lib/accessMode")
const { bytesOrigin } = await import("@/lib/sdk/byteOrigin")
const { recordFileKindVerdict, resetFileKindVerdicts } = await import("@/features/drive/lib/fileKindVerdicts")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")
const { storeOf } = await import("@/tests/support/archiveEntries")

const DIRECT = { type: "direct", packedBytes: 10n } as const
const PDF_HEAD = [0x25, 0x50, 0x44, 0x46]

function gate(item: ReturnType<typeof linkedFileItem>, bytes: number[], asText = false): ReactNode {
	return createElement(PreviewByteOriginProvider, {
		origin: bytesOrigin(new Blob([new Uint8Array(bytes)]), `${item.data.uuid}/part`),
		children: createElement(ContentSniffGate, { item, asText, render: () => createElement("p", null, `viewer:${previewType(item)}`) })
	})
}

afterEach(() => {
	cleanup()
	resetFileKindVerdicts()
	vi.clearAllMocks()
})

describe("an ambiguous extension whose usual meaning is no kind", () => {
	const item = linkedFileItem("scan.zzz", { uuid: "e1000000-0000-0000-0000-000000000000", size: 300n })

	it("is admitted on the drive, a public link, an archive's entry and as text", () => {
		expect(previewType(item)).toBe("other")
		expect(needsContentSniff(item)).toBe("wordTemplate")
		expect(canPreview(item)).toBe(true)
		expect(anonPreviewability(item)).toBe("previewable")

		const store = storeOf([{ path: "scan.zzz", access: DIRECT, size: 300 }])

		expect(entryAwaitsSniff(store, 0)).toBe(true)
		expect(canOpenEntry(store, 0)).toBe(true)
		expect(canOpenAsText(item)).toBe(true)
	})

	// A PDF opens in ranges up to the device's ranged ceiling (8 GiB on a desktop).
	it("is refused where none of its meanings opens at its size", () => {
		const huge = linkedFileItem("scan.zzz", { uuid: "e2000000-0000-0000-0000-000000000000", size: 9n * 1024n * 1024n * 1024n })

		expect(canPreview(huge)).toBe(false)
		expect(anonPreviewability(huge)).toBe("too-large")
	})

	it("opens in the viewer its read found", async () => {
		render(gate(item, PDF_HEAD))

		await waitFor(() => {
			expect(screen.getByText("viewer:pdf")).toBeTruthy()
		})
		expect(decide).toHaveBeenCalledOnce()
		expect(sniffedEntryCategory(item, bytesOrigin(new Blob([]), "part"))).toBe("pdf")
	})

	it("stays unknown on the negative verdict, read once", async () => {
		const other = linkedFileItem("notes.zzz", { uuid: "e3000000-0000-0000-0000-000000000000", size: 300n })

		render(gate(other, [1, 2, 3, 4]))

		await waitFor(() => {
			expect(screen.getByText("viewer:other")).toBeTruthy()
		})
		expect(decide).toHaveBeenCalledOnce()
		expect(sniffedEntryCategory(other, bytesOrigin(new Blob([]), "part"))).toBeNull()
	})

	it("opens as text at once, reading nothing", () => {
		render(gate(item, PDF_HEAD, true))

		expect(screen.getByText("viewer:other")).toBeTruthy()
		expect(decide).not.toHaveBeenCalled()
	})
})

describe("the extensionless read", () => {
	it("admits a file nothing names under its cap, and leaves it unknown on the negative verdict", () => {
		const blob = linkedFileItem("blob", { uuid: "e4000000-0000-0000-0000-000000000000", size: 300n })

		expect(needsContentSniff(blob)).toBe("wordTemplate")
		expect(canPreview(blob)).toBe(true)
		expect(anonPreviewability(blob)).toBe("previewable")
		expect(canPreview(linkedFileItem("blob", { uuid: "e5000000-0000-0000-0000-000000000000", size: 1_001n }))).toBe(false)

		recordFileKindVerdict(blob.data.uuid, "notWordBinary")

		expect(needsContentSniff(blob)).toBeNull()
		expect(canPreview(blob)).toBe(false)
		expect(previewType(blob)).toBe("other")
		expect(canOpenAsText(blob)).toBe(true)
	})
})
