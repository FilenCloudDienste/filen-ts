import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { FileVerdict } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { recordFileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import {
	canOpenAsText,
	canPreview,
	contentSniffFor,
	needsContentSniff,
	PREVIEW_MAX_BYTES,
	previewType,
	sniffAdmits,
	sniffAdmitsFor,
	TEXT_MAX_BYTES
} from "@/features/drive/lib/preview.logic"
import { anonPreviewability } from "@/features/publicLinks/lib/download.logic"
import { canOpenEntry, entryAwaitsSniff } from "@/features/archive/lib/entryAccess.logic"
import { EXTENSIONLESS_SNIFF, gateRunsSniffer, isVirtualDiskHead, SNIFFERS } from "@/features/preview/lib/contentSniff.logic"
import { deviceProfile } from "@/lib/deviceProfile"
import { legacyUnprobedTransportStream, legacyUnsniffedTemplate } from "@/tests/support/legacySniff"
import { storeOf } from "@/tests/support/archiveEntries"
import { testUuid } from "@/tests/support/uuid"

const MIB = 1024n * 1024n

function fileNamed(name: string, size: bigint, mime: string | null = "application/octet-stream"): DriveItem {
	const uuid: UuidStr = testUuid(`${name}:${String(size)}:${mime ?? ""}`)
	const file: File = {
		uuid,
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime: mime ?? "", modified: 1_700_000_000_000n, size, key: "key", version: 2 } }
	}

	return narrowItem(file)
}

const NAMES = ["clip.ts", "CLIP.TS", "lib.d.ts", "module.mts", "graph.dot", "MEMO.DOT", "deck.pot", "notes.txt", "talk.webm", "blob"]
const SIZES = [0n, 4_000n, MIB - 1n, MIB, 40n * MIB, 300n * MIB]
const MIMES = [null, "application/octet-stream", "video/mp2t", "text/plain", "text/vnd.graphviz", "application/msword", "audio/webm"]
const VERDICTS: (FileVerdict | null)[] = [
	null,
	"transportStream",
	"notTransportStream",
	"wordBinary",
	"notWordBinary",
	"presentationBinary",
	"notPresentationBinary",
	"audio",
	"video"
]

describe("needsContentSniff", () => {
	it("asks for exactly the reads the .ts and template checks it replaced asked for", () => {
		for (const name of NAMES) {
			for (const size of SIZES) {
				for (const mime of MIMES) {
					const item = fileNamed(name, size, mime)

					for (const verdict of VERDICTS) {
						const sniff = needsContentSniff(item, verdict)
						const label = `${name} ${String(size)} ${String(mime)} ${String(verdict)}`

						expect(sniff === "transportStream", label).toBe(legacyUnprobedTransportStream(item, verdict))
						expect(sniff === "wordTemplate" || sniff === "presentationTemplate", label).toBe(
							legacyUnsniffedTemplate(item, verdict)
						)
					}
				}
			}
		}
	})

	it("names the read by the extension's row", () => {
		expect(needsContentSniff(fileNamed("clip.ts", 4n * MIB), null)).toBe("transportStream")
		expect(needsContentSniff(fileNamed("graph.dot", 300n), null)).toBe("wordTemplate")
		expect(needsContentSniff(fileNamed("messages.pot", 300n), null)).toBe("presentationTemplate")
		expect(needsContentSniff(fileNamed("talk.webm", 300n), null)).toBeNull()
	})

	// VHDL source or a Virtual Hard Disk: code until its head says it is a disk, which nothing previews.
	it("reads a .vhd's head before opening it as code", () => {
		const source = fileNamed("alu.vhd", 3_000n, "text/x-vhdl")

		expect(needsContentSniff(source, null)).toBe("virtualDisk")
		expect(previewType(source, null)).toBe("code")
		expect(needsContentSniff(source, "notVirtualDisk")).toBeNull()
		expect(previewType(source, "notVirtualDisk")).toBe("code")
		expect(needsContentSniff(source, "virtualDisk")).toBeNull()
		expect(previewType(source, "virtualDisk")).toBe("other")

		const disk = fileNamed("disk.vhd", 3_000n)

		expect(canPreview(disk)).toBe(true)
		recordFileKindVerdict(disk.data.uuid, "virtualDisk")
		expect(canPreview(disk)).toBe(false)
		expect(needsContentSniff(fileNamed("alu.vhdl", 3_000n), null)).toBeNull()
	})

	it("ships no extensionless read", () => {
		expect(EXTENSIONLESS_SNIFF).toBeNull()
		expect(needsContentSniff(fileNamed("blob", 300n), null)).toBeNull()
	})

	it("runs an extensionless read under its cap, for a file nothing names and no verdict settled", () => {
		const hook = { id: "transportStream", cap: TEXT_MAX_BYTES } as const

		expect(needsContentSniff(fileNamed("blob", 300n), null, hook)).toBe("transportStream")
		expect(needsContentSniff(fileNamed("blob", TEXT_MAX_BYTES + 1n), null, hook)).toBeNull()
		expect(needsContentSniff(fileNamed("blob", 300n), "notTransportStream", hook)).toBeNull()
		// A name or a MIME type that says what it is.
		expect(needsContentSniff(fileNamed("Makefile", 300n), null, hook)).toBeNull()
		expect(needsContentSniff(fileNamed("blob", 300n, "image/png"), null, hook)).toBeNull()
		// An extension, known or not.
		expect(needsContentSniff(fileNamed("blob.zzz", 300n), null, hook)).toBeNull()
		expect(needsContentSniff(fileNamed("notes.txt", 300n), null, hook)).toBeNull()
	})
})

