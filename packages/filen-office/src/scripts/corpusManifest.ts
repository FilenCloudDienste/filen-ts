import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

// Generates corpus/manifest.json, corpus/catalogue.json and corpus/README.md from the full manifest the corpus
// was assembled with. Only what fetching, verifying and attributing the files needs is committed; the files
// themselves never are (see fetchCorpus.ts). --drop instead rewrites the committed three without some files (one
// whose pinned bytes no source serves any more); --add rewrites them with more files of the known sources, each
// read from a local download of its pinned URL (a JSON array of CorpusAddition).
//
//   pnpm run corpus:manifest [--from <MANIFEST.json>]
//   pnpm run corpus:manifest --drop <path>[,<path>...]
//   pnpm run corpus:manifest --add <additions.json>

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
	// Excel binary workbooks: no engine reads them, the xlsx open path refuses them as unsupported.
	xlsb: ["xlsb"],
	csv: ["csv", "tsv", "tab"],
	pptx: ["pptx", "pptm", "ppsx", "ppsm", "potx", "potm"],
	odt: ["odt", "ott"],
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
	xlsb: "zip",
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

// The producer a catalogue entry names. A package without docProps/app.xml says nothing of its producer: the
// assembler's "google-docs?" guess for one marked LibreOffice fixtures as Google exports.
export function catalogueProducer(producer: unknown): unknown {
	return producer === "google-docs?" ? "unknown" : producer
}

function writeAll(manifest: CorpusManifest, catalogue: readonly Record<string, unknown>[]): void {
	const entries = catalogue.map(entry =>
		entry["producer"] === undefined ? entry : { ...entry, producer: catalogueProducer(entry["producer"]) }
	)

	writeFileSync(
		`${OUT}manifest.json`,
		rows({ version: manifest.version, generated: manifest.generated, sources: manifest.sources }, "files", manifest.files)
	)
	writeFileSync(`${OUT}catalogue.json`, rows({ generated: manifest.generated }, "files", entries))
	writeFileSync(`${OUT}README.md`, readme(manifest))
}

function readCommitted(): { manifest: CorpusManifest; catalogue: Record<string, unknown>[] } {
	return {
		manifest: JSON.parse(readFileSync(`${OUT}manifest.json`, "utf8")) as CorpusManifest,
		catalogue: (JSON.parse(readFileSync(`${OUT}catalogue.json`, "utf8")) as { files: Record<string, unknown>[] }).files
	}
}

const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : 1)

// Most files first, then by id.
function sortSources(sources: readonly CorpusSource[], files: readonly CorpusFile[]): CorpusSource[] {
	return [...sources].sort((a, b) => fileCount(files, b.id) - fileCount(files, a.id) || (a.id < b.id ? -1 : 1))
}

// One file to add with --add: its manifest path, its local download of `url`, and its catalogue details.
export interface CorpusAddition {
	path: string
	file: string
	source: string
	url: string
	password?: string
	modifyPassword?: string
	catalogue?: Record<string, unknown>
}

function add(from: string): void {
	const { manifest, catalogue } = readCommitted()
	const additions = JSON.parse(readFileSync(from, "utf8")) as CorpusAddition[]
	const sources = new Map(manifest.sources.map(source => [source.id, source]))
	const paths = new Set(manifest.files.map(file => file.path))
	const hashes = new Map(manifest.files.map(file => [file.sha256, file.path]))
	const files = [...manifest.files]
	const entries = [...catalogue]

	for (const addition of additions) {
		const source = sources.get(addition.source)

		if (source === undefined) throw new Error(`${addition.path}: unknown source ${addition.source}`)
		if (familyOf(addition.path) === undefined) throw new Error(`${addition.path}: no corpus family for this extension`)
		if (paths.has(addition.path)) throw new Error(`${addition.path}: already in the manifest`)
		if (!addition.url.startsWith("https://")) throw new Error(`${addition.path}: not an https URL: ${addition.url}`)
		// A repository source's files are raw files at its one pinned commit.
		if (source.commit !== undefined && !addition.url.includes(`/${source.commit}/`)) {
			throw new Error(`${addition.path}: not at ${source.id}'s pinned commit: ${addition.url}`)
		}

		const bytes = readFileSync(addition.file)
		const sha256 = createHash("sha256").update(bytes).digest("hex")
		const duplicate = hashes.get(sha256)

		if (duplicate !== undefined) throw new Error(`${addition.path}: the same bytes as ${duplicate}`)

		paths.add(addition.path)
		hashes.set(sha256, addition.path)
		files.push({
			path: addition.path,
			size: bytes.length,
			sha256,
			source: source.id,
			licence: source.licence,
			url: addition.url,
			...(addition.password !== undefined && { password: addition.password }),
			...(addition.modifyPassword !== undefined && { modifyPassword: addition.modifyPassword })
		})
		entries.push({ path: addition.path, ...(compact(addition.catalogue ?? {}) as Record<string, unknown>) })
	}

	files.sort(byPath)
	entries.sort((a, b) => byPath(a as { path: string }, b as { path: string }))
	writeAll({ ...manifest, sources: sortSources(manifest.sources, files), files }, entries)
}

function drop(paths: ReadonlySet<string>): void {
	const { manifest, catalogue } = readCommitted()
	const unknown = [...paths].filter(path => !manifest.files.some(file => file.path === path))

	if (unknown.length > 0) throw new Error(`not in the manifest: ${unknown.join(", ")}`)

	writeAll(
		{ ...manifest, files: manifest.files.filter(file => !paths.has(file.path)) },
		catalogue.filter(entry => typeof entry["path"] !== "string" || !paths.has(entry["path"]))
	)
}

function main(): void {
	const { values } = parseArgs({
		options: { from: { type: "string", default: DEFAULT_FROM }, drop: { type: "string" }, add: { type: "string" } }
	})

	if (values.drop !== undefined) {
		drop(new Set(values.drop.split(",").map(path => path.trim())))

		return
	}

	if (values.add !== undefined) {
		add(values.add)

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
		sources: sortSources([...sources.values()], files),
		files
	}

	writeAll(manifest, catalogue)
}

function fileCount(files: readonly CorpusFile[], id: string): number {
	return files.filter(file => file.source === id).length
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
