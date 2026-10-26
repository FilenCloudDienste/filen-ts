import { readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { unzipSync } from "fflate"
import { CfbFile } from "../../../core/cfb/index"
import { bytesSource } from "../../../core/opc/index"

// The presentation corpus as the oracles see it: the frozen file list (corpus/manifest.json at the freeze, the
// denominator of every acceptance), which files LibreOffice cannot open and why, and an index of the slides that
// acceptances sample by feature (vertical text, the most animated slides, SmartArt with and without its cached
// drawing). Paths are relative to the corpus directory ("pptx/name.pptx").

export const PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
	"pptx",
	"pptm",
	"potx",
	"potm",
	"ppsx",
	"ppsm",
	"odp",
	"otp",
	"ppt",
	"pps",
	"pot"
])
const OOXML = new Set(["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"])
const ODF = new Set(["odp", "otp"])

// The open passwords of the corpus's encrypted presentations (their sources publish them with the fixtures).
export const CORPUS_PASSWORDS: Readonly<Record<string, string>> = {
	"tika__testPPT_protected_passtika.pptx": "tika",
	"tika__testPPT_protected_passtika.ppt": "tika",
	"poi__Password_Protected-hello.ppt": "hello",
	"poi__Password_Protected-56-hello.ppt": "hello",
	"poi__ppt_with_png_encrypted.ppt": "password"
}

export interface CorpusEntry {
	readonly path: string
	readonly sha256: string
	readonly size?: number
}

export function extensionOf(path: string): string {
	return extname(path).slice(1).toLowerCase()
}

export function isPresentation(path: string): boolean {
	return PRESENTATION_EXTENSIONS.has(extensionOf(path))
}

// A frozen list or a manifest: { files: [...] } or [...], each entry a path or { path, sha256 }.
export function readCorpusList(file: string): CorpusEntry[] {
	const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
	const list: unknown = Array.isArray(parsed) ? parsed : (parsed as { files?: unknown }).files

	if (!Array.isArray(list)) throw new Error(`${file}: neither a list nor { files: [...] }`)

	return list.map((item: unknown): CorpusEntry => {
		if (typeof item === "string") return { path: item, sha256: "" }

		const entry = item as { path?: unknown; sha256?: unknown; size?: unknown }

		if (typeof entry.path !== "string") throw new Error(`${file}: an entry without a path`)

		return {
			path: entry.path,
			sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
			...(typeof entry.size === "number" ? { size: entry.size } : {})
		}
	})
}

// MS-PPT §2.3.2: CurrentUserAtom.headerToken is 0xF3D1C4DF when the document is encrypted (0xE391C05F when not).
const ENCRYPTED_TOKEN = 0xf3d1c4df

// A .ppt/.pps/.pot that is encrypted (LibreOffice 7.5 opens none of these, decrypted or not: their oracle is
// msoffcrypto). Undefined when the file is not a compound file with a Current User stream.
export async function isEncryptedPpt(bytes: Uint8Array): Promise<boolean | undefined> {
	try {
		const cfb = await CfbFile.open(bytesSource(bytes))
		const entry = cfb.entry("Current User")

		if (entry === undefined || entry.size < 16) return undefined

		const user = await cfb.read(entry)

		return new DataView(user.buffer, user.byteOffset, user.byteLength).getUint32(12, true) === ENCRYPTED_TOKEN
	} catch {
		return undefined
	}
}

export interface SlideFeatures {
	// 1-based, in presentation order.
	readonly slide: number
	// Vertical text kinds used (a:bodyPr@vert / style:writing-mode).
	readonly vertical: readonly string[]
	// Time nodes (p:cTn) or ODF animation elements on the slide.
	readonly animationNodes: number
	// SmartArt diagrams: with their cached drawing (dsp:drawing) and without.
	readonly smartArt: { readonly cached: number; readonly uncached: number }
}

export interface DeckIndex {
	readonly path: string
	readonly sha256: string
	readonly format: string
	readonly slides: readonly SlideFeatures[]
	// Why the deck was not indexed (encrypted, unreadable).
	readonly skipped?: string
}

const decoder = new TextDecoder()

function text(files: Record<string, Uint8Array>, name: string): string {
	const bytes = files[name]

	return bytes === undefined ? "" : decoder.decode(bytes)
}

function relsOf(xml: string): Map<string, { target: string; type: string }> {
	const rels = new Map<string, { target: string; type: string }>()

	for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
		const tag = match[0]
		const id = /\bId="([^"]*)"/.exec(tag)?.[1]
		const target = /\bTarget="([^"]*)"/.exec(tag)?.[1]
		const type = /\bType="([^"]*)"/.exec(tag)?.[1]

		if (id !== undefined && target !== undefined && type !== undefined) rels.set(id, { target, type })
	}

	return rels
}

function resolvePart(base: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1)

	const parts = base.split("/").slice(0, -1)

	for (const segment of target.split("/")) {
		if (segment === "..") parts.pop()
		else if (segment !== "." && segment !== "") parts.push(segment)
	}

	return parts.join("/")
}

