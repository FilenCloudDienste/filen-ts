import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { format, resolveConfig } from "prettier"
import type { BundledFace, LineMetricsEntry, OriginalMetrics } from "../core/fonts/bundled"
import type { VerticalMetrics } from "../core/fonts/metrics"
import { readSfnt } from "../core/fonts/sfnt"
import { SUBSTITUTIONS, type BundledFamily } from "../core/fonts/substitutes"
import { sfntFromWoff2 } from "./woff2Tables"

// Generates src/core/fonts/tables.generated.ts from assets/fonts: every bundled face is checked against its
// recorded SHA-256 and its metrics are read from the file itself; line metrics of original fonts come only
// from the metric sources the manifest names (downloaded and checked here, never shipped) and the numbers it
// records from an original's own tables.
//
//   pnpm run generate:fonts [--metric-source <downloaded archive>]

export const ASSETS = fileURLToPath(new URL("../../assets/fonts/", import.meta.url))
export const OUTPUT = fileURLToPath(new URL("../core/fonts/tables.generated.ts", import.meta.url))

interface ManifestFace {
	file: string
	weight: number | [number, number]
	italic: boolean
	bytes: number
	sha256: string
}

interface ManifestFamily {
	id: BundledFamily
	name: string
	// The original font the family clones.
	replaces: string
	faces: ManifestFace[]
}

interface MetricSource {
	name: string
	version: string
	url: string
	sha256: string
	originals: Record<string, string>
}

// Vertical metrics read once from the original font's own tables, recorded as numbers: the font may not be
// redistributed, so nothing of it is read at generation time or shipped.
interface MeasuredLineMetrics {
	family: string
	font: string
	version: string
	files: string
	unitsPerEm: number
	hhea: { ascender: number; descender: number; lineGap: number }
	typo: { ascender: number; descender: number; lineGap: number }
	win: { ascent: number; descent: number }
	useTypoMetrics: boolean
}

// Line metrics of a family no font file describes, calibrated from Word's recorded page breaks.
interface CalibratedLineMetrics {
	family: string
	lineHeight: number
	// Thousandths of an em; they add up to the line height.
	ascent: number
	descent: number
	evidence: string
}

// A handwriting family the PDF signature dialog draws a typed name in (not a document substitute).
export interface SignatureFamily {
	id: string
	name: string
	version: string
	licenseFile: string
	reservedFontName: string | null
	source: string
	commit: string
	faces: (ManifestFace & { unicodeRange: string; upstream: { url: string; sha256: string } })[]
}

export interface Manifest {
	families: ManifestFamily[]
	signatures: SignatureFamily[]
	metricSources: MetricSource[]
	measuredLineMetrics: MeasuredLineMetrics[]
	calibratedLineMetrics: CalibratedLineMetrics[]
}

export function readManifest(): Manifest {
	return JSON.parse(readFileSync(`${ASSETS}manifest.json`, "utf8")) as Manifest
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

function metricsOf(sfnt: Uint8Array): VerticalMetrics {
	return { ...readSfnt(sfnt).metrics }
}

export function bundledFaceTable(
	manifest: Manifest,
	read: (file: string) => Uint8Array = file => readFileSync(`${ASSETS}${file}`)
): BundledFace[] {
	const faces: BundledFace[] = []

	for (const family of manifest.families) {
		for (const face of family.faces) {
			const bytes = read(face.file)

			if (bytes.length !== face.bytes || sha256(bytes) !== face.sha256) throw new Error(`${face.file} does not match the manifest`)

			const font = readSfnt(sfntFromWoff2(bytes))
			const familyName = font.names.typographicFamily ?? font.names.family ?? ""

			if (!familyName.startsWith(family.name)) throw new Error(`${face.file} is ${familyName}, not ${family.name}`)
			if (font.italic !== face.italic) throw new Error(`${face.file}: italic flag differs from the manifest`)

			faces.push({
				family: family.id,
				file: face.file,
				weight: face.weight,
				italic: face.italic,
				bytes: face.bytes,
				metrics: { ...font.metrics }
			})
		}
	}

	return faces
}

// Regular files of a .tar.gz by base name.
function untar(archive: Uint8Array): Map<string, Uint8Array> {
	const tar = new Uint8Array(gunzipSync(archive))
	const files = new Map<string, Uint8Array>()
	const text = (start: number, length: number): string => {
		const field = tar.subarray(start, start + length)
		const end = field.indexOf(0)

		return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end))
	}

	for (let at = 0; at + 512 <= tar.length;) {
		const name = text(at, 100)

		if (name === "") break

		const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8)
		const type = tar[at + 156]

		if (type === 0 || type === 0x30) files.set(name.slice(name.lastIndexOf("/") + 1), tar.subarray(at + 512, at + 512 + size))

		at += 512 + Math.ceil(size / 512) * 512
	}

	return files
}

