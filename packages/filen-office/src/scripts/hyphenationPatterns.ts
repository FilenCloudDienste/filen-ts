import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { format, resolveConfig } from "prettier"

// Generates assets/hyphenation (one gzip'd pattern file per language and manifest.json) and
// src/core/text/hyphenation/languages.generated.ts from the TeX hyph-utf8 patterns of tex-hyphen at COMMIT. Only
// files whose own licence header grants a permissive licence (MIT, BSD-style, public domain or an all-permissive
// notice, alone or as one choice among others) are bundled; LPPL-only, GPL-only and unlicensed files are not, nor
// Basque's, whose licence asks for a notice inside every modified file (these are reformatted).
// Each asset holds the patterns on its first line and the exceptions on its second, space-separated, as the
// upstream .pat.txt and .hyp.txt files list them. THIRD_PARTY_NOTICES.md records every file and its licence.
//
//   npx tsx src/scripts/hyphenationPatterns.ts

const REPOSITORY = "https://github.com/hyphenation/tex-hyphen"
const COMMIT = "5684c0f51c0b81133db2efbe60a408b4155a3ff5"
const RAW = `https://raw.githubusercontent.com/hyphenation/tex-hyphen/${COMMIT}/hyph-utf8/tex/generic/hyph-utf8/patterns`
const CACHE = fileURLToPath(new URL(`../../node_modules/.cache/filen-office-hyphenation/${COMMIT}/`, import.meta.url))
const ASSETS = fileURLToPath(new URL("../../assets/hyphenation/", import.meta.url))
const OUTPUT = fileURLToPath(new URL("../core/text/hyphenation/languages.generated.ts", import.meta.url))

interface Language {
	// The hyph-utf8 file stem (hyph-<id>.tex).
	readonly id: string
	readonly name: string
	// BCP 47 tags (lower case) that select it: a full tag, or a primary language subtag matching any region.
	readonly tags: readonly string[]
	// The licence bundled under (SPDX), and text its header must contain.
	readonly licence: string
	readonly check: string
}

const MIT_CHECK = "name: MIT"
const ALL_PERMISSIVE = "Copying and distribution of this file, with or without modification"

const LANGUAGES: readonly Language[] = [
	{ id: "af", name: "Afrikaans", tags: ["af"], licence: "MIT", check: MIT_CHECK },
	{ id: "be", name: "Belarusian", tags: ["be"], licence: "MIT", check: MIT_CHECK },
	{
		id: "bg",
		name: "Bulgarian",
		tags: ["bg"],
		licence: "LicenseRef-hyph-bg",
		check: "This software may be used, modified, copied, distributed, and sold"
	},
	{ id: "cy", name: "Welsh", tags: ["cy"], licence: "MIT", check: MIT_CHECK },
	{ id: "da", name: "Danish", tags: ["da"], licence: "MIT", check: MIT_CHECK },
	{ id: "de-1996", name: "German (reformed spelling)", tags: ["de"], licence: "MIT", check: MIT_CHECK },
	{ id: "el-monoton", name: "Greek (monotonic)", tags: ["el"], licence: "MIT", check: MIT_CHECK },
	{
		id: "en-gb",
		name: "English (British)",
		tags: ["en-gb", "en-au", "en-nz", "en-ie", "en-za", "en-in"],
		licence: "MIT",
		check: MIT_CHECK
	},
	{ id: "en-us", name: "English (American)", tags: ["en"], licence: "FSFAP", check: ALL_PERMISSIVE },
	{ id: "es", name: "Spanish", tags: ["es"], licence: "MIT", check: MIT_CHECK },
	{ id: "et", name: "Estonian", tags: ["et"], licence: "MIT", check: MIT_CHECK },
	{ id: "fr", name: "French", tags: ["fr"], licence: "MIT", check: MIT_CHECK },
	{ id: "ga", name: "Irish", tags: ["ga"], licence: "MIT", check: MIT_CHECK },
	{ id: "gl", name: "Galician", tags: ["gl"], licence: "Unlicense", check: "name: Unlicence" },
	{ id: "it", name: "Italian", tags: ["it"], licence: "MIT", check: MIT_CHECK },
	{ id: "ka", name: "Georgian", tags: ["ka"], licence: "MIT", check: MIT_CHECK },
	{ id: "kk", name: "Kazakh", tags: ["kk"], licence: "LicenseRef-Public-Domain", check: "name: Public domain" },
	{ id: "lt", name: "Lithuanian", tags: ["lt"], licence: "MIT", check: MIT_CHECK },
	{ id: "mn-cyrl", name: "Mongolian (Cyrillic)", tags: ["mn"], licence: "MIT", check: MIT_CHECK },
	{ id: "nb", name: "Norwegian Bokmål", tags: ["nb", "no"], licence: "FSFAP", check: ALL_PERMISSIVE },
	{ id: "nl", name: "Dutch", tags: ["nl"], licence: "MIT", check: MIT_CHECK },
	{ id: "nn", name: "Norwegian Nynorsk", tags: ["nn"], licence: "FSFAP", check: ALL_PERMISSIVE },
	{ id: "oc", name: "Occitan", tags: ["oc"], licence: "MIT", check: MIT_CHECK },
	{ id: "pl", name: "Polish", tags: ["pl"], licence: "MIT", check: MIT_CHECK },
	{ id: "pt", name: "Portuguese", tags: ["pt"], licence: "BSD-3-Clause", check: "Redistribution and use in source and binary forms" },
	{ id: "rm", name: "Romansh", tags: ["rm"], licence: "MIT", check: MIT_CHECK },
	{ id: "sk", name: "Slovak", tags: ["sk"], licence: "MIT", check: MIT_CHECK },
	{ id: "sl", name: "Slovenian", tags: ["sl"], licence: "MIT", check: MIT_CHECK },
	{ id: "sq", name: "Albanian", tags: ["sq"], licence: "MIT", check: MIT_CHECK },
	{ id: "tk", name: "Turkmen", tags: ["tk"], licence: "MIT", check: MIT_CHECK },
	{ id: "uk", name: "Ukrainian", tags: ["uk"], licence: "MIT", check: MIT_CHECK }
]

