import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import {
	CORPUS_PASSWORDS,
	extensionOf,
	indexDeck,
	isEncryptedPpt,
	isPresentation,
	readCorpusList,
	type CorpusEntry,
	type DeckIndex
} from "./corpus"
import { decodePng, type RgbaImage } from "./pixel"

// The LibreOffice 7.5 oracle cache: per corpus file (by the SHA-256 of its bytes) the UNO model as JSON, a PNG per
// slide, a background-only PNG per slide and a PDF, made by lo_slides.py --cache with one LibreOffice at a time.
// Tests read it through FILEN_OFFICE_LO_CACHE and skip without it. Building it:
//   node --import tsx src/tests/oracles/presentation/lo.ts build --list <frozen list> --corpus <dir> --cache <dir>
//        --script <lo_slides.py> --python <LibreOffice's python> --profile <profile path prefix> [--batch 8] [--file-timeout <s>]

export interface LoShape {
	readonly type: string
	readonly box100mm?: readonly [number, number, number, number]
	readonly rot?: number | null
	readonly presObj?: boolean | null
	readonly placeholder?: boolean | null
	readonly text?: string
	readonly children?: readonly LoShape[]
}

export interface LoAnimationNode {
	readonly type: number | null
	readonly begin: string | null
	readonly dur: string | null
	readonly fill: number | null
	readonly "node-type"?: string
	readonly "preset-id"?: string
	readonly "preset-class"?: string
	readonly "preset-sub-type"?: string
	readonly attr?: string
	readonly children?: readonly LoAnimationNode[]
}

export interface LoSlide {
	readonly name: string
	readonly layout: number | null
	readonly master: string | null
	readonly hidden: boolean
	readonly transition: {
		readonly type: number | null
		readonly sub: number | null
		readonly fadeColor: number | null
		readonly dur: number | null
		readonly change: number | null
		readonly auto: number | null
	}
	readonly shapes: readonly LoShape[]
	readonly animation?: LoAnimationNode
	readonly notes?: readonly string[]
	// "ok", or why the background pass failed.
	readonly bg?: string
	// Set when the slide was not rendered (no PNG, left out of the PDF): why.
	readonly render?: string
}

export interface LoDeck {
	readonly file: string
	readonly sha256: string
	readonly masters?: readonly string[]
	readonly slideSize100mm?: readonly [number, number]
	readonly slides?: readonly LoSlide[]
	readonly customShows?: readonly string[]
	// The deck's slides the PDF holds, when some were left out ("1,2,4").
	readonly pdfPages?: string
	// Why LibreOffice could not write the PDF (the slides are rendered).
	readonly pdfError?: string
	readonly error?: string
}

// Slides LibreOffice 7.5 aborts on (the whole process) while rendering them, PNG or PDF: they are left out of the
// cache, the rest of the deck is rendered.
export const LO_ABORTING_SLIDES: Readonly<Record<string, readonly number[]>> = {
	"govuk__Shaping_the_Qualifications_Landscape.pptx": [13, 14],
	"govuk__Shaping_the_Qualifications_Landscape.odp": [13, 14]
}

export type LoStatus = "cached" | "msoffcryptoOnly" | "failed"

export interface LoIndexEntry {
	readonly path: string
	readonly sha256: string
	readonly status: LoStatus
	readonly slides: number
	readonly reason?: string
}

export interface LoCacheEntry {
	readonly dir: string
	readonly deck: LoDeck
}

// The cache tests read: FILEN_OFFICE_LO_CACHE, when it exists.
export function loCacheDir(): string | undefined {
	const configured = process.env["FILEN_OFFICE_LO_CACHE"]

	return configured !== undefined && configured !== "" && existsSync(configured) ? resolve(configured) : undefined
}

export function readLoCache(cache: string, sha256: string): LoCacheEntry | undefined {
	const dir = join(cache, sha256)
	const json = join(dir, "lo.json")

	if (!existsSync(json)) return undefined

	return { dir, deck: JSON.parse(readFileSync(json, "utf8")) as LoDeck }
}

