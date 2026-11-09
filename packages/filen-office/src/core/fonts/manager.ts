import { bundledFace } from "./bundled"
import { FontError } from "./errors"
import type { FontAssets, FontFaceDescriptor, FontHost } from "./host"
import type { VerticalMetrics } from "./metrics"
import { readSfnt } from "./sfnt"
import type { FontSlot } from "./slots"
import { NO_HINTS, SUBSTITUTIONS, fallbackFor, type BundledFamily, type FontHints, type GenericFamily } from "./substitutes"
import { CLONE_METRICS, LINE_METRICS } from "./tables.generated"

// Resolves the fonts a document names to faces the platform can draw, and loads those faces under internal
// alias names, so no document can restyle or shadow the app's own fonts. Order per family: a font embedded
// in the document; a bundled substitute (an installed copy of the original first, for the few originals
// without a free width-compatible substitute); the font table's alternative names; an installed font of
// that name; a bundled family chosen from the font table's hints; the platform's generic family.
//
// prepare() loads everything a set of requests needs, embedded faces included; resolve() is synchronous
// and allocation-free once a request has been seen, so layout can call it per run.

export interface FontLimits {
	readonly maxEmbeddedFaceBytes: number
	readonly maxEmbeddedBytes: number
	// Families probed for an installed copy. Each probe is a platform font lookup.
	readonly maxLocalProbes: number
}

export const DEFAULT_FONT_LIMITS: FontLimits = {
	maxEmbeddedFaceBytes: 32 * 1024 * 1024,
	maxEmbeddedBytes: 96 * 1024 * 1024,
	maxLocalProbes: 32
}

// A font as a document's font table declares it.
export interface FontDeclaration {
	readonly name: string
	readonly altNames: readonly string[]
	readonly hints: FontHints
}

export interface FontRequest {
	readonly family: string
	readonly bold: boolean
	readonly italic: boolean
	readonly slot: FontSlot
}

export type FontSource = "embedded" | "local" | "bundled" | "generic"

// Where `metrics` come from: "font" the drawn face itself, "original" published metrics of the requested
// font, "substitute" what the substitute draws with (the requested font's are unknown), "runtime" none:
// measure the face.
export type MetricsBasis = "font" | "original" | "substitute" | "runtime"

export interface ResolvedFont {
	// Stable per manager for equal results; a cache key for measurements.
	readonly id: number
	// Internal alias to draw with, or null when only the generic family applies.
	readonly family: string | null
	readonly generic: GenericFamily
	readonly weight: number
	readonly italic: boolean
	// Font-size factor for substitutes drawn at a corrected size.
	readonly scale: number
	// Horizontal-only factor for a condensed original drawn in a normal-width substitute.
	readonly widthScale: number
	readonly metrics: VerticalMetrics | null
	readonly metricsBasis: MetricsBasis
	readonly source: FontSource
}

// What a realm must register to draw what this manager resolved: the main thread replays the worker's
// registrations so display lists can name the same aliases.
export type FaceRegistration = FontFaceDescriptor &
	(
		| { readonly source: "asset"; readonly file: string }
		| { readonly source: "local"; readonly name: string }
		| { readonly source: "embedded"; readonly declaredFamily: string }
	)

// Reads an embedded face's font data, at most `maxBytes` of it (larger fonts must be refused unread).
export type EmbeddedFontReader = (maxBytes: number) => Promise<Uint8Array>

// Where a PDF export gets the face a request draws with: a bundled family's face, or the document's embedded
// face (with its OS/2 fsType, and the bundled family to use when that forbids embedding). Installed and generic
// fonts are never embedded; the bundled family that stands in for them is.
export type PdfFaceSource =
	| { readonly kind: "bundled"; readonly family: BundledFamily; readonly weight: number; readonly italic: boolean }
	| {
			readonly kind: "embedded"
			// Stable per face, for caching.
			readonly key: string
			readonly read: EmbeddedFontReader
			readonly fsType: number
			readonly weight: number
			readonly italic: boolean
			readonly substitute: BundledFamily
	  }