// Files a language's .tex loads its patterns from (nb and nn share Norwegian's), whose header holds the licence.
const LICENCE_FILE: Readonly<Record<string, string>> = { nb: "no", nn: "no" }

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex")
}

async function fetchText(path: string, optional = false): Promise<{ url: string; text: string; sha256: string } | undefined> {
	const url = `${RAW}/${path}`
	const cached = `${CACHE}${path.replaceAll("/", "_")}`

	if (!existsSync(cached)) {
		const response = await fetch(url)

		if (response.status === 404 && optional) return undefined
		if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)

		mkdirSync(CACHE, { recursive: true })
		writeFileSync(cached, new Uint8Array(await response.arrayBuffer()))
	}

	const bytes = readFileSync(cached)

	return { url, text: bytes.toString("utf8"), sha256: sha256(bytes) }
}

// The header's "key:" block (YAML in TeX comments) as written, without the comment markers.
function headerBlock(tex: string, key: string): string {
	const lines = tex.split("\n")
	const start = lines.findIndex(line => line.startsWith(`% ${key}:`))

	if (start < 0) return ""

	const out = [lines[start]?.slice(2) ?? ""]

	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? ""

		if (!line.startsWith("%") || /^% [a-z_]+:/.test(line) || /^% ?=+/.test(line)) break

		out.push(line.slice(2))
	}

	return out.join("\n").trimEnd()
}

function hyphenmin(tex: string, side: "left" | "right"): number {
	// The typesetting values (some files also give those the patterns were generated with).
	const block = headerBlock(tex, "hyphenmins")
	const typesetting = block.slice(Math.max(0, block.indexOf("typesetting:")))
	const match = new RegExp(`${side}:\\s+(\\d+)`).exec(typesetting)

	if (match === null) throw new Error(`no ${side} hyphenmin`)

	return Number(match[1])
}

function words(text: string): string[] {
	return text.split(/\s+/).filter(word => word.length > 0 && !word.startsWith("%"))
}

const records = []

mkdirSync(ASSETS, { recursive: true })