function slideFile(entry: LoCacheEntry, slide: number, suffix: string): string {
	return join(entry.dir, `slide-${String(slide).padStart(3, "0")}${suffix}.png`)
}

// Slide `slide` (1-based) as LibreOffice renders it, and its background (undefined where that pass failed).
export function loSlideImages(entry: LoCacheEntry, slide: number): { readonly slide: RgbaImage; readonly bg: RgbaImage | undefined } {
	const bg = slideFile(entry, slide, "-bg")
	const ok = entry.deck.slides?.[slide - 1]?.bg === "ok" && existsSync(bg)

	return {
		slide: decodePng(new Uint8Array(readFileSync(slideFile(entry, slide, "")))),
		bg: ok ? decodePng(new Uint8Array(readFileSync(bg))) : undefined
	}
}

// Whether LibreOffice rendered slide `slide` (1-based).
export function loRendered(entry: LoCacheEntry, slide: number): boolean {
	const known = entry.deck.slides?.[slide - 1]

	return known !== undefined && known.render === undefined
}

export function loPdfPath(entry: LoCacheEntry): string {
	return join(entry.dir, "slides.pdf")
}

export function readLoIndex(cache: string): LoIndexEntry[] {
	const file = join(cache, "index.json")

	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LoIndexEntry[]) : []
}

export interface LoCacheBuild {
	readonly entries: readonly CorpusEntry[]
	readonly corpus: string
	readonly cache: string
	readonly script: string
	readonly python: string
	// Profile directories are `${profile}-<n>`; n moves on after a LibreOffice had to be stopped.
	readonly profile: string
	readonly batch?: number
	// Per file in a batch; a batch gets this times its length plus a minute for LibreOffice to start.
	readonly fileTimeoutMs?: number
	readonly width?: number
	readonly force?: boolean
	readonly log?: (line: string) => void
}

interface BatchOutcome {
	readonly done: ReadonlySet<string>
	readonly timedOut: boolean
}

function sha256Of(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex")
}

// One lo_slides.py run over `files` (absolute paths). The Python process and the soffice it started are stopped by
// PID once the time is up.
function runBatch(build: LoCacheBuild, files: readonly string[], profile: string, maps: readonly string[]): Promise<BatchOutcome> {
	const timeout = 60_000 + (build.fileTimeoutMs ?? 300_000) * files.length
	const args = [
		build.script,
		"--profile",
		profile,
		"--out",
		build.cache,
		"--cache",
		"--png",
		"--bg",
		"--pdf",
		"--width",
		String(build.width ?? 1280),
		...maps,
		...files
	]

	return new Promise(done => {
		const child = spawn(build.python, args, { stdio: ["ignore", "pipe", "pipe"] })
		const finished = new Set<string>()
		let soffice: number | undefined
		let timedOut = false
		let out = ""

		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("utf8")

			let newline = out.indexOf("\n")

			while (newline >= 0) {
				const line = out.slice(0, newline)

				out = out.slice(newline + 1)
				newline = out.indexOf("\n")

				try {
					const parsed = JSON.parse(line) as { file: string; slides: number; error: string | null }

					finished.add(parsed.file)
					build.log?.(`${parsed.file}: ${String(parsed.slides)} slides${parsed.error === null ? "" : ` (${parsed.error})`}`)
				} catch {
					build.log?.(line)
				}
			}
		})
		child.stderr.on("data", (chunk: Buffer) => {
			const pid = /soffice pid (\d+)\n/.exec(chunk.toString("utf8"))?.[1]

			if (pid !== undefined && soffice === undefined) soffice = Number(pid)
		})

		const timer = setTimeout(() => {
			timedOut = true

			for (const pid of [child.pid, soffice]) {
				if (pid === undefined) continue

				try {
					process.kill(pid, "SIGKILL")
				} catch {
					// Already gone.
				}
			}
		}, timeout)

		child.on("close", () => {
			clearTimeout(timer)
			done({ done: finished, timedOut })
		})
	})
}