export interface EmbeddedFontFailure {
	readonly family: string
	readonly bold: boolean
	readonly italic: boolean
	readonly reason: string
}

const MAX_FONT_PX = 16384

// CSS `font` shorthand for canvas measurement and DOM style. Aliases are quoted; generic names never are.
// Sizes outside what CSS can express (NaN, infinite, negative, huge) are clamped.
export function cssFont(font: ResolvedFont, sizePx: number): string {
	const px = sizePx * font.scale
	const size = Number.isFinite(px) && px > 0 ? Math.round(Math.min(px, MAX_FONT_PX) * 1000) / 1000 : 0
	const family = font.family === null ? font.generic : `"${font.family}", ${font.generic}`

	return `${font.italic ? "italic " : ""}${font.weight} ${size}px ${family}`
}

// The resolved face's horizontal-only factor, 1 when absent or invalid. Text tables fold it into scaleX and
// divide letter spacing by it, so a condensed original's substitute narrows the glyphs and not the spacing.
export function glyphWidthScale(font: ResolvedFont): number {
	return font.widthScale > 0 && Number.isFinite(font.widthScale) ? font.widthScale : 1
}

interface EmbeddedFace {
	readonly weight: number
	readonly italic: boolean
	readonly metrics: VerticalMetrics
	// OS/2 fsType: restricted fonts may be drawn but never embedded again.
	readonly fsType: number
	// The font data the platform holds, for the realms that draw the same face (counted in the embedded budget).
	readonly data: Uint8Array
}

interface EmbeddedSource {
	readonly key: number
	readonly read: EmbeddedFontReader
	state: "pending" | "loaded" | "failed"
	load: Promise<void> | null
	error: unknown
}

interface EmbeddedFamily {
	readonly alias: string
	readonly name: string
	// Declared faces by style key; the first declaration of a style wins.
	readonly sources: Map<number, EmbeddedSource>
	// Loaded faces only: what CSS can match against.
	readonly faces: EmbeddedFace[]
}

interface LocalFamily {
	readonly alias: string
	readonly name: string
	// Faces found installed, by style key.
	readonly styles: Set<number>
}

const MAX_LOCAL_NAME = 64

// Aliases carry a per-manager namespace: two documents open in one realm must not share or remove each
// other's faces, and registrations replayed in another realm (worker to main thread, or several workers
// feeding one page) must not meet another manager's aliases there. A random namespace keeps them apart
// across realms; the counter guarantees it within one.
let managerCount = 0
const NAMESPACE = /^[A-Za-z0-9_-]{1,32}$/

function randomNamespace(): string {
	const bytes = new Uint8Array(6)
	const crypto: unknown = Reflect.get(globalThis, "crypto")

	// Hermes has no Web Crypto without a polyfill; the namespace only has to be unlikely to repeat.
	if (typeof crypto === "object" && crypto !== null && "getRandomValues" in crypto && typeof crypto.getRandomValues === "function") {
		crypto.getRandomValues(bytes)
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
	}

	let hex = ""

	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")

	return `fo${hex}${(++managerCount).toString(36)}`
}

function printable(name: string): boolean {
	for (let i = 0; i < name.length; i++) {
		const code = name.charCodeAt(i)

		if (code < 0x20 || code === 0x7f) return false
	}

	return name.length > 0
}

// Bit 1 bold, bit 0 italic.
function styleKey(bold: boolean, italic: boolean): number {
	return (bold ? 2 : 0) | (italic ? 1 : 0)
}

function localName(name: string, key: number): string {
	switch (key) {
		case 1:
			return `${name} Italic`
		case 2:
			return `${name} Bold`
		case 3:
			return `${name} Bold Italic`
		default:
			return name
	}
}

function slotIndex(slot: FontSlot): number {
	switch (slot) {
		case "ascii":
			return 0
		case "hAnsi":
			return 1
		case "eastAsia":
			return 2
		default:
			return 3
	}
}

function requestIndex(request: FontRequest): number {
	return (request.bold ? 8 : 0) | (request.italic ? 4 : 0) | slotIndex(request.slot)
}

function isLatin(slot: FontSlot): boolean {
	return slot === "ascii" || slot === "hAnsi"
}

