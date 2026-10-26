import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { zlibSync } from "fflate"
import { crc32, writeZip, type ByteChunks, type ByteSink, type WriteZipReport, type ZipPlanItem } from "../../../core/opc/index"

// Large presentations for the streaming, memory and save budgets, generated at test time into a temporary directory
// (never committed): deterministic bytes from a seeded generator, written through the package's own zip writer one
// entry at a time, so making a 2 GB deck holds one chunk of it. Decks:
// - "streaming": over 50 MB, pictures stored and deflated, a stored MP4 and a deflated one;
// - "video200": a 200 MB MP4 deflated in the package, not fast-start (its moov box after the media data);
// - "memory2g": 2 GB of stored MP4 media.
// The pictures are valid PNGs; the MP4s are structurally valid ISO BMFF (ftyp, mdat, moov with one track and its
// chunk offset) whose samples are not decodable video.

export type BigDeckKind = "streaming" | "video200" | "memory2g"

export interface BigMedia {
	readonly kind: "png" | "mp4"
	readonly bytes: number
	// Deflated in the package (else stored).
	readonly deflate: boolean
	// mp4: the moov box first (fast start) or after mdat.
	readonly faststart?: boolean
}

export interface BigDeckSpec {
	// One slide per medium, then `extraSlides` slides of text.
	readonly media: readonly BigMedia[]
	readonly extraSlides: number
	readonly seed: number
}

const MB = 1024 * 1024

function media(count: number, item: BigMedia): BigMedia[] {
	return Array.from({ length: count }, () => item)
}

export const BIG_DECKS: Readonly<Record<BigDeckKind, BigDeckSpec>> = {
	streaming: {
		media: [
			...media(16, { kind: "png", bytes: 2 * MB, deflate: false }),
			...media(8, { kind: "png", bytes: 2 * MB, deflate: true }),
			{ kind: "mp4", bytes: 8 * MB, deflate: false, faststart: true },
			{ kind: "mp4", bytes: 4 * MB, deflate: true, faststart: false }
		],
		extraSlides: 20,
		seed: 1
	},
	video200: { media: [{ kind: "mp4", bytes: 200 * MB, deflate: true, faststart: false }], extraSlides: 2, seed: 2 },
	memory2g: { media: media(8, { kind: "mp4", bytes: 256 * MB - 4096, deflate: false, faststart: true }), extraSlides: 2, seed: 3 }
}

// Bumped whenever the bytes a spec makes change, so a deck left in the temporary directory is made again.
const GENERATOR_VERSION = 1
const CHUNK = 4 * MB

// xorshift32: the same bytes for the same seed on every machine.
function filler(seed: number): (out: Uint8Array) => void {
	let state = (seed * 0x9e3779b9) >>> 0 || 1

	return out => {
		const words = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >>> 2)

		for (let k = 0; k < words.length; k++) {
			state ^= state << 13
			state ^= state >>> 17
			state ^= state << 5
			words[k] = state >>> 0
		}

		for (let k = words.length * 4; k < out.length; k++) out[k] = k & 0xff
	}
}

function u32(value: number): Uint8Array {
	return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

function ascii(text: string): Uint8Array {
	return Uint8Array.from(text, c => c.charCodeAt(0))
}

function box(type: string, ...content: Uint8Array[]): Uint8Array {
	const body = concat(content)

	return concat([u32(8 + body.length), ascii(type), body])
}

function fullBox(type: string, version: number, flags: number, ...content: Uint8Array[]): Uint8Array {
	return box(type, u32(((version & 0xff) << 24) | (flags & 0xffffff)), ...content)
}

const IDENTITY = concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)])

// ISO/IEC 14496-12 moov for one video track whose single sample is the whole of mdat's payload at `offset`.
function moov(offset: number, size: number): Uint8Array {
	const duration = 10_000

	return box(
		"moov",
		fullBox(
			"mvhd",
			0,
			0,
			u32(0),
			u32(0),
			u32(1000),
			u32(duration),
			u32(0x10000),
			Uint8Array.of(1, 0, 0, 0),
			new Uint8Array(8),
			IDENTITY,
			new Uint8Array(24),
			u32(2)
		),
		box(
			"trak",
			fullBox(
				"tkhd",
				0,
				3,
				u32(0),
				u32(0),
				u32(1),
				u32(0),
				u32(duration),
				new Uint8Array(8),
				new Uint8Array(4),
				new Uint8Array(4),
				IDENTITY,
				u32(1280 << 16),
				u32(720 << 16)
			),
			box(
				"mdia",
				fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1000), u32(duration), Uint8Array.of(0x55, 0xc4, 0, 0)),
				fullBox("hdlr", 0, 0, u32(0), ascii("vide"), new Uint8Array(12), ascii("Video\0")),
				box(
					"minf",
					fullBox("vmhd", 0, 1, new Uint8Array(8)),
					box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
					box(
						"stbl",
						fullBox("stsd", 0, 0, u32(0)),
						fullBox("stts", 0, 0, u32(1), u32(1), u32(duration)),
						fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
						fullBox("stsz", 0, 0, u32(size), u32(1)),
						fullBox("stco", 0, 0, u32(1), u32(offset))
					)
				)
			)
		)
	)
}