// Builds (or completes) the cache over the presentations of `entries`, one LibreOffice at a time, and writes
// <cache>/index.json: every file cached, listed as msoffcrypto-only (an encrypted .ppt) or failed with the reason.
export async function buildLoCache(build: LoCacheBuild): Promise<LoIndexEntry[]> {
	mkdirSync(build.cache, { recursive: true })

	const passwords = join(tmpdir(), `lo-passwords-${String(process.pid)}.json`)

	writeFileSync(passwords, JSON.stringify(CORPUS_PASSWORDS))

	const skips = join(tmpdir(), `lo-skips-${String(process.pid)}.json`)

	writeFileSync(skips, JSON.stringify(LO_ABORTING_SLIDES))

	const maps = ["--passwords", passwords, "--skip", skips]

	const presentations = build.entries.filter(entry => isPresentation(entry.path))
	const pending: { entry: CorpusEntry; file: string; sha256: string }[] = []
	const listed = new Map<string, LoIndexEntry>()
	let run = 1

	for (const entry of presentations) {
		const file = join(build.corpus, entry.path)

		if (!existsSync(file)) {
			listed.set(entry.path, {
				path: entry.path,
				sha256: entry.sha256,
				status: "failed",
				slides: 0,
				reason: "missing from the corpus"
			})

			continue
		}

		const sha256 = sha256Of(file)

		if (entry.sha256 !== "" && entry.sha256 !== sha256) {
			listed.set(entry.path, {
				path: entry.path,
				sha256,
				status: "failed",
				slides: 0,
				reason: `sha256 differs from the list (${entry.sha256})`
			})

			continue
		}

		if (
			["ppt", "pps", "pot"].includes(extensionOf(entry.path)) &&
			(await isEncryptedPpt(new Uint8Array(readFileSync(file)))) === true
		) {
			listed.set(entry.path, {
				path: entry.path,
				sha256,
				status: "msoffcryptoOnly",
				slides: 0,
				reason: "encrypted .ppt: LibreOffice 7.5 opens it neither encrypted nor decrypted"
			})

			continue
		}

		const head = readFileSync(file).subarray(0, 8)

		if (
			!["ppt", "pps", "pot"].includes(extensionOf(entry.path)) &&
			head[0] === 0xd0 &&
			head[1] === 0xcf &&
			CORPUS_PASSWORDS[basename(entry.path)] === undefined
		) {
			listed.set(entry.path, {
				path: entry.path,
				sha256,
				status: "failed",
				slides: 0,
				reason: "encrypted package whose password is not published"
			})

			continue
		}

		if (build.force === true) rmSync(join(build.cache, sha256), { recursive: true, force: true })

		const cached = readLoCache(build.cache, sha256)

		if (cached !== undefined && cached.deck.error === undefined) continue

		pending.push({ entry, file, sha256 })
	}

	build.log?.(`${String(presentations.length)} presentations, ${String(pending.length)} to render`)

	const size = build.batch ?? 8

	for (let at = 0; at < pending.length; at += size) {
		const batch = pending.slice(at, at + size)
		const outcome = await runBatch(
			build,
			batch.map(item => item.file),
			`${build.profile}-${String(run)}`,
			maps
		)

		// A file that stopped LibreOffice fails every file after it in the batch (the bridge is gone), and a hung one
		// stops the batch: whatever did not render goes again on its own, in a fresh profile.
		const retry = batch.filter(item => !outcome.done.has(item.file) || readLoCache(build.cache, item.sha256)?.deck.error !== undefined)

		if (retry.length === 0) continue

		run++

		for (const item of retry) {
			const single = await runBatch(build, [item.file], `${build.profile}-${String(run)}`, maps)

			if (single.timedOut || !single.done.has(item.file)) {
				run++
				rmSync(join(build.cache, item.sha256), { recursive: true, force: true })
				listed.set(item.entry.path, {
					path: item.entry.path,
					sha256: item.sha256,
					status: "failed",
					slides: 0,
					reason: single.timedOut ? "LibreOffice did not finish in time" : "LibreOffice stopped while rendering it"
				})
			} else if (readLoCache(build.cache, item.sha256)?.deck.error !== undefined) run++
		}
	}

	rmSync(passwords, { force: true })
	rmSync(skips, { force: true })
	rmSync(join(build.cache, "work"), { recursive: true, force: true })

	const index: LoIndexEntry[] = presentations.map(entry => {
		const known = listed.get(entry.path)

		if (known !== undefined) return known

		const sha256 = sha256Of(join(build.corpus, entry.path))
		const cached = readLoCache(build.cache, sha256)
		const error = cached === undefined ? "no output" : cached.deck.error

		return error === undefined
			? { path: entry.path, sha256, status: "cached", slides: cached?.deck.slides?.length ?? 0 }
			: { path: entry.path, sha256, status: "failed", slides: 0, reason: error }
	})

	writeFileSync(join(build.cache, "index.json"), `${JSON.stringify(index, null, 1)}\n`)

	return index
}