const BUNDLED_FAMILIES: readonly BundledFamily[] = ["carlito", "caladea", "arimo", "tinos", "cousine", "gelasio", "selawik"]

function genericFamily(generic: GenericFamily): BundledFamily {
	return generic === "serif" ? "tinos" : generic === "monospace" ? "cousine" : "arimo"
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export class FontManager {
	private readonly host: FontHost
	private readonly assets: FontAssets
	private readonly limits: FontLimits
	private readonly prefix: string

	private readonly declarations = new Map<string, FontDeclaration>()
	private readonly embedded = new Map<string, EmbeddedFamily>()
	private embeddedBytes = 0
	// Embedded faces load one at a time: each read gets the exact budget left, and at most one font's bytes
	// are in flight however many prepare() calls run.
	private embeddedQueue: Promise<void> = Promise.resolve()
	private readonly failed: EmbeddedFontFailure[] = []

	// Lower-cased family -> installed copy, or null when probed and absent.
	private readonly local = new Map<string, LocalFamily | null>()
	private readonly localProbes = new Map<string, Promise<void>>()
	private readonly localStyleProbes = new Map<string, Promise<boolean>>()
	private localCount = 0

	// Asset file -> load result.
	private readonly assetLoads = new Map<string, Promise<boolean>>()
	private readonly loadedAssets = new Set<string>()

	private readonly registered: FaceRegistration[] = []
	// Family as requested -> results by requestIndex().
	private readonly resolved = new Map<string, (ResolvedFont | undefined)[]>()
	private readonly interned = new Map<string, ResolvedFont>()
	private disposed = false

	// `namespace` prefixes every alias (letters, digits, "-", "_"); a random one is used when omitted.
	constructor(host: FontHost, assets: FontAssets, limits: FontLimits = DEFAULT_FONT_LIMITS, namespace?: string) {
		if (namespace !== undefined && !NAMESPACE.test(namespace)) throw new Error("A font namespace is 1-32 letters, digits, - or _")

		this.host = host
		this.assets = assets
		this.limits = limits
		this.prefix = namespace ?? randomNamespace()
	}

	// The document's font table: hints and alternative names for families without a substitute. An
	// alternative name finds its declaration too.
	declare(declarations: Iterable<FontDeclaration>): void {
		this.assertLive()

		for (const declaration of declarations) {
			const key = declaration.name.toLowerCase()

			this.declarations.set(key, declaration)

			for (const alt of declaration.altNames) {
				const altKey = alt.toLowerCase()

				if (!this.declarations.has(altKey)) this.declarations.set(altKey, declaration)
			}
		}

		this.resolved.clear()
	}

	// Declares a face the document embeds for `family`, in the style the document declares it for. It is
	// read only when prepare() meets text that needs it. A second face for the same style is ignored.
	embed(family: string, bold: boolean, italic: boolean, read: EmbeddedFontReader): void {
		this.assertLive()
		this.declareEmbedded(family, bold, italic, read)
	}

	// Registers embedded font data (raw sfnt, already de-obfuscated) now. Throws a FontError for data that is
	// no usable font or exceeds the limits; resolves false when the platform rejects it or the style was
	// already embedded.
	async addEmbedded(family: string, data: Uint8Array, bold: boolean, italic: boolean): Promise<boolean> {
		this.assertLive()

		const source = this.declareEmbedded(family, bold, italic, () => Promise.resolve(data))

		if (source === null) return false

		await this.loadSource(this.embedded.get(family.toLowerCase()), source)

		if (source.state === "failed" && source.error instanceof FontError) throw source.error

		return source.state === "loaded"
	}

	// Embedded faces that could not be used, with why.
	failures(): readonly EmbeddedFontFailure[] {
		return this.failed
	}

	// Loads what the requests need: embedded faces, installed-font probes and bundled faces.
	async prepare(requests: Iterable<FontRequest>): Promise<void> {
		this.assertLive()

		const tasks: Promise<unknown>[] = []
		const seen = new Set<string>()

		for (const request of requests) {
			const requestKey = `${request.family.toLowerCase()}\u0000${requestIndex(request)}`

			if (seen.has(requestKey)) continue

			seen.add(requestKey)
			tasks.push(this.prepareOne(request))
		}

		await Promise.all(tasks)
		this.resolved.clear()
	}

	resolve(request: FontRequest): ResolvedFont {
		this.assertLive()

		let byStyle = this.resolved.get(request.family)

		if (byStyle === undefined) {
			byStyle = []
			this.resolved.set(request.family, byStyle)
		}

		const index = requestIndex(request)
		let font = byStyle[index]

		if (font === undefined) {
			font = this.compute(request)
			byStyle[index] = font
		}

		return font
	}

	registrations(): readonly FaceRegistration[] {
		return this.registered
	}

	// The face a PDF embeds for `request` (see PdfFaceSource); the request must have been prepared.
	pdfFace(request: FontRequest): PdfFaceSource {
		const font = this.resolve(request)
		const substitution = this.candidates(request.family)
			.map(name => SUBSTITUTIONS.get(name.toLowerCase()))
			.find(known => known !== undefined)
		const weight = font.weight
		const substitute: BundledFamily =
			substitution?.family ?? fallbackFor(request.family, this.hints(request.family), true).family ?? genericFamily(font.generic)

		if (font.source === "embedded") {
			for (const entry of this.embedded.values()) {
				if (entry.alias !== font.family) continue

				const face =
					entry.faces.find(f => f.weight === weight && f.italic === font.italic) ??
					entry.faces.find(f => f.italic === font.italic) ??
					entry.faces.find(f => f.weight === weight) ??
					entry.faces[0]

				if (face === undefined) break

				const key = styleKey(face.weight >= 700, face.italic)
				const source = entry.sources.get(key)

				if (source === undefined) break

				return {
					kind: "embedded",
					key: `${entry.alias}:${key}`,
					read: source.read,
					fsType: face.fsType,
					weight: face.weight,
					italic: face.italic,
					substitute
				}
			}
		}

		if (font.source === "bundled" && font.family !== null && font.family.startsWith(`${this.prefix}-`)) {
			const alias = font.family.slice(this.prefix.length + 1)
			const family = BUNDLED_FAMILIES.find(known => known === alias)

			if (family !== undefined) return { kind: "bundled", family, weight, italic: font.italic }
		}

		// An installed font (or a generic one) stands in for the request on screen: the PDF embeds the bundled
		// family the request's own hints pick, never one guessed from the installed font's name alone.
		return { kind: "bundled", family: substitute, weight, italic: font.italic }
	}

	// The font data of an embedded face this manager registered (the bytes the platform loaded), for another realm to
	// register the same face; undefined for any other registration.
	embeddedData(registration: FaceRegistration): Uint8Array | undefined {
		if (registration.source !== "embedded") return undefined

		const entry = this.embedded.get(registration.declaredFamily.toLowerCase())
		const weight = typeof registration.weight === "number" ? registration.weight : registration.weight[0]

		return entry?.alias === registration.family
			? entry.faces.find(face => face.weight === weight && face.italic === registration.italic)?.data
			: undefined
	}

	// Whether an embedded font may be embedded again on save (OS/2 fsType: not restricted-license).
	reembeddable(family: string): boolean {
		const entry = this.embedded.get(family.toLowerCase())

		return entry !== undefined && entry.faces.length > 0 && entry.faces.every(face => (face.fsType & 0x0002) === 0)
	}

	// Unregisters this manager's faces. The manager cannot be used afterwards.
	dispose(): void {
		if (this.disposed) return

		this.disposed = true

		for (const alias of new Set(this.registered.map(registration => registration.family))) this.host.remove(alias)

		this.registered.length = 0
		this.declarations.clear()
		this.embedded.clear()
		this.local.clear()
		this.loadedAssets.clear()
		this.resolved.clear()
		this.interned.clear()
	}

	private assertLive(): void {
		if (this.disposed) throw new Error("The font manager is disposed")
	}

	// Whether a face the host added is still wanted; one that finished loading after dispose() is removed.
	private settled(alias: string, added: boolean): boolean {
		if (added && this.disposed) this.host.remove(alias)

		return added && !this.disposed
	}

	private declareEmbedded(family: string, bold: boolean, italic: boolean, read: EmbeddedFontReader): EmbeddedSource | null {
		const lower = family.toLowerCase()
		let entry = this.embedded.get(lower)

		if (entry === undefined) {
			entry = { alias: `${this.prefix}-e${this.embedded.size + 1}`, name: family, sources: new Map(), faces: [] }
			this.embedded.set(lower, entry)
		}

		const key = styleKey(bold, italic)

		if (entry.sources.has(key)) {
			this.failed.push({ family, bold, italic, reason: "the style is embedded twice; the first is used" })

			return null
		}

		const source: EmbeddedSource = { key, read, state: "pending", load: null, error: undefined }

		entry.sources.set(key, source)

		return source
	}

	// Loads the face CSS would draw `key` with (the style itself, else the closest declared one), falling
	// back through the others while loads fail. True when the family has a usable face.
	private async loadEmbedded(entry: EmbeddedFamily, key: number): Promise<boolean> {
		const order = [key, key ^ 2, key ^ 1, key ^ 3]

		for (const candidate of order) {
			const source = entry.sources.get(candidate)

			if (source === undefined || source.state === "failed") continue

			await this.loadSource(entry, source)

			if (source.state === "loaded") return true
		}

		return entry.faces.length > 0
	}

	private loadSource(entry: EmbeddedFamily | undefined, source: EmbeddedSource): Promise<void> {
		if (entry === undefined || source.state !== "pending") return source.load ?? Promise.resolve()

		if (source.load === null) {
			source.load = this.embeddedQueue.then(() => this.readSource(entry, source))
			this.embeddedQueue = source.load
		}

		return source.load
	}

	private async readSource(entry: EmbeddedFamily, source: EmbeddedSource): Promise<void> {
		const bold = (source.key & 2) !== 0
		const italic = (source.key & 1) !== 0

		if (this.disposed) return

		try {
			const budget = Math.min(this.limits.maxEmbeddedFaceBytes, this.limits.maxEmbeddedBytes - this.embeddedBytes)

			if (budget <= 0) throw new FontError("tooLarge", `No size budget left for the embedded ${entry.name}`)

			const data = await source.read(budget)

			if (this.disposed) return
			if (data.length > budget) throw new FontError("tooLarge", `Embedded font for ${entry.name} exceeds the size limit`)

			const font = readSfnt(data)
			const descriptor: FontFaceDescriptor = { family: entry.alias, weight: bold ? 700 : 400, italic }
			const added = await this.host.addBytes(descriptor, data)

			if (this.disposed) {
				if (added) this.host.remove(entry.alias)

				return
			}

			if (!added) throw new Error("rejected by the platform")

			// Counted once the platform holds the face; the queue keeps the next read waiting until then.
			this.embeddedBytes += data.length
			entry.faces.push({ weight: bold ? 700 : 400, italic, metrics: font.metrics, fsType: font.fsType, data })
			this.registered.push({ ...descriptor, source: "embedded", declaredFamily: entry.name })
			this.resolved.clear()
			source.state = "loaded"
		} catch (error) {
			source.state = "failed"
			// A copy: the thrown error's captured stack can keep the refused bytes alive.
			source.error = error instanceof FontError ? new FontError(error.code, error.message) : new Error(reasonOf(error))

			if (!this.disposed) this.failed.push({ family: entry.name, bold, italic, reason: reasonOf(error) })
		}
	}

	// The family and its font-table alternatives, as written (keys are their lower-cased forms).
	private candidates(family: string): string[] {
		const declaration = this.declarations.get(family.toLowerCase())

		if (declaration === undefined) return [family]

		const out = [family]

		for (const name of [declaration.name, ...declaration.altNames]) {
			if (!out.some(known => known.toLowerCase() === name.toLowerCase())) out.push(name)
		}

		return out
	}

	private hints(family: string): FontHints {
		return this.declarations.get(family.toLowerCase())?.hints ?? NO_HINTS
	}

	private async prepareOne(request: FontRequest): Promise<void> {
		const key = styleKey(request.bold, request.italic)

		for (const name of this.candidates(request.family)) {
			const lower = name.toLowerCase()
			const embedded = this.embedded.get(lower)

			if (embedded !== undefined && (await this.loadEmbedded(embedded, key))) return
			if (this.disposed) return

			const substitution = SUBSTITUTIONS.get(lower)

			if (substitution !== undefined) {
				if (substitution.preferLocal && (await this.probeLocal(name, key))) return
				if (this.disposed) return

				await this.loadBundled(substitution.family, this.weightFor(request, substitution.weight), request.italic)

				return
			}
		}

		if ((await this.probeLocal(request.family, key)) || this.disposed) return

		const fallback = fallbackFor(request.family, this.hints(request.family), isLatin(request.slot))

		if (fallback.family !== undefined) await this.loadBundled(fallback.family, request.bold ? 700 : 400, request.italic)
	}

	private weightFor(request: FontRequest, pinned: number | undefined): number {
		return request.bold ? Math.max(700, pinned ?? 0) : (pinned ?? 400)
	}

	// Whether an installed copy of `name` exists, probing it (and the requested style) once.
	private async probeLocal(name: string, key: number): Promise<boolean> {
		const lower = name.toLowerCase()

		if (!this.local.has(lower)) {
			let probe = this.localProbes.get(lower)

			if (probe === undefined) {
				probe = this.probeFamily(name)
				this.localProbes.set(lower, probe)
			}

			await probe
		}

		const family = this.local.get(lower)

		if (this.disposed) return false

		if (family === undefined || family === null) return false

		if (key !== 0 && !family.styles.has(key)) {
			const probeKey = `${lower}\u0000${key}`
			let probe = this.localStyleProbes.get(probeKey)

			if (probe === undefined) {
				probe = this.addLocalFace(family, key)
				this.localStyleProbes.set(probeKey, probe)
			}

			await probe
		}

		return true
	}

	private async probeFamily(name: string): Promise<void> {
		const lower = name.toLowerCase()

		if (this.localCount >= this.limits.maxLocalProbes || name.length > MAX_LOCAL_NAME || !printable(name)) {
			this.local.set(lower, null)

			return
		}

		const family: LocalFamily = { alias: `${this.prefix}-l${++this.localCount}`, name, styles: new Set() }

		this.local.set(lower, (await this.addLocalFace(family, 0)) ? family : null)
	}

	private async addLocalFace(family: LocalFamily, key: number): Promise<boolean> {
		const descriptor: FontFaceDescriptor = { family: family.alias, weight: key & 2 ? 700 : 400, italic: (key & 1) !== 0 }
		const name = localName(family.name, key)

		if (this.disposed) return false

		if (!this.settled(family.alias, await this.host.addLocal(descriptor, name))) return false

		family.styles.add(key)
		this.registered.push({ ...descriptor, source: "local", name })

		return true
	}

	private loadBundled(family: BundledFamily, weight: number, italic: boolean): Promise<boolean> {
		const face = bundledFace(family, weight, italic)

		if (face === undefined) return Promise.resolve(false)

		let load = this.assetLoads.get(face.file)

		if (load === undefined) {
			const descriptor: FontFaceDescriptor = { family: `${this.prefix}-${family}`, weight: face.weight, italic: face.italic }

			load = this.assets
				.read(face.file)
				.then(data => (this.disposed ? false : this.host.addBytes(descriptor, data)))
				.then(added => {
					if (!this.settled(descriptor.family, added)) return false

					this.loadedAssets.add(face.file)
					this.registered.push({ ...descriptor, source: "asset", file: face.file })

					return true
				})
				.catch(() => false)
			this.assetLoads.set(face.file, load)
		}

		return load
	}

	private compute(request: FontRequest): ResolvedFont {
		const weight = request.bold ? 700 : 400
		const candidates = this.candidates(request.family)
		const fallback = fallbackFor(request.family, this.hints(request.family), isLatin(request.slot))
		const known = candidates.map(name => SUBSTITUTIONS.get(name.toLowerCase())).find(substitution => substitution !== undefined)
		// A family with a substitute keeps its generic class, and no unrelated family, when that face is missing.
		const generic = known?.generic ?? fallback.generic

		for (const name of candidates) {
			const lower = name.toLowerCase()
			const embedded = this.embedded.get(lower)

			if (embedded !== undefined && embedded.faces.length > 0) return this.fromEmbedded(embedded, weight, request.italic, generic)

			const substitution = SUBSTITUTIONS.get(lower)

			if (substitution === undefined) continue

			if (substitution.preferLocal) {
				const local = this.local.get(lower)

				if (local !== undefined && local !== null) return this.fromLocal(local, weight, request.italic, substitution.generic)
			}

			const substituted = this.fromBundled(
				substitution.family,
				this.weightFor(request, substitution.weight),
				request.italic,
				substitution.scale,
				substitution.widthScale,
				substitution.generic,
				lower
			)

			if (substituted !== null) return substituted
		}

		if (known === undefined) {
			const local = this.local.get(request.family.toLowerCase())

			if (local !== undefined && local !== null) return this.fromLocal(local, weight, request.italic, generic)

			if (fallback.family !== undefined) {
				const substituted = this.fromBundled(fallback.family, weight, request.italic, 1, 1, generic, null)

				if (substituted !== null) return substituted
			}
		}

		return this.intern({
			family: null,
			generic,
			weight,
			italic: request.italic,
			scale: 1,
			widthScale: 1,
			metrics: null,
			metricsBasis: "runtime",
			source: "generic"
		})
	}

	private fromEmbedded(family: EmbeddedFamily, weight: number, italic: boolean, generic: GenericFamily): ResolvedFont {
		// The loaded face CSS matching draws with: style first, then weight.
		const face =
			family.faces.find(f => f.weight === weight && f.italic === italic) ??
			family.faces.find(f => f.italic === italic) ??
			family.faces.find(f => f.weight === weight) ??
			family.faces[0]

		return this.intern({
			family: family.alias,
			generic,
			weight,
			italic,
			scale: 1,
			widthScale: 1,
			metrics: face?.metrics ?? null,
			metricsBasis: face === undefined ? "runtime" : "font",
			source: "embedded"
		})
	}

	private fromLocal(family: LocalFamily, weight: number, italic: boolean, generic: GenericFamily): ResolvedFont {
		return this.intern({
			family: family.alias,
			generic,
			weight,
			italic,
			scale: 1,
			widthScale: 1,
			metrics: null,
			metricsBasis: "runtime",
			source: "local"
		})
	}

	// null when the face is not loaded (not prepared, or the asset failed). The requested family's published or
	// calibrated metrics win; otherwise those of the original the substitute clones, whose own tables may have
	// been rebuilt (Arimo's win metrics are not Arial's); otherwise the substitute's own.
	private fromBundled(
		family: BundledFamily,
		weight: number,
		italic: boolean,
		scale: number,
		widthScale: number,
		generic: GenericFamily,
		original: string | null
	): ResolvedFont | null {
		const face = bundledFace(family, weight, italic)

		if (face === undefined || !this.loadedAssets.has(face.file)) return null

		const line = original === null ? undefined : LINE_METRICS.get(original)
		const published = line !== undefined && line.basis !== "substitute"

		return this.intern({
			family: `${this.prefix}-${family}`,
			generic,
			weight,
			italic,
			scale,
			widthScale,
			metrics: published ? line.metrics : (CLONE_METRICS.get(family)?.metrics ?? face.metrics),
			metricsBasis: published ? "original" : "substitute",
			source: "bundled"
		})
	}

	private intern(font: Omit<ResolvedFont, "id">): ResolvedFont {
		const metrics = font.metrics === null ? "" : Object.values(font.metrics).join(",")
		const key = `${font.source}|${font.family ?? ""}|${font.generic}|${font.weight}|${font.italic}|${font.scale}|${font.widthScale}|${font.metricsBasis}|${metrics}`
		let interned = this.interned.get(key)

		if (interned === undefined) {
			interned = { id: this.interned.size + 1, ...font }
			this.interned.set(key, interned)
		}

		return interned
	}
}
