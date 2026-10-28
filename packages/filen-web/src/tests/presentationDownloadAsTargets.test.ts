import { describe, expect, it } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	DOWNLOAD_AS_TARGETS,
	canDownloadAs,
	downloadAsFormat,
	downloadAsSource,
	downloadAsTargets
} from "@/features/drive/lib/downloadAs.logic"

// Download as for presentations: every deck the presentation viewer opens exports from its engine at any size (the
// viewer reads decks in ranges), a PowerPoint deck to .odp, an OpenDocument one to .pptx, a 97–2003 one to either;
// never to a PDF from the item menus, and in a mixed selection only what every file converts to.

function file(name: string, size = 1_024n): DriveItem {
	return narrowItem({
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size, key: "key", version: 2 }
		}
	} satisfies File)
}

const POWERPOINT = ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"]
const OPENDOCUMENT = ["odp", "otp"]
const LEGACY = ["ppt", "pps", "pot"]

describe("presentation Download as", () => {
	it("exports every deck the presentation viewer opens from the presentation engine, at any size", () => {
		for (const extension of [...POWERPOINT, ...OPENDOCUMENT, ...LEGACY]) {
			expect(downloadAsSource(file(`deck.${extension}`)), extension).toBe("presentation")
		}

		expect(downloadAsSource(file("deck.pptx", 4n * 1024n * 1024n * 1024n))).toBe("presentation")
		expect(downloadAsSource(file("deck.key"))).toBeNull()
	})

	it("reads each deck's format from its extension: the PowerPoint family, OpenDocument, 97–2003", () => {
		for (const extension of POWERPOINT) expect(downloadAsFormat(file(`a.${extension}`)), extension).toBe("pptx")
		for (const extension of OPENDOCUMENT) expect(downloadAsFormat(file(`a.${extension}`)), extension).toBe("odp")
		for (const extension of LEGACY) expect(downloadAsFormat(file(`a.${extension}`)), extension).toBe("ppt")
	})

	it("offers a PDF of every deck, and .odp for a PowerPoint deck, .pptx for an OpenDocument one, both for a 97–2003 one", () => {
		for (const extension of POWERPOINT) expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["odp"]])
		for (const extension of OPENDOCUMENT) expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["pptx"]])
		for (const extension of LEGACY) expect(downloadAsTargets([file(`a.${extension}`)]), extension).toEqual([["pdf"], ["pptx", "odp"]])
	})

	it("offers in bulk only what every file exports to: decks mixed with documents to a PDF alone", () => {
		expect(downloadAsTargets([file("a.pptx"), file("b.ppt")])).toEqual([["pdf"], ["odp"]])
		expect(downloadAsTargets([file("a.odp"), file("b.pps")])).toEqual([["pdf"], ["pptx"]])
		expect(downloadAsTargets([file("a.pptx"), file("b.odp")])).toEqual([["pdf"]])
		expect(downloadAsTargets([file("a.pptx"), file("b.docx")])).toEqual([["pdf"]])
		expect(canDownloadAs([file("a.ppt"), file("b.xlsx")])).toBe(true)
	})

	it("names the downloads by the target's extension", () => {
		expect(DOWNLOAD_AS_TARGETS.pptx.extension).toBe("pptx")
		expect(DOWNLOAD_AS_TARGETS.odp.extension).toBe("odp")
	})
})