describe("sniffAdmits", () => {
	it("admits a .ts that may be a transport stream at any size: one streams", () => {
		for (const surface of ["drive", "link"] as const) {
			expect(sniffAdmits(fileNamed("clip.ts", 50n * 1024n * MIB), deviceProfile(), surface)).toBe(true)
		}
	})

	it("admits a template up to the larger of its meanings' caps", () => {
		for (const surface of ["drive", "link", "entry"] as const) {
			expect(sniffAdmits(fileNamed("graph.dot", PREVIEW_MAX_BYTES), deviceProfile(), surface)).toBe(true)
			expect(sniffAdmits(fileNamed("graph.dot", PREVIEW_MAX_BYTES + 1n), deviceProfile(), surface)).toBe(false)
			expect(sniffAdmits(fileNamed("deck.pot", PREVIEW_MAX_BYTES + 1n), deviceProfile(), surface)).toBe(surface === "drive")
		}
	})

	// A disk image opens nowhere, so only the text cap admits one: a fixed disk above it is refused before any read.
	it("admits a .vhd up to the text cap", () => {
		for (const surface of ["drive", "link", "entry"] as const) {
			expect(sniffAdmits(fileNamed("alu.vhd", TEXT_MAX_BYTES), deviceProfile(), surface)).toBe(true)
			expect(sniffAdmits(fileNamed("disk.vhd", TEXT_MAX_BYTES + 1n), deviceProfile(), surface)).toBe(false)
		}

		expect(canPreview(fileNamed("disk.vhd", 2n * 1024n * MIB))).toBe(false)
	})

	it("admits an archive's .ts as the code it opens as there: an entry never streams", () => {
		const subject = { name: "clip.ts", mime: null, verdict: null }

		expect(sniffAdmitsFor({ ...subject, size: TEXT_MAX_BYTES }, deviceProfile(), "entry")).toBe(true)
		expect(sniffAdmitsFor({ ...subject, size: TEXT_MAX_BYTES + 1n }, deviceProfile(), "entry")).toBe(false)
		expect(contentSniffFor({ ...subject, size: 4n * MIB })).toBe("transportStream")
	})

	it("is what the gates answer for a file waiting on its read", () => {
		for (const size of [MIB, TEXT_MAX_BYTES + 1n, PREVIEW_MAX_BYTES + 1n]) {
			for (const name of ["clip.ts", "graph.dot", "deck.pot"]) {
				const item = fileNamed(name, size)

				expect(canPreview(item), `${name} ${String(size)}`).toBe(sniffAdmits(item, deviceProfile(), "drive"))
				expect(anonPreviewability(item) === "previewable", `${name} ${String(size)}`).toBe(
					sniffAdmits(item, deviceProfile(), "link")
				)
				expect(canOpenAsText(item)).toBe(false)
			}
		}
	})
})

describe("SNIFFERS", () => {
	it("runs a .ts's probe in front of a drive or link file's viewer only, and a template's read in its viewer", () => {
		expect(["file", "linkedFile", "entry", "bytes"].map(origin => gateRunsSniffer(SNIFFERS.transportStream, origin as "file"))).toEqual(
			[true, true, false, false]
		)
		expect(gateRunsSniffer(SNIFFERS.wordTemplate, "file")).toBe(false)
		expect(gateRunsSniffer(SNIFFERS.presentationTemplate, "entry")).toBe(false)
	})

	it("reads a .vhd's first 512 bytes in front of its viewer, from any origin", () => {
		const sniffer = SNIFFERS.virtualDisk

		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(512)
		expect(["file", "linkedFile", "entry", "bytes"].map(origin => gateRunsSniffer(sniffer, origin as "file"))).toEqual([
			true,
			true,
			true,
			true
		])
	})

	it("finds a Virtual Hard Disk by its footer copy's cookie", () => {
		const encode = (text: string) => new TextEncoder().encode(text)
		const disk = new Uint8Array(512)

		disk.set(encode("conectix"))

		expect(isVirtualDiskHead(disk)).toBe(true)
		expect(isVirtualDiskHead(encode("library ieee;\nuse ieee.std_logic_1164.all;"))).toBe(false)
		expect(isVirtualDiskHead(encode("conecti"))).toBe(false)
		expect(isVirtualDiskHead(new Uint8Array())).toBe(false)

		if (SNIFFERS.virtualDisk.mode === "head") {
			expect(SNIFFERS.virtualDisk.decide(disk, 512)).toBe("virtualDisk")
			expect(SNIFFERS.virtualDisk.decide(encode("entity alu is"), 13)).toBe("notVirtualDisk")
		}
	})

	it("leaves an archive's .ts and template to the viewer their names pick", () => {
		const DIRECT = { type: "direct", packedBytes: 10n } as const

		for (const path of ["clip.ts", "graph.dot", "deck.pot"]) {
			const store = storeOf([{ path, access: DIRECT, size: Number(4n * MIB) }])

			expect(entryAwaitsSniff(store, 0), path).toBe(false)
			expect(canOpenEntry(store, 0), path).toBe(true)
		}
	})
})
