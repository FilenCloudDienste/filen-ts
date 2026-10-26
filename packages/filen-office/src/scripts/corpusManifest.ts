import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// Generates corpus/manifest.json, corpus/catalogue.json and corpus/README.md from the full manifest the corpus
// was assembled with. Only what fetching, verifying and attributing the files needs is committed; the files
// themselves never are (see fetchCorpus.ts). --drop instead rewrites the committed three without some files (one
// whose pinned bytes no source serves any more).
//
//   pnpm run corpus:manifest [--from <MANIFEST.json>]
//   pnpm run corpus:manifest --drop <path>[,<path>...]

const OUT = fileURLToPath(new URL("../../corpus/", import.meta.url))
const DEFAULT_FROM = fileURLToPath(new URL("../../../filen-web/docs/office/corpus/MANIFEST.json", import.meta.url))

interface SourceFile {
	file: string
	sha256: string
	size: number
	// The published fixture password of an encrypted file, from the source repository's own test data.
	password?: string
	// The published password to modify or unprotect of a file whose w:writeProtection or w:documentProtection
	// carries a hash (the file itself opens without one).
	modifyPassword?: string
	source: {
		collection: string
		url: string
		rawUrl?: string
		repo?: string
		commit?: string
		pageUrl?: string
		licence: string
		licenceUrl: string
		licenceNote: string
	}
	catalogue: Record<string, unknown>
}

interface SourceManifest {
	generated: string
	files: SourceFile[]
}

// One family per engine; the files of a format live in a directory named after its extension.
export const FAMILIES = {
	docx: ["docx", "docm", "dotx", "dotm"],
	xlsx: ["xlsx", "xlsm", "xltx", "xltm"],
	csv: ["csv", "tsv", "tab"],
	pptx: ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"],
	odt: ["odt"],
	ods: ["ods"],
	odp: ["odp", "otp"],
	rtf: ["rtf"],
	doc: ["doc", "dot"],
	xls: ["xls", "xlt"],
	ppt: ["ppt", "pps", "pot"],
	// Embedded font data (a presentation's embedded fonts, saved as Embedded OpenType).
	fntdata: ["fntdata"]
} as const satisfies Record<string, readonly string[]>

export type CorpusFamily = keyof typeof FAMILIES

// The container a file of each family normally is; the catalogue names it only where a file differs.
export const CONTAINERS: Record<CorpusFamily, string> = {
	docx: "zip",
	xlsx: "zip",
	csv: "text",
	pptx: "zip",
	odt: "zip",
	ods: "zip",
	odp: "zip",
	rtf: "rtf",
	doc: "cfb",
	xls: "cfb",
	ppt: "cfb",
	fntdata: "eot"
}

const EXTENSION_FAMILY = new Map<string, CorpusFamily>(
	Object.entries(FAMILIES).flatMap(([family, extensions]) => extensions.map(extension => [extension, family as CorpusFamily] as const))
)

// The family of a manifest path (`<extension>/<name>`), or undefined for an extension no family covers.
export function familyOf(path: string): CorpusFamily | undefined {
	return EXTENSION_FAMILY.get(path.slice(0, path.indexOf("/")))
}

// The corpus tolerates a few vanished sources (GOV.UK attachments can go); more than this many of `files` is a failure.
export function unavailableAllowed(files: number): number {
	return Math.min(10, Math.floor(files * 0.02))
}

export interface CorpusSource {
	id: string
	licence: string
	licenceUrl: string
	note: string
	repo?: string
	commit?: string
}

export interface CorpusFile {
	path: string
	size: number
	sha256: string
	source: string
	licence: string
	url: string
	// The publication page of a GOV.UK attachment, for attribution.
	page?: string
	// The published fixture password of an encrypted file (the encryption oracles and known-answer tests use it).
	password?: string
	// The published password of a w:writeProtection or w:documentProtection hash (known-answer tests).
	modifyPassword?: string
}

export interface CorpusManifest {
	version: 1
	generated: string
	sources: CorpusSource[]
	files: CorpusFile[]
}

