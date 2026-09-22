// Lowercase, dot-less source-code extensions that route a preview to a syntax-highlighted "code"
// viewer rather than plain text/markdown — the verified intersection of both apps' independently
// hand-maintained lists (mobile's previewType.ts "code" switch-arm minus {md, markdown, log}, which
// web's own preview.logic.ts list already equals byte-for-byte). Each app composes its own superset
// on top for its own semantics: mobile bundles {md, markdown, log} back in (its single "code" preview
// category has no separate markdown/text split), web's icon classifier bundles {md, markdown, log} in
// too (its file-type ICON reads as code even where its PREVIEW category splits markdown/text out).
export const CODE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	"js",
	"cjs",
	"mjs",
	"jsx",
	"tsx",
	"ts",
	"cpp",
	"c",
	"php",
	"htm",
	"html5",
	"html",
	"css",
	"css3",
	"coffee",
	"litcoffee",
	"sass",
	"xml",
	"json",
	"sql",
	"java",
	"kt",
	"swift",
	"py3",
	"py",
	"cmake",
	"cs",
	"dart",
	"dockerfile",
	"go",
	"less",
	"yaml",
	"vue",
	"svelte",
	"vbs",
	"cobol",
	"toml",
	"conf",
	"ini",
	"makefile",
	"mk",
	"gradle",
	"lua",
	"h",
	"hpp",
	"rs",
	"sh",
	"rb",
	"ps1",
	"bat",
	"ps",
	"protobuf",
	"proto"
])

// Mobile's HEIC/HEIF + multi-image burst-variant extensions (lowercase, dot-less) — the set its
// convert-on-upload gate passes to isHeicFileName below. Web keeps its own narrower two-entry set
// web-local (preview.logic.ts); widening it to this set is a product decision outside this module.
export const HEIC_EXTENSIONS_UPLOAD: ReadonlySet<string> = new Set(["heic", "heif", "heics", "heifs"])

// Whether a BARE file name — no path, no query or fragment; the caller truncates a URI before calling
// — ends in one of `extensions`. Lowercases the name and looks up everything after its last ".".
export function isHeicFileName(bareName: string, extensions: ReadonlySet<string>): boolean {
	const lower = bareName.toLowerCase()

	return extensions.has(lower.slice(lower.lastIndexOf(".") + 1))
}