// Media data that deflates to about half: per 4 KiB, 2 KiB of noise and 2 KiB repeating the block before.
function mediaPayload(out: Uint8Array, fill: (out: Uint8Array) => void, compressible: boolean): void {
	fill(out)

	if (!compressible) return

	for (let at = 4096; at + 4096 <= out.length; at += 4096) out.copyWithin(at + 2048, at - 2048, at)
}

// An MP4 of exactly `bytes`, in chunks of CHUNK (made again on every pass: nothing is held).
export function mp4Chunks(bytes: number, seed: number, faststart: boolean, compressible: boolean): ByteChunks {
	const ftyp = box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso2mp41"))
	const moovSize = moov(0, 0).length
	const payload = bytes - ftyp.length - 8 - moovSize

	if (payload <= 0) throw new Error(`An MP4 of ${String(bytes)} bytes is too small`)

	const mdatStart = faststart ? ftyp.length + moovSize : ftyp.length
	const head = concat([ftyp, ...(faststart ? [moov(mdatStart + 8, payload)] : []), u32(8 + payload), ascii("mdat")])
	const tail = faststart ? new Uint8Array(0) : moov(mdatStart + 8, payload)

	return {
		length: bytes,
		async *chunks(): AsyncIterable<Uint8Array> {
			const fill = filler(seed)

			yield head

			for (let at = 0; at < payload; at += CHUNK) {
				const chunk = new Uint8Array(Math.min(CHUNK, payload - at))

				mediaPayload(chunk, fill, compressible)
				yield chunk
			}

			if (tail.length > 0) yield tail
		}
	}
}

// A PNG (RGB, 8-bit) of about `bytes`: noise rows in stored deflate blocks, so its size is what it holds.
export function pngBytes(bytes: number, seed: number): Uint8Array {
	const width = 1024
	const height = Math.max(1, Math.round(bytes / (width * 3 + 1)))
	const raw = new Uint8Array((width * 3 + 1) * height)

	filler(seed)(raw)

	for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0

	const header = concat([u32(width), u32(height), Uint8Array.of(8, 2, 0, 0, 0)])
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const typed = concat([ascii(type), data])

		return concat([u32(data.length), typed, u32(crc32(typed) >>> 0)])
	}

	return concat([
		Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		chunk("IHDR", header),
		chunk("IDAT", zlibSync(raw, { level: 0 })),
		chunk("IEND", new Uint8Array(0))
	])
}

const P = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const EMU_W = 12_192_000
const EMU_H = 6_858_000

function rels(items: readonly (readonly [string, string, string])[]): string {
	return `${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
		.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
		.join("")}</Relationships>`
}