function nodes(node: LoAnimationNode | undefined): number {
	return node === undefined ? 0 : 1 + (node.children ?? []).reduce((sum, child) => sum + nodes(child), 0)
}

// A binary deck's slides as LibreOffice read them: their animation nodes (the root excluded), where the cache has it.
export function withLoFeatures(deck: DeckIndex, cache: string): DeckIndex {
	if (deck.slides.length > 0 || deck.skipped?.startsWith("binary") !== true || deck.sha256 === "") return deck

	const slides = readLoCache(cache, deck.sha256)?.deck.slides

	if (slides === undefined) return deck

	return {
		path: deck.path,
		sha256: deck.sha256,
		format: deck.format,
		slides: slides.map((slide, index) => ({
			slide: index + 1,
			vertical: [],
			animationNodes: Math.max(0, nodes(slide.animation) - 1),
			smartArt: { cached: 0, uncached: 0 }
		}))
	}
}

function option(args: readonly string[], name: string): string | undefined {
	const at = args.indexOf(`--${name}`)

	return at >= 0 ? args[at + 1] : undefined
}

function required(args: readonly string[], name: string): string {
	const value = option(args, name)

	if (value === undefined) throw new Error(`--${name} is required`)

	return value
}

async function main(args: readonly string[]): Promise<void> {
	const command = args[0]

	if (command === "build") {
		const batch = option(args, "batch")
		const timeout = option(args, "file-timeout")
		const only = option(args, "only")
		const entries = readCorpusList(required(args, "list"))
		const index = await buildLoCache({
			entries: only === undefined ? entries : entries.filter(entry => only.split(",").includes(entry.path)),
			corpus: required(args, "corpus"),
			cache: required(args, "cache"),
			script: required(args, "script"),
			python: required(args, "python"),
			profile: required(args, "profile"),
			...(batch === undefined ? {} : { batch: Number(batch) }),
			...(timeout === undefined ? {} : { fileTimeoutMs: Number(timeout) * 1000 }),
			force: args.includes("--force"),
			log: line => process.stdout.write(`${line}\n`)
		})
		const counts = new Map<LoStatus, number>()

		for (const entry of index) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1)

		process.stdout.write(`${JSON.stringify(Object.fromEntries(counts))}\n`)

		return
	}

	if (command === "index") {
		const corpus = required(args, "corpus")
		const cache = option(args, "cache")
		const decks = []

		for (const entry of readCorpusList(required(args, "list"))) {
			if (!isPresentation(entry.path)) continue

			const deck = await indexDeck(corpus, entry)

			decks.push(cache === undefined ? deck : withLoFeatures(deck, cache))
		}

		writeFileSync(required(args, "out"), `${JSON.stringify(decks)}\n`)

		return
	}

	throw new Error("usage: lo.ts build|index ...")
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main(process.argv.slice(2))
