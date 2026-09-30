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

// Index of the dot that starts `name`'s extension, or -1 when it has none: a leading dot (a dotfile) or
// a trailing one is not an extension. Returns an index so hot callers slice only what they need.
export function extensionStart(name: string): number {
	const dot = name.lastIndexOf(".")

	return dot > 0 && dot < name.length - 1 ? dot : -1
}