// Zero, empty and null values are noise in a catalogue of mostly-absent features.
function compact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(compact)

	if (value === null || typeof value !== "object") return value

	const out: Record<string, unknown> = {}

	for (const [key, entry] of Object.entries(value)) {
		const kept = compact(entry)

		if (kept === null || kept === 0 || kept === "" || (Array.isArray(kept) && kept.length === 0)) continue
		if (typeof kept === "object" && !Array.isArray(kept) && Object.keys(kept).length === 0) continue

		out[key] = kept
	}

	return out
}

// Pretty top level, one row per line: small diffs when the corpus changes, without a line per field.
function rows(head: Record<string, unknown>, key: string, entries: readonly unknown[]): string {
	const lines = Object.entries(head).map(
		([name, value]) => `\t${JSON.stringify(name)}: ${JSON.stringify(value, null, "\t").replaceAll("\n", "\n\t")},`
	)

	return `{\n${lines.join("\n")}\n\t${JSON.stringify(key)}: [\n${entries.map(entry => `\t\t${JSON.stringify(entry)}`).join(",\n")}\n\t]\n}\n`
}

function readme(manifest: CorpusManifest): string {
	const bySource = new Map<string, number>()
	const byFamily = new Map<string, { files: number; bytes: number; formats: Map<string, number> }>()

	for (const file of manifest.files) {
		bySource.set(file.source, (bySource.get(file.source) ?? 0) + 1)

		const family = familyOf(file.path) ?? "?"
		const totals = byFamily.get(family) ?? { files: 0, bytes: 0, formats: new Map<string, number>() }
		const format = file.path.slice(0, file.path.indexOf("/"))

		totals.files++
		totals.bytes += file.size
		totals.formats.set(format, (totals.formats.get(format) ?? 0) + 1)
		byFamily.set(family, totals)
	}

	const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1)
	const total = manifest.files.reduce((sum, file) => sum + file.size, 0)
	const pinned = (source: CorpusSource): string =>
		source.repo !== undefined && source.commit !== undefined
			? `[${source.repo}@${source.commit.slice(0, 10)}](https://github.com/${source.repo}/tree/${source.commit})`
			: "GOV.UK publication attachments (URL per file)"

	return [
		"# Office test corpus",
		"",
		"Real-world documents, spreadsheets and presentations in every format the office engines support, for the opt-in corpus tests. The files are not in the repository: `pnpm run corpus:fetch` downloads them from their original sources into `.corpus/` and verifies each against its SHA-256 here. Every file is an unmodified download; none was authored or re-saved for the corpus.",
		"",
		"GOV.UK and EIA replace a publication's attachments in place, so their files come from the `office-corpus-mirror` release of this repository first, each asset named by its SHA-256 (`pnpm run corpus:mirror` uploads what it lacks), and from the source only if the mirror lacks them.",
		"",
		"- `manifest.json`: per file the path, size, SHA-256, source, licence and download URL (raw files at pinned commits, GOV.UK asset URLs).",
		"- `catalogue.json`: per file the producer and version, application metadata and feature counts (zero and empty values omitted), to pick files by feature. Counts are cheap heuristics over the raw parts and records, not engine output; `container` appears only where a file is not the container its extension implies (an encrypted OOXML package, an RTF or HTML file named `.doc`, a pre-OLE Excel or Word stream).",
		"- `pnpm run corpus:fetch --family pptx,ppt` fetches only some families.",
		"",
		"Generated by `pnpm run corpus:manifest`; do not edit.",
		"",
		"## Sources and licences",
		"",
		"| Source | Licence | Files | Pinned at |",
		"|---|---|---|---|",
		...manifest.sources.map(
			source => `| ${source.id} | [${source.licence}](${source.licenceUrl}) | ${bySource.get(source.id) ?? 0} | ${pinned(source)} |`
		),
		"",
		"Repository fixtures carry the licence of the repository that hosts them; some of them were originally bug-tracker attachments. GOV.UK files contain public sector information licensed under the Open Government Licence v3.0 (Crown copyright unless the publication states otherwise); each entry links its publication page. Fuzzer artefacts, crash and hang reproducers and exploit samples were left out.",
		"",
		"## Families",
		"",
		"| Family | Formats | Files | MB |",
		"|---|---|---|---|",
		...Object.keys(FAMILIES)
			.filter(family => byFamily.has(family))
			.map(family => {
				const totals = byFamily.get(family) ?? { files: 0, bytes: 0, formats: new Map<string, number>() }
				const formats = [...totals.formats]
					.sort(([, a], [, b]) => b - a)
					.map(([format, files]) => `${format} ${files}`)
					.join(", ")

				return `| ${family} | ${formats} | ${totals.files} | ${megabytes(totals.bytes)} |`
			}),
		"",
		`Total: ${manifest.files.length} files, ${megabytes(total)} MB.`,
		""
	].join("\n")
}