export function lineMetricsTable(manifest: Manifest, archives: ReadonlyMap<string, Uint8Array>): Map<string, LineMetricsEntry> {
	const originals = new Map<string, LineMetricsEntry>()

	for (const source of manifest.metricSources) {
		const archive = archives.get(source.url)

		if (archive === undefined || sha256(archive) !== source.sha256) throw new Error(`${source.url} does not match the manifest`)

		const files = untar(archive)

		for (const [original, file] of Object.entries(source.originals)) {
			const font = files.get(file)

			if (font === undefined) throw new Error(`${file} is not in ${source.url}`)
			if (!SUBSTITUTIONS.has(original.toLowerCase())) throw new Error(`${original} has no substitute`)

			originals.set(original.toLowerCase(), {
				basis: "original",
				source: `${file} (${source.name} ${source.version})`,
				metrics: metricsOf(font)
			})
		}
	}

	for (const measured of manifest.measuredLineMetrics) {
		const key = measured.family.toLowerCase()

		if (!SUBSTITUTIONS.has(key)) throw new Error(`${measured.family} has no substitute`)
		if (originals.has(key)) throw new Error(`${measured.family} has published metrics`)

		const { hhea, typo, win } = measured

		originals.set(key, {
			basis: "original",
			source: `${measured.font}, ${measured.version} (${measured.files}): head unitsPerEm, hhea, OS/2 typo and win values`,
			metrics: {
				unitsPerEm: measured.unitsPerEm,
				hheaAscender: hhea.ascender,
				hheaDescender: hhea.descender,
				hheaLineGap: hhea.lineGap,
				typoAscender: typo.ascender,
				typoDescender: typo.descender,
				typoLineGap: typo.lineGap,
				winAscent: win.ascent,
				winDescent: win.descent,
				useTypoMetrics: measured.useTypoMetrics
			}
		})
	}

	for (const calibrated of manifest.calibratedLineMetrics) {
		const key = calibrated.family.toLowerCase()

		if (!SUBSTITUTIONS.has(key)) throw new Error(`${calibrated.family} has no substitute`)
		if (originals.has(key)) throw new Error(`${calibrated.family} has published metrics`)
		if (Math.abs(calibrated.ascent + calibrated.descent - calibrated.lineHeight * 1000) > 1)
			throw new Error(`${calibrated.family}: ascent and descent do not add up`)

		const { ascent, descent } = calibrated

		originals.set(key, {
			basis: "calibrated",
			source: calibrated.evidence,
			metrics: {
				unitsPerEm: 1000,
				hheaAscender: ascent,
				hheaDescender: -descent,
				hheaLineGap: 0,
				typoAscender: ascent,
				typoDescender: -descent,
				typoLineGap: 0,
				winAscent: ascent,
				winDescent: descent,
				useTypoMetrics: false
			}
		})
	}

	const table = new Map<string, LineMetricsEntry>()

	for (const family of SUBSTITUTIONS.keys()) table.set(family, originals.get(family) ?? { basis: "substitute" })

	return table
}