for (const language of LANGUAGES) {
	const tex = await fetchText(`tex/hyph-${language.id}.tex`)
	const licenceSource = LICENCE_FILE[language.id]
	const licenceTex = licenceSource === undefined ? tex : await fetchText(`tex/hyph-${licenceSource}.tex`)
	const patterns = await fetchText(`txt/hyph-${language.id}.pat.txt`)
	const exceptions = await fetchText(`txt/hyph-${language.id}.hyp.txt`, true)

	if (tex === undefined || licenceTex === undefined || patterns === undefined) throw new Error(`${language.id}: missing files`)

	const licenceBlock = headerBlock(licenceTex.text, "licence")

	if (!licenceBlock.includes(language.check)) throw new Error(`${language.id}: the licence header does not grant ${language.licence}`)

	const copyright = headerBlock(licenceTex.text, "copyright")
		.replace(/^copyright: >?\s*/, "")
		.replace(/\s*\n\s*/g, " ")
		.trim()
	const extra =
		licenceSource === undefined
			? ""
			: headerBlock(tex.text, "copyright")
					.replace(/^copyright: >?\s*/, "")
					.trim()
	const body = `${words(patterns.text).join(" ")}\n${exceptions === undefined ? "" : words(exceptions.text).join(" ")}\n`
	const raw = Buffer.from(body, "utf8")
	const gzipped = gzipSync(raw, { level: 9 })
	const file = `hyph-${language.id}.txt.gz`

	writeFileSync(`${ASSETS}${file}`, gzipped)

	records.push({
		id: language.id,
		name: language.name,
		tags: language.tags,
		file,
		bytes: gzipped.length,
		sha256: sha256(gzipped),
		size: raw.length,
		left: hyphenmin(tex.text, "left"),
		right: hyphenmin(tex.text, "right"),
		licence: language.licence,
		copyright: extra.length > 0 && extra !== copyright ? `${copyright}; ${extra}` : copyright,
		licenceText: licenceBlock,
		upstream: {
			tex: { url: tex.url, sha256: tex.sha256 },
			...(licenceTex === tex ? {} : { licence: { url: licenceTex.url, sha256: licenceTex.sha256 } }),
			patterns: { url: patterns.url, sha256: patterns.sha256 },
			...(exceptions === undefined ? {} : { exceptions: { url: exceptions.url, sha256: exceptions.sha256 } })
		}
	})
}

const manifest = {
	comment:
		"Hyphenation patterns from hyph-utf8, one gzip'd UTF-8 file per language: the patterns space-separated on the first line, the exceptions (hyphens marking breaks) on the second. Regenerated with src/scripts/hyphenationPatterns.ts, which also writes src/core/text/hyphenation/languages.generated.ts. licenceText is the licence block of each pattern file's own header, verbatim.",
	source: REPOSITORY,
	commit: COMMIT,
	languages: records
}

writeFileSync(`${ASSETS}manifest.json`, `${JSON.stringify(manifest, null, "\t")}\n`)

const table = records.map(record => ({ file: record.file, size: record.size, left: record.left, right: record.right }))
const tags = Object.fromEntries(
	records.flatMap((record, index) => record.tags.map(tag => [tag, index])).sort(([a], [b]) => String(a).localeCompare(String(b)))
)
const source = `// Generated by src/scripts/hyphenationPatterns.ts from assets/hyphenation/manifest.json (hyph-utf8, ${REPOSITORY} at ${COMMIT}). Do not edit.

// A bundled pattern set: its file under assets/hyphenation, its size inflated, and the fewest characters it leaves
// before and after a break (the patterns' own hyphenmins).
export interface HyphenationLanguage {
	readonly file: string
	readonly size: number
	readonly left: number
	readonly right: number
}

export const HYPHENATION_LANGUAGES: readonly HyphenationLanguage[] = ${JSON.stringify(table)}

// Lower-case BCP 47 tags (a full tag, or a primary language subtag for any other region) to their pattern set.
export const HYPHENATION_TAGS: Readonly<Record<string, number>> = ${JSON.stringify(tags)}
`

writeFileSync(OUTPUT, await format(source, { ...(await resolveConfig(OUTPUT)), filepath: OUTPUT }))
console.log(`${records.length} languages, ${records.reduce((sum, record) => sum + record.bytes, 0)} bytes`)
