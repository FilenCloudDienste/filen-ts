import { extensionStart } from "./fileExtensions"

// Which type a file is, for its icon and preview, decided in one place for both apps: by its extension
// when the app knows it, then by a well-known file name (a LICENSE or a .gitignore has no extension), then
// by the MIME type stored in its metadata. The result is an EXTENSION, so each app keeps classifying with
// its own extension tables (what it can render differs by platform) and only feeds them this.

// Files that carry no extension but whose name says what they are, lowercased, to the extension that reads
// them the same way. Explicit rather than "every dotfile": some dotfiles are binary (.DS_Store).
const FILE_NAME_TYPES: ReadonlyMap<string, string> = new Map([
	...["license", "licence", "copying", "readme", "changelog", "changes", "authors", "contributors", "notice", "todo", "history"].map(
		name => [name, "txt"] as const
	),
	...["install", "news", "thanks", "patents", "codeowners", "procfile", "jenkinsfile"].map(name => [name, "txt"] as const),
	...[".gitignore", ".gitattributes", ".gitmodules", ".gitkeep", ".dockerignore", ".npmignore", ".prettierignore", ".eslintignore"].map(
		name => [name, "txt"] as const
	),
	...[".mailmap", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions"].map(name => [name, "txt"] as const),
	...[".editorconfig", ".npmrc", ".yarnrc", ".gitconfig", ".pypirc", ".env"].map(name => [name, "ini"] as const),
	...[".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv", ".profile", ".envrc"].map(
		name => [name, "sh"] as const
	),
	...[".prettierrc", ".eslintrc", ".babelrc", ".swcrc"].map(name => [name, "json"] as const),
	[".htaccess", "conf"],
	["makefile", "makefile"],
	["gnumakefile", "makefile"],
	["dockerfile", "dockerfile"],
	["containerfile", "dockerfile"],
	...["gemfile", "rakefile", "podfile", "brewfile", "vagrantfile", "fastfile", "guardfile"].map(name => [name, "rb"] as const)
])

// MIME types to the extension that reads them. Parameters (`; charset=…`) are dropped before the lookup.
const MIME_TYPES: ReadonlyMap<string, string> = new Map([
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/x-icon", "ico"],
	["image/vnd.microsoft.icon", "ico"],
	["image/apng", "apng"],
	["image/avif", "avif"],
	["image/heic", "heic"],
	["image/heic-sequence", "heic"],
	["image/heif", "heif"],
	["image/heif-sequence", "heif"],
	["image/tiff", "tiff"],
	["video/mp4", "mp4"],
	["video/webm", "webm"],
	["video/quicktime", "mov"],
	["video/x-matroska", "mkv"],
	["video/x-m4v", "m4v"],
	["video/3gpp", "3gp"],
	["video/3gpp2", "3g2"],
	["audio/mpeg", "mp3"],
	["audio/mp3", "mp3"],
	["audio/mp4", "m4a"],
	["audio/x-m4a", "m4a"],
	["audio/aac", "aac"],
	["audio/wav", "wav"],
	["audio/wave", "wav"],
	["audio/x-wav", "wav"],
	["audio/ogg", "ogg"],
	["audio/flac", "flac"],
	["audio/x-flac", "flac"],
	["audio/opus", "opus"],
	["audio/aiff", "aiff"],
	["audio/x-aiff", "aiff"],
	["audio/amr", "amr"],
	["audio/x-caf", "caf"],
	["application/pdf", "pdf"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
	["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
	["application/vnd.ms-excel", "xls"],
	["text/csv", "csv"],
	["text/tab-separated-values", "tsv"],
	["text/markdown", "md"],
	["text/x-markdown", "md"],
	["text/plain", "txt"],
	["application/json", "json"],
	["application/ld+json", "json"],
	["application/xml", "xml"],
	["text/xml", "xml"],
	["application/javascript", "js"],
	["application/x-javascript", "js"],
	["text/javascript", "js"],
	["application/typescript", "ts"],
	["text/css", "css"],
	["text/html", "html"],
	["application/x-sh", "sh"],
	["application/x-shellscript", "sh"],
	["text/x-shellscript", "sh"],
	["application/yaml", "yaml"],
	["application/x-yaml", "yaml"],
	["text/yaml", "yaml"],
	["text/x-yaml", "yaml"],
	["application/toml", "toml"],
	["application/sql", "sql"],
	["text/x-python", "py"],
	["text/x-c", "c"],
	["text/x-c++", "cpp"],
	["text/x-java-source", "java"],
	["text/x-php", "php"],
	["application/x-httpd-php", "php"],
	["text/x-go", "go"],
	["text/x-rust", "rs"]
])

function baseName(name: string): string {
	const trimmed = name.trim()

	return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase()
}

// The extension a well-known file name reads as, or null. `.env.local` and its siblings read like `.env`.
export function extensionForFileName(name: string): string | null {
	const base = baseName(name)

	return FILE_NAME_TYPES.get(base) ?? (base.startsWith(".env.") ? "ini" : null)
}

// The extension a stored MIME type reads as, or null. Any other text/* type reads as plain text.
export function extensionForMime(mime: string | null | undefined): string | null {
	if (mime === null || mime === undefined) {
		return null
	}

	const type = (mime.split(";")[0] ?? "").trim().toLowerCase()

	return MIME_TYPES.get(type) ?? (type.startsWith("text/") ? "txt" : null)
}

// The extension a file is classified by: its own when `isKnownExtension` (the app's own tables) says so,
// else its well-known name's, else its MIME type's — only when the app knows that one too — else its own
// unrecognised extension ("" when it has none), which classifies as unknown just as before.
export function effectiveExtension(name: string, mime: string | null | undefined, isKnownExtension: (extension: string) => boolean): string {
	const base = baseName(name)
	const dot = extensionStart(base)
	const own = dot === -1 ? "" : base.slice(dot + 1)

	if (own !== "" && isKnownExtension(own)) {
		return own
	}

	const byName = extensionForFileName(base)

	if (byName !== null) {
		return byName
	}

	const byMime = extensionForMime(mime)

	return byMime !== null && isKnownExtension(byMime) ? byMime : own
}
