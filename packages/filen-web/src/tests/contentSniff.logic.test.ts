import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { FileVerdict } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { recordFileKindVerdict } from "@/features/drive/lib/fileKindVerdicts"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
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
import {
	EXTENSIONLESS_SNIFF,
	gateRunsSniffer,
	isMpegPackHead,
	isVcardHead,
	isVirtualDiskHead,
	isZipHead,
	SNIFFERS
} from "@/features/preview/lib/contentSniff.logic"
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

	// MicroDVD text or VobSub images: a subtitle until its head says it is an MPEG program stream, which nothing previews.
	it("reads a .sub's head before opening it as subtitles", () => {
		const sub = fileNamed("movie.sub", 3_000n)

		expect(needsContentSniff(sub, null)).toBe("vobsub")
		expect(previewType(sub, null)).toBe("subtitle")
		expect(needsContentSniff(sub, "notVobsub")).toBeNull()
		expect(previewType(sub, "notVobsub")).toBe("subtitle")
		expect(needsContentSniff(sub, "vobsub")).toBeNull()
		expect(previewType(sub, "vobsub")).toBe("other")
		// The other subtitle formats need no read.
		expect(needsContentSniff(fileNamed("movie.srt", 3_000n), null)).toBeNull()
		expect(previewType(fileNamed("movie.srt", 3_000n), null)).toBe("subtitle")
	})

	// A vCard or a genomics Variant Call Format file: contacts until its first line says otherwise, then plain text.
	it("reads a .vcf's head before opening it as contacts", () => {
		const vcf = fileNamed("people.vcf", 3_000n)

		expect(needsContentSniff(vcf, null)).toBe("vcard")
		expect(previewType(vcf, null)).toBe("contact")
		expect(previewType(vcf, "vcard")).toBe("contact")
		expect(previewType(vcf, "notVcard")).toBe("text")
		expect(needsContentSniff(vcf, "notVcard")).toBeNull()
		expect(needsContentSniff(fileNamed("people.vcard", 3_000n), null)).toBeNull()
		expect(previewType(fileNamed("people.vcard", 3_000n), null)).toBe("contact")
	})

	// A Keynote package or a key file: no kind until its head says it is a zip, which opens as an iWork document.
	it("reads a .key's head before it has a kind", () => {
		const deck = fileNamed("deck.key", 3n * MIB)

		expect(needsContentSniff(deck, null)).toBe("iworkPackage")
		expect(previewType(deck, null)).toBe("other")
		expect(needsContentSniff(deck, "iworkPackage")).toBeNull()
		expect(previewType(deck, "iworkPackage")).toBe("iwork")
		expect(needsContentSniff(deck, "notIworkPackage")).toBeNull()
		expect(previewType(deck, "notIworkPackage")).toBe("other")
		expect(canPreview(deck)).toBe(true)
		// Unread, it has no kind, so a key file may still be opened as text.
		expect(canOpenAsText(deck)).toBe(true)

		// A key file, once read, keeps that for the session: no Preview, no second read, Open as text still offered.
		const keyFile = fileNamed("license.key", 1_700n)

		recordContentVerdict(
			{ uuid: keyFile.data.uuid, name: "license.key", mime: "application/octet-stream", size: 1_700n },
			"notIworkPackage"
		)
		expect(needsContentSniff(keyFile)).toBeNull()
		expect(canPreview(keyFile)).toBe(false)
		expect(canOpenAsText(keyFile)).toBe(true)

		// A type that says text settles it with no read.
		const pem = fileNamed("server.key", 1_700n, "text/plain")

		expect(needsContentSniff(pem, null)).toBeNull()
		expect(previewType(pem, null)).toBe("text")

		// Pages and Numbers mean one thing.
		expect(needsContentSniff(fileNamed("report.pages", 3n * MIB), null)).toBeNull()
		expect(previewType(fileNamed("report.pages", 3n * MIB), null)).toBe("iwork")
		expect(previewType(fileNamed("budget.numbers", 3n * MIB), null)).toBe("iwork")
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

	// A deck is read in ranges on the drive and a public link, so a `.pot` opens there at any size.
	it("admits a template up to the larger of its meanings' caps", () => {
		for (const surface of ["drive", "link", "entry"] as const) {
			expect(sniffAdmits(fileNamed("graph.dot", PREVIEW_MAX_BYTES), deviceProfile(), surface)).toBe(true)
			expect(sniffAdmits(fileNamed("graph.dot", PREVIEW_MAX_BYTES + 1n), deviceProfile(), surface)).toBe(false)
			expect(sniffAdmits(fileNamed("deck.pot", PREVIEW_MAX_BYTES + 1n), deviceProfile(), surface)).toBe(surface !== "entry")
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

	// Text whatever the read finds, so large text above the cap; an archive's entry stays capped.
	it("admits a .vcf at any size on the drive and a link, and a .dot only within its caps", () => {
		for (const surface of ["drive", "link"] as const) {
			expect(sniffAdmits(fileNamed("calls.vcf", 4n * 1024n * MIB), deviceProfile(), surface)).toBe(true)
			expect(sniffAdmits(fileNamed("memo.dot", 4n * 1024n * MIB), deviceProfile(), surface)).toBe(false)
		}

		expect(sniffAdmits(fileNamed("calls.vcf", TEXT_MAX_BYTES + 1n), deviceProfile(), "entry")).toBe(false)
	})

	// The SDK lists the package at any size on the drive; a public link's or an archive's needs an archive reader.
	it("admits a .key on the drive only, at any size", () => {
		for (const size of [3n * MIB, 4n * 1024n * MIB]) {
			expect(sniffAdmits(fileNamed("deck.key", size), deviceProfile(), "drive")).toBe(true)
			expect(sniffAdmits(fileNamed("deck.key", size), deviceProfile(), "link")).toBe(false)
			expect(sniffAdmits(fileNamed("deck.key", size), deviceProfile(), "entry")).toBe(false)
		}

		expect(anonPreviewability(fileNamed("deck.key", 3n * MIB))).not.toBe("previewable")
		expect(anonPreviewability(fileNamed("report.pages", 3n * MIB))).not.toBe("previewable")
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

	it("probes a shared tracker extension's head, libopenmpt's 2 KiB, in front of its viewer from any origin", () => {
		const sniffer = SNIFFERS.trackerModule

		expect(sniffer.mode === "headProbe" && sniffer.headBytes).toBe(2048)
		expect(["file", "linkedFile", "entry", "bytes"].map(origin => gateRunsSniffer(sniffer, origin as "file"))).toEqual([
			true,
			true,
			true,
			true
		])
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

	it("finds a Keynote package by the zip's first local header, from its first 4 bytes", () => {
		const sniffer = SNIFFERS.iworkPackage
		const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])
		const pem = new TextEncoder().encode("-----BEGIN PRIVATE KEY-----")

		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(4)
		expect(isZipHead(zip)).toBe(true)
		expect(isZipHead(pem)).toBe(false)
		expect(isZipHead(zip.subarray(0, 3))).toBe(false)
		// An empty zip (end of central directory first) holds no preview either way.
		expect(isZipHead(Uint8Array.from([0x50, 0x4b, 0x05, 0x06]))).toBe(false)

		if (sniffer.mode === "head") {
			expect(sniffer.decide(zip, 6)).toBe("iworkPackage")
			expect(sniffer.decide(pem, pem.length)).toBe("notIworkPackage")
		}
	})

	it("finds a Wavefront model by a text head of up to 8 KiB, and a compiled object file by a binary one", () => {
		const sniffer = SNIFFERS.wavefront
		const model = new TextEncoder().encode("# Blender\nmtllib mesh.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n")
		// An ELF relocatable object.
		const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x3e, 0x00])

		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(8192)
		expect(["file", "linkedFile", "entry", "bytes"].every(origin => gateRunsSniffer(sniffer, origin as "file"))).toBe(true)

		if (sniffer.mode === "head") {
			expect(sniffer.decide(model, model.length)).toBe("wavefront")
			expect(sniffer.decide(elf, elf.length)).toBe("notWavefront")
		}
	})

	it("finds VobSub by the MPEG pack header, from its first 4 bytes", () => {
		const sniffer = SNIFFERS.vobsub
		const pack = Uint8Array.from([0x00, 0x00, 0x01, 0xba, 0x44])
		const microDvd = new TextEncoder().encode("{0}{25}Hello")

		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(4)
		expect(isMpegPackHead(pack)).toBe(true)
		expect(isMpegPackHead(microDvd)).toBe(false)
		expect(isMpegPackHead(pack.subarray(0, 3))).toBe(false)
		// A video elementary stream's sequence header is no pack.
		expect(isMpegPackHead(Uint8Array.from([0x00, 0x00, 0x01, 0xb3]))).toBe(false)

		if (sniffer.mode === "head") {
			expect(sniffer.decide(pack, 5)).toBe("vobsub")
			expect(sniffer.decide(microDvd, microDvd.length)).toBe("notVobsub")
		}
	})

	it("finds a vCard by its first line, in UTF-8 or UTF-16, after blank lines", () => {
		const sniffer = SNIFFERS.vcard
		const encode = (text: string) => new TextEncoder().encode(text)
		const utf16 = (text: string, littleEndian: boolean) => {
			const bytes = new Uint8Array(2 + text.length * 2)
			const view = new DataView(bytes.buffer)

			view.setUint16(0, 0xfeff, littleEndian)

			for (let index = 0; index < text.length; index++) view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian)

			return bytes
		}

		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(1024)
		expect(isVcardHead(encode("\ufeffBEGIN:VCARD\r\nVERSION:3.0"))).toBe(true)
		expect(isVcardHead(encode("\r\n\r\nbegin:vcard\n"))).toBe(true)
		expect(isVcardHead(utf16("BEGIN:VCARD\r\n", true))).toBe(true)
		expect(isVcardHead(utf16("BEGIN:VCARD\r\n", false))).toBe(true)
		expect(isVcardHead(encode("##fileformat=VCFv4.2\n"))).toBe(false)

		if (sniffer.mode === "head") {
			expect(sniffer.decide(encode("BEGIN:VCARD\n"), 12)).toBe("vcard")
			expect(sniffer.decide(encode("##fileformat=VCFv4.2\n"), 21)).toBe("notVcard")
		}
	})

	it("opens no iWork document inside an archive yet", () => {
		const DIRECT = { type: "direct", packedBytes: 10n } as const

		for (const path of ["deck.key", "report.pages"]) {
			expect(canOpenEntry(storeOf([{ path, access: DIRECT, size: Number(MIB) }]), 0), path).toBe(false)
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

// Many programs keep data in a `.db`; only the SQLite header makes one a database the viewer opens.
describe("the .db read", () => {
	it("reads a .db's head before choosing a viewer, from any origin, and opens it as a database only on the header", () => {
		const file = fileNamed("app.db", 3n * MIB)
		const sniffer = SNIFFERS.sqlite

		expect(needsContentSniff(file, null)).toBe("sqlite")
		expect(previewType(file, "sqlite")).toBe("sqlite")
		expect(previewType(file, "notSqlite")).toBe("other")
		expect(needsContentSniff(file, "sqlite")).toBeNull()
		expect(sniffer.mode === "head" && sniffer.headBytes).toBe(16)
		expect(["file", "linkedFile", "entry", "bytes"].map(origin => gateRunsSniffer(sniffer, origin as "file"))).toEqual([
			true,
			true,
			true,
			true
		])
		expect(sniffer.mode === "head" && sniffer.decide(new TextEncoder().encode("SQLite format 3\0"), 4096)).toBe("sqlite")
		expect(sniffer.mode === "head" && sniffer.decide(new TextEncoder().encode("PK\u0003\u0004 not a database"), 4096)).toBe("notSqlite")
	})

	it("opens a .db in an archive only within the whole-read cap", () => {
		expect(entryAwaitsSniff(storeOf([{ path: "app.db", access: { type: "direct", packedBytes: 10n }, size: 1024 }]), 0)).toBe(true)
		expect(canOpenEntry(storeOf([{ path: "app.db", access: { type: "direct", packedBytes: 10n }, size: 1024 }]), 0)).toBe(true)
		expect(canOpenEntry(storeOf([{ path: "app.db", access: { type: "direct", packedBytes: 10n }, size: 300 * 1024 * 1024 }]), 0)).toBe(
			false
		)
	})

	it("leaves a .db stored as text to its type", () => {
		expect(needsContentSniff(fileNamed("notes.db", 300n, "text/plain"), null)).toBeNull()
		expect(previewType(fileNamed("notes.db", 300n, "text/plain"), null)).toBe("text")
	})
})

// An Illustrator file opens in the PDF viewer only when its head holds a PDF; PostScript alone has no viewer.
describe("the .ai read", () => {
	it("reads an .ai's first kilobyte before choosing a viewer, from any origin", () => {
		const file = fileNamed("logo.ai", 3n * MIB)
		const sniffer = SNIFFERS.pdfCompatible

		expect(needsContentSniff(file, null)).toBe("pdfCompatible")
		expect(previewType(file, "pdfCompatible")).toBe("pdf")
		expect(previewType(file, "notPdfCompatible")).toBe("other")
		expect(needsContentSniff(file, "pdfCompatible")).toBeNull()
		expect(canPreview(file)).toBe(true)
		expect(["file", "linkedFile", "entry", "bytes"].map(origin => gateRunsSniffer(sniffer, origin as "file"))).toEqual([
			true,
			true,
			true,
			true
		])
	})

	it("finds a PDF header lying wholly in the first kilobyte, as pdf.js does, not past it", () => {
		const sniffer = SNIFFERS.pdfCompatible

		if (sniffer.mode !== "head") throw new Error("a head read")

		const at = (offset: number): Uint8Array => {
			const head = new Uint8Array(offset + 8).fill(0x20)

			head.set(new TextEncoder().encode("%PDF-1.6"), offset)

			// What the read gives: its head bytes at most.
			return head.subarray(0, sniffer.headBytes)
		}

		expect(sniffer.headBytes).toBe(1024)
		expect(sniffer.decide(at(0), 4096)).toBe("pdfCompatible")
		expect(sniffer.decide(at(1019), 4096)).toBe("pdfCompatible")
		expect(sniffer.decide(at(1020), 4096)).toBe("notPdfCompatible")
		expect(sniffer.decide(new TextEncoder().encode("%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator"), 4096)).toBe("notPdfCompatible")
	})
})