function writeAll(manifest: CorpusManifest, catalogue: readonly unknown[]): void {
	writeFileSync(
		`${OUT}manifest.json`,
		rows({ version: manifest.version, generated: manifest.generated, sources: manifest.sources }, "files", manifest.files)
	)
	writeFileSync(`${OUT}catalogue.json`, rows({ generated: manifest.generated }, "files", catalogue))
	writeFileSync(`${OUT}README.md`, readme(manifest))
}

function drop(paths: ReadonlySet<string>): void {
	const manifest = JSON.parse(readFileSync(`${OUT}manifest.json`, "utf8")) as CorpusManifest
	const catalogue = JSON.parse(readFileSync(`${OUT}catalogue.json`, "utf8")) as { files: { path: string }[] }
	const unknown = [...paths].filter(path => !manifest.files.some(file => file.path === path))

	if (unknown.length > 0) throw new Error(`not in the manifest: ${unknown.join(", ")}`)

	writeAll(
		{ ...manifest, files: manifest.files.filter(file => !paths.has(file.path)) },
		catalogue.files.filter(entry => !paths.has(entry.path))
	)
}

function main(): void {
	const { values } = parseArgs({ options: { from: { type: "string", default: DEFAULT_FROM }, drop: { type: "string" } } })

	if (values.drop !== undefined) {
		drop(new Set(values.drop.split(",").map(path => path.trim())))

		return
	}

	const source = JSON.parse(readFileSync(values.from, "utf8")) as SourceManifest
	const sources = new Map<string, CorpusSource>()
	const files: CorpusFile[] = []
	const catalogue: Record<string, unknown>[] = []

	for (const entry of [...source.files].sort((a, b) => (a.file < b.file ? -1 : 1))) {
		const family = familyOf(entry.file)

		if (family === undefined) throw new Error(`${entry.file}: no corpus family for this extension`)

		const { collection, licence, licenceUrl, licenceNote, repo, commit } = entry.source
		const known = sources.get(collection)

		if (known === undefined) {
			sources.set(collection, {
				id: collection,
				licence,
				licenceUrl,
				note: licenceNote,
				...(repo !== undefined && { repo }),
				...(commit !== undefined && { commit })
			})
		} else if (known.licence !== licence || known.commit !== commit) {
			throw new Error(`${entry.file}: ${collection} files disagree on licence or commit`)
		}

		// Raw URLs at pinned commits serve the bytes directly; GitHub blob pages are HTML.
		const url = entry.source.rawUrl ?? entry.source.url

		if (!url.startsWith("https://")) throw new Error(`${entry.file}: not an https URL: ${url}`)

		files.push({
			path: entry.file,
			size: entry.size,
			sha256: entry.sha256,
			source: collection,
			licence,
			url,
			...(entry.source.pageUrl !== undefined && { page: entry.source.pageUrl }),
			...(entry.password !== undefined && { password: entry.password }),
			...(entry.modifyPassword !== undefined && { modifyPassword: entry.modifyPassword })
		})

		const { sha256: _sha256, size: _size, ext: _ext, container, ...rest } = entry.catalogue
		const details = compact(container === CONTAINERS[family] ? rest : { container, ...rest }) as Record<string, unknown>
		const app = details["app"] as Record<string, unknown> | undefined

		// The attached template is Normal.dotm for nearly every file.
		if (app !== undefined) delete app["template"]

		catalogue.push({ path: entry.file, ...details })
	}

	const manifest: CorpusManifest = {
		version: 1,
		generated: source.generated,
		sources: [...sources.values()].sort((a, b) => fileCount(files, b.id) - fileCount(files, a.id) || (a.id < b.id ? -1 : 1)),
		files
	}

	writeAll(manifest, catalogue)
}

function fileCount(files: readonly CorpusFile[], id: string): number {
	return files.filter(file => file.source === id).length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