function relsPath(part: string): string {
	const slash = part.lastIndexOf("/")

	return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

const VERTICAL = /\bvert="(vert|vert270|eaVert|mongolianVert|wordArtVert|wordArtVertRtl)"/g

function ooxmlSlides(bytes: Uint8Array): SlideFeatures[] {
	const files = unzipSync(bytes, { filter: file => file.name.endsWith(".xml") || file.name.endsWith(".rels") })
	const presentation = Object.keys(files).find(name => /^ppt\/presentation\.xml$/i.test(name)) ?? "ppt/presentation.xml"
	const rels = relsOf(text(files, relsPath(presentation)))
	const order = [...text(files, presentation).matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)].map(match => match[1] ?? "")

	return order.flatMap((id, index): SlideFeatures[] => {
		const target = rels.get(id)?.target

		if (target === undefined) return []

		const part = resolvePart(presentation, target)
		const xml = text(files, part)
		const slideRels = [...relsOf(text(files, relsPath(part))).values()]
		const diagrams = [...xml.matchAll(/<dgm:relIds\b/g)].length
		const drawings = slideRels.filter(rel => rel.type.endsWith("/diagramDrawing")).length

		return [
			{
				slide: index + 1,
				vertical: [...new Set([...xml.matchAll(VERTICAL)].map(match => match[1] ?? ""))].sort(),
				animationNodes: [...xml.matchAll(/<p:cTn\b/g)].length,
				smartArt: { cached: Math.min(diagrams, drawings), uncached: Math.max(0, diagrams - drawings) }
			}
		]
	})
}

function odfSlides(bytes: Uint8Array): SlideFeatures[] {
	const files = unzipSync(bytes, { filter: file => file.name === "content.xml" || file.name === "styles.xml" })
	const content = text(files, "content.xml")
	// Styles whose properties set a vertical writing mode (each style element taken up to the next one).
	const verticalStyles = new Set(
		(content + text(files, "styles.xml"))
			.split(/<style:style\b/)
			.slice(1)
			.filter(style => /style:writing-mode="(?:tb-rl|tb-lr|tb)"/.test(style.slice(0, style.indexOf("</style:style>") >>> 0)))
			.map(style => /style:name="([^"]*)"/.exec(style)?.[1] ?? "")
	)
	const pages = content.split(/<draw:page(?=[\s>])/).slice(1)

	return pages.map((page, index) => {
		const used = [...page.matchAll(/(?:draw|presentation):(?:text-)?style-name="([^"]*)"/g)].map(match => match[1] ?? "")

		return {
			slide: index + 1,
			vertical: used.some(name => verticalStyles.has(name)) ? ["writing-mode"] : [],
			animationNodes: [...page.matchAll(/<anim:(?:par|seq|animate\w*|set|transitionFilter|audio|command|iterate)\b/g)].length,
			smartArt: { cached: 0, uncached: 0 }
		}
	})
}

// The features of each slide of a corpus deck (the encrypted and the binary ones are listed, not indexed).
export async function indexDeck(corpusDir: string, entry: CorpusEntry): Promise<DeckIndex> {
	const format = extensionOf(entry.path)
	const base = { path: entry.path, sha256: entry.sha256, format }
	const bytes = new Uint8Array(readFileSync(join(corpusDir, entry.path)))

	try {
		if (OOXML.has(format)) {
			if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ...base, slides: [], skipped: "encrypted package" }

			return { ...base, slides: ooxmlSlides(bytes) }
		}

		if (ODF.has(format)) return { ...base, slides: odfSlides(bytes) }

		return {
			...base,
			slides: [],
			skipped: (await isEncryptedPpt(bytes)) === true ? "encrypted ppt" : "binary (indexed from LibreOffice's JSON)"
		}
	} catch (error) {
		return { ...base, slides: [], skipped: `unreadable: ${error instanceof Error ? error.message : String(error)}` }
	}
}

export interface SlideRef {
	readonly path: string
	readonly sha256: string
	readonly slide: number
}

function slidesOf(index: readonly DeckIndex[], formats: ReadonlySet<string>): (SlideRef & { readonly features: SlideFeatures })[] {
	return index
		.filter(deck => formats.has(deck.format))
		.flatMap(deck => deck.slides.map(features => ({ path: deck.path, sha256: deck.sha256, slide: features.slide, features })))
}

// Every `step`-th OOXML slide in corpus order (paths sorted): a fixed sample.
export function ooxmlSample(index: readonly DeckIndex[], step = 6): SlideRef[] {
	return slidesOf(index, OOXML)
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.slide - b.slide))
		.filter((_, k) => k % step === 0)
		.map(({ path, sha256, slide }) => ({ path, sha256, slide }))
}

// The `count` slides with the most time nodes, most first (ties by path and slide).
export function mostAnimated(index: readonly DeckIndex[], count = 20): (SlideRef & { readonly nodes: number })[] {
	return slidesOf(index, new Set([...OOXML, ...ODF]))
		.filter(ref => ref.features.animationNodes > 0)
		.sort(
			(a, b) =>
				b.features.animationNodes - a.features.animationNodes || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.slide - b.slide)
		)
		.slice(0, count)
		.map(({ path, sha256, slide, features }) => ({ path, sha256, slide, nodes: features.animationNodes }))
}

export function verticalTextSlides(index: readonly DeckIndex[]): (SlideRef & { readonly kinds: readonly string[] })[] {
	return slidesOf(index, new Set([...OOXML, ...ODF]))
		.filter(ref => ref.features.vertical.length > 0)
		.map(({ path, sha256, slide, features }) => ({ path, sha256, slide, kinds: features.vertical }))
}

export function smartArtSlides(index: readonly DeckIndex[]): (SlideRef & { readonly cached: number; readonly uncached: number })[] {
	return slidesOf(index, OOXML)
		.filter(ref => ref.features.smartArt.cached + ref.features.smartArt.uncached > 0)
		.map(({ path, sha256, slide, features }) => ({ path, sha256, slide, ...features.smartArt }))
}