// Per bundled family, the published metrics of the original it clones: the vertical metrics the clone was
// built to reproduce, used wherever the family draws text (the clone's own tables may have been rebuilt).
export function cloneMetricsTable(
	manifest: Manifest,
	lineMetrics: ReadonlyMap<string, LineMetricsEntry>
): Map<BundledFamily, OriginalMetrics> {
	const table = new Map<BundledFamily, OriginalMetrics>()

	for (const family of manifest.families) {
		const entry = lineMetrics.get(family.replaces.toLowerCase())

		if (entry?.basis === "original") table.set(family.id, { source: entry.source, metrics: entry.metrics })
	}

	return table
}

// Metrics as one positional call each: the table ships in every bundle that lays out text.
function metricsCall(m: VerticalMetrics): string {
	const values = [m.unitsPerEm, m.hheaAscender, m.hheaDescender, m.hheaLineGap, m.typoAscender, m.typoDescender, m.typoLineGap]

	return `verticalMetrics(${[...values, m.winAscent, m.winDescent, m.useTypoMetrics].join(", ")})`
}

export async function renderTables(
	faces: readonly BundledFace[],
	lineMetrics: ReadonlyMap<string, LineMetricsEntry>,
	cloneMetrics: ReadonlyMap<BundledFamily, OriginalMetrics>
): Promise<string> {
	const faceRows = faces.map(face => {
		const { metrics, ...rest } = face

		return `${JSON.stringify(rest).slice(0, -1)}, "metrics": ${metricsCall(metrics)}}`
	})
	const lineRows = [...lineMetrics].map(([family, entry]) =>
		entry.basis !== "substitute"
			? `[${JSON.stringify(family)}, { basis: ${JSON.stringify(entry.basis)}, source: ${JSON.stringify(entry.source)}, metrics: ${metricsCall(entry.metrics)} }]`
			: `[${JSON.stringify(family)}, { basis: "substitute" }]`
	)
	const cloneRows = [...cloneMetrics].map(
		([family, entry]) =>
			`[${JSON.stringify(family)}, { source: ${JSON.stringify(entry.source)}, metrics: ${metricsCall(entry.metrics)} }]`
	)
	const source = `// Generated by \`pnpm run generate:fonts\` from assets/fonts/manifest.json. Do not edit.

import type { BundledFace, LineMetricsEntry, OriginalMetrics } from "./bundled"
import { verticalMetrics } from "./metrics"
import type { BundledFamily } from "./substitutes"

export const BUNDLED_FACES: readonly BundledFace[] = [${faceRows.join(",\n")}]

export const LINE_METRICS: ReadonlyMap<string, LineMetricsEntry> = new Map<string, LineMetricsEntry>([${lineRows.join(",\n")}])

export const CLONE_METRICS: ReadonlyMap<BundledFamily, OriginalMetrics> = new Map<BundledFamily, OriginalMetrics>([${cloneRows.join(",\n")}])
`

	return format(source, { ...(await resolveConfig(OUTPUT)), filepath: OUTPUT })
}

async function main(): Promise<void> {
	const manifest = readManifest()
	const archives = new Map<string, Uint8Array>()
	const local = process.argv.indexOf("--metric-source")

	for (const source of manifest.metricSources) {
		if (local >= 0 && process.argv[local + 1] !== undefined) {
			archives.set(source.url, new Uint8Array(readFileSync(process.argv[local + 1] ?? "")))

			continue
		}

		const response = await fetch(source.url)

		if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`)

		archives.set(source.url, new Uint8Array(await response.arrayBuffer()))
	}

	const lineMetrics = lineMetricsTable(manifest, archives)

	writeFileSync(OUTPUT, await renderTables(bundledFaceTable(manifest), lineMetrics, cloneMetricsTable(manifest, lineMetrics)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