const THEME = `${DECL}<a:theme xmlns:a="${A}" name="Generated"><a:themeElements><a:clrScheme name="Generated"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="DC2626"/></a:accent2><a:accent3><a:srgbClr val="16A34A"/></a:accent3><a:accent4><a:srgbClr val="CA8A04"/></a:accent4><a:accent5><a:srgbClr val="9333EA"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="1D4ED8"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="Generated"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Generated"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

const SP_TREE_HEAD = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'

function title(id: number, text: string): string {
	return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="Title ${String(id)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

const MASTER = `${DECL}<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${SP_TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-GB"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`

const LAYOUT = `${DECL}<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="titleOnly" preserve="1"><p:cSld name="Title Only"><p:spTree>${SP_TREE_HEAD}${title(2, "")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`

function slideXml(index: number, picture: { readonly rel: string; readonly video?: string; readonly media?: string } | undefined): string {
	const pic =
		picture === undefined
			? ""
			: `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Media ${String(index)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${
					picture.video === undefined
						? ""
						: `<a:videoFile r:link="${picture.video}"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${picture.media ?? picture.video}"/></p:ext></p:extLst>`
				}</p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="${picture.rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="1524000" y="1828800"/><a:ext cx="9144000" cy="4572000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

	return `${DECL}<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${SP_TREE_HEAD}${title(2, `Slide ${String(index)}`)}${pic}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

const encoder = new TextEncoder()

function xml(name: string, text: string): ZipPlanItem {
	return { kind: "data", name, bytes: encoder.encode(text), compress: true }
}

// The package's entries in order, each made when the writer asks for it.
async function* entries(spec: BigDeckSpec): AsyncIterable<ZipPlanItem> {
	const slides = spec.media.length + spec.extraSlides
	const slideIds = Array.from({ length: slides }, (_, k) => k + 1)
	const poster = pngBytes(64 * 1024, spec.seed * 7919)
	const hasVideo = spec.media.some(item => item.kind === "mp4")

	yield xml(
		"[Content_Types].xml",
		`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="mp4" ContentType="video/mp4"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideIds
			.map(
				n =>
					`<Override PartName="/ppt/slides/slide${String(n)}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
			)
			.join("")}</Types>`
	)
	yield xml("_rels/.rels", rels([["rId1", `${REL}/officeDocument`, "ppt/presentation.xml"]]))
	yield xml(
		"ppt/presentation.xml",
		`${DECL}<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds
			.map(n => `<p:sldId id="${String(255 + n)}" r:id="rId${String(n + 2)}"/>`)
			.join(
				""
			)}</p:sldIdLst><p:sldSz cx="${String(EMU_W)}" cy="${String(EMU_H)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
	)
	yield xml(
		"ppt/_rels/presentation.xml.rels",
		rels([
			["rId1", `${REL}/slideMaster`, "slideMasters/slideMaster1.xml"],
			["rId2", `${REL}/theme`, "theme/theme1.xml"],
			...slideIds.map(n => [`rId${String(n + 2)}`, `${REL}/slide`, `slides/slide${String(n)}.xml`] as const)
		])
	)
	yield xml("ppt/theme/theme1.xml", THEME)
	yield xml("ppt/slideMasters/slideMaster1.xml", MASTER)
	yield xml(
		"ppt/slideMasters/_rels/slideMaster1.xml.rels",
		rels([
			["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"],
			["rId2", `${REL}/theme`, "../theme/theme1.xml"]
		])
	)
	yield xml("ppt/slideLayouts/slideLayout1.xml", LAYOUT)
	yield xml("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", `${REL}/slideMaster`, "../slideMasters/slideMaster1.xml"]]))

	for (const n of slideIds) {
		const item = spec.media[n - 1]
		const layout = ["rId1", `${REL}/slideLayout`, "../slideLayouts/slideLayout1.xml"] as const

		if (item === undefined) {
			yield xml(`ppt/slides/slide${String(n)}.xml`, slideXml(n, undefined))
			yield xml(`ppt/slides/_rels/slide${String(n)}.xml.rels`, rels([layout]))
		} else if (item.kind === "png") {
			yield xml(`ppt/slides/slide${String(n)}.xml`, slideXml(n, { rel: "rId2" }))
			yield xml(
				`ppt/slides/_rels/slide${String(n)}.xml.rels`,
				rels([layout, ["rId2", `${REL}/image`, `../media/image${String(n)}.png`]])
			)
		} else {
			yield xml(`ppt/slides/slide${String(n)}.xml`, slideXml(n, { rel: "rId2", video: "rId3", media: "rId4" }))
			yield xml(
				`ppt/slides/_rels/slide${String(n)}.xml.rels`,
				rels([
					layout,
					["rId2", `${REL}/image`, "../media/poster.png"],
					["rId3", `${REL}/video`, `../media/media${String(n)}.mp4`],
					["rId4", "http://schemas.microsoft.com/office/2007/relationships/media", `../media/media${String(n)}.mp4`]
				])
			)
		}
	}

	if (hasVideo) yield { kind: "data", name: "ppt/media/poster.png", bytes: poster, compress: false }

	for (const [k, item] of spec.media.entries()) {
		const n = k + 1
		const seed = spec.seed * 1000 + n

		yield item.kind === "png"
			? { kind: "data", name: `ppt/media/image${String(n)}.png`, bytes: pngBytes(item.bytes, seed), compress: item.deflate }
			: {
					kind: "data",
					name: `ppt/media/media${String(n)}.mp4`,
					bytes: mp4Chunks(item.bytes, seed, item.faststart ?? false, item.deflate),
					compress: item.deflate
				}
	}
}

// Writes the deck to `sink` (deflate level 1 for media: what a writer in a hurry does, and fast to make).
export function writeBigDeck(spec: BigDeckSpec, sink: ByteSink): Promise<WriteZipReport> {
	return writeZip({ items: entries(spec) }, null, sink, { level: 1 })
}

function fileSink(handle: Awaited<ReturnType<typeof open>>): ByteSink {
	return {
		async write(chunk: Uint8Array): Promise<void> {
			await handle.write(chunk)
		},
		close: () => handle.close()
	}
}

// The deck's path in the temporary directory, made once (first use) and reused while the generator is unchanged.
export async function bigDeck(kind: BigDeckKind, dir = join(tmpdir(), "filen-office-big-decks")): Promise<string> {
	const path = join(dir, `${kind}-v${String(GENERATOR_VERSION)}.pptx`)

	if (existsSync(path)) return path

	mkdirSync(dir, { recursive: true })

	const partial = `${path}.${String(process.pid)}.partial`
	const handle = await open(partial, "w")

	try {
		await writeBigDeck(BIG_DECKS[kind], fileSink(handle))
	} catch (error) {
		await handle.close().catch(() => undefined)
		rmSync(partial, { force: true })

		throw error
	}

	renameSync(partial, path)

	return path
}
