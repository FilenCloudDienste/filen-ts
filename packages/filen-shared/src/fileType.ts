// Which type a file is, for its icon and preview, decided in one place for both apps: by a well-known file
// name (a LICENSE or a .gitignore has no extension), then by its extension when the app knows it, then by
// the MIME type stored in its metadata. The result is an EXTENSION, so each app keeps classifying with
// its own extension tables (what it can render differs by platform) and only feeds them this.

// Files whose whole name says what they are, lowercased, to the extension that reads them the same way: names without
// an extension, and names whose extension means something else (`go.mod` is no tracker module). Explicit rather than
// "every dotfile": some dotfiles are binary (.DS_Store).
export const FILE_NAME_TYPES: ReadonlyMap<string, string> = new Map([
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
	...["gemfile", "rakefile", "podfile", "brewfile", "vagrantfile", "fastfile", "guardfile"].map(name => [name, "rb"] as const),
	// Go's module, checksum and workspace files: plain text (no grammar reads them).
	...["go.mod", "go.sum", "go.work"].map(name => [name, "txt"] as const)
])

// Every MIME type ↔ extension pair, one list for both directions. "toExt": the extension a stored MIME type reads as
// (extensionForMime); "fromExt": the canonical MIME type an extension is served as (mimeForExtension); "both": each.
// An alias is "toExt" only, so a MIME type reads as one extension and an extension serves as one type.
export type TypeDirection = "both" | "toExt" | "fromExt"

export type TypeRow = readonly [mime: string, extension: string, direction: TypeDirection]

export const TYPE_ROWS: readonly TypeRow[] = [
	["image/jpeg", "jpg", "both"],
	["image/jpeg", "jpeg", "fromExt"],
	["image/jpeg", "jfif", "fromExt"],
	["image/jpeg", "jpe", "fromExt"],
	["image/jpeg", "pjpeg", "fromExt"],
	["image/jpeg", "pjp", "fromExt"],
	["image/pjpeg", "jpg", "toExt"],
	["image/png", "png", "both"],
	["image/x-png", "png", "toExt"],
	["image/gif", "gif", "both"],
	["image/webp", "webp", "both"],
	["image/svg+xml", "svg", "both"],
	["image/bmp", "bmp", "both"],
	["image/x-icon", "ico", "both"],
	["image/vnd.microsoft.icon", "ico", "toExt"],
	["image/apng", "apng", "both"],
	["image/avif", "avif", "both"],
	["image/heic", "heic", "both"],
	["image/heic-sequence", "heic", "toExt"],
	["image/heif", "heif", "both"],
	["image/heif-sequence", "heif", "toExt"],
	// Fujifilm's name for the same container.
	["image/heif", "hif", "fromExt"],
	["image/tiff", "tiff", "both"],
	["image/tiff", "tif", "fromExt"],
	["image/jxl", "jxl", "both"],
	["image/x-qoi", "qoi", "both"],
	// Gzipped SVG: served (and reversed) as the SVG it inflates to.
	["image/svg+xml", "svgz", "fromExt"],
	["application/illustrator", "ai", "both"],
	["video/mp4", "mp4", "both"],
	["video/webm", "webm", "both"],
	["video/quicktime", "mov", "both"],
	["video/x-matroska", "mkv", "both"],
	["video/x-m4v", "m4v", "both"],
	// Not `.ts`, which TypeScript shares: a transport stream's MIME type is unambiguous.
	["video/mp2t", "m2ts", "both"],
	["video/vnd.dlna.mpeg-tts", "m2ts", "toExt"],
	["video/3gpp", "3gp", "both"],
	["video/3gpp2", "3g2", "both"],
	["audio/mpeg", "mp3", "both"],
	["audio/mp3", "mp3", "toExt"],
	["audio/mp4", "m4a", "both"],
	["audio/mp4", "m4b", "fromExt"],
	["audio/x-m4a", "m4a", "toExt"],
	["audio/x-m4b", "m4b", "toExt"],
	["audio/aac", "aac", "both"],
	["audio/wav", "wav", "both"],
	["audio/wave", "wav", "toExt"],
	["audio/x-wav", "wav", "toExt"],
	["audio/ogg", "ogg", "both"],
	["audio/ogg", "oga", "fromExt"],
	["audio/ogg", "opus", "fromExt"],
	["audio/webm", "weba", "fromExt"],
	["audio/flac", "flac", "both"],
	["audio/x-flac", "flac", "toExt"],
	["audio/opus", "opus", "toExt"],
	["audio/aiff", "aiff", "both"],
	["audio/aiff", "aif", "fromExt"],
	["audio/x-aiff", "aiff", "toExt"],
	["audio/amr", "amr", "both"],
	["audio/x-caf", "caf", "both"],
	["application/zip", "zip", "both"],
	["application/x-zip-compressed", "zip", "toExt"],
	["application/x-7z-compressed", "7z", "both"],
	["application/x-tar", "tar", "both"],
	["application/gzip", "gz", "both"],
	["application/x-gzip", "gz", "toExt"],
	["application/x-bzip2", "bz2", "both"],
	["application/x-xz", "xz", "both"],
	["application/zstd", "zst", "both"],
	["application/java-archive", "jar", "both"],
	["application/vnd.android.package-archive", "apk", "both"],
	["application/x-xpinstall", "xpi", "both"],
	["font/ttf", "ttf", "both"],
	["application/x-font-ttf", "ttf", "toExt"],
	["font/otf", "otf", "both"],
	["font/woff", "woff", "both"],
	["application/font-woff", "woff", "toExt"],
	["font/woff2", "woff2", "both"],
	["application/vnd.sqlite3", "sqlite", "both"],
	["application/x-sqlite3", "sqlite", "toExt"],
	["application/pdf", "pdf", "both"],
	["application/epub+zip", "epub", "both"],
	["application/x-mobipocket-ebook", "mobi", "both"],
	["application/x-fictionbook+xml", "fb2", "both"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx", "both"],
	["application/vnd.ms-word.document.macroenabled.12", "docm", "both"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.template", "dotx", "both"],
	["application/vnd.ms-word.template.macroenabled.12", "dotm", "both"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx", "both"],
	["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm", "both"],
	["application/vnd.ms-excel", "xls", "both"],
	["application/vnd.apple.pages", "pages", "both"],
	["application/vnd.apple.numbers", "numbers", "both"],
	["text/csv", "csv", "both"],
	["text/tab-separated-values", "tsv", "both"],
	["text/markdown", "md", "both"],
	["text/x-markdown", "md", "toExt"],
	["text/plain", "txt", "both"],
	["text/vtt", "vtt", "both"],
	["application/x-subrip", "srt", "both"],
	["text/calendar", "ics", "both"],
	["text/vcard", "vcf", "both"],
	["text/x-vcard", "vcf", "toExt"],
	["message/rfc822", "eml", "both"],
	["application/mbox", "mbox", "both"],
	["application/json", "json", "both"],
	["application/ld+json", "json", "toExt"],
	["application/xml", "xml", "both"],
	["text/xml", "xml", "toExt"],
	["application/javascript", "js", "toExt"],
	["application/x-javascript", "js", "toExt"],
	["text/javascript", "js", "both"],
	["application/typescript", "ts", "both"],
	["text/css", "css", "both"],
	["text/html", "html", "both"],
	["application/x-sh", "sh", "both"],
	["application/x-shellscript", "sh", "toExt"],
	["text/x-shellscript", "sh", "toExt"],
	["application/yaml", "yaml", "both"],
	["application/x-yaml", "yaml", "toExt"],
	["text/yaml", "yaml", "toExt"],
	["text/x-yaml", "yaml", "toExt"],
	["application/toml", "toml", "both"],
	["application/sql", "sql", "both"],
	["text/x-python", "py", "both"],
	["text/x-c", "c", "both"],
	["text/x-c++", "cpp", "both"],
	["text/x-java-source", "java", "both"],
	["text/x-php", "php", "both"],
	["application/x-httpd-php", "php", "toExt"],
	["text/x-go", "go", "both"],
	["text/x-rust", "rs", "both"]
]

// Both directions, built once. Parameters (`; charset=…`) are dropped before a MIME type is looked up.
const MIME_TYPES = new Map<string, string>()
const EXTENSION_TYPES = new Map<string, string>()

for (const [mime, extension, direction] of TYPE_ROWS) {
	if (direction !== "fromExt") {
		MIME_TYPES.set(mime, extension)
	}

	if (direction !== "toExt") {
		EXTENSION_TYPES.set(extension, mime)
	}
}

function baseName(name: string): string {
	const trimmed = name.trim()

	return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase()
}

// The extension a file named exactly so reads as, or null. resolveFileKind asks it before the extension.
export function extensionForExactFileName(name: string): string | null {
	return FILE_NAME_TYPES.get(baseName(name)) ?? null
}

// The extension a well-known file name reads as, or null. `.env.local` and its siblings read like `.env`.
export function extensionForFileName(name: string): string | null {
	const base = baseName(name)

	return FILE_NAME_TYPES.get(base) ?? (base.startsWith(".env.") ? "ini" : null)
}

function mimeEssence(mime: string): string {
	return (mime.split(";")[0] ?? "").trim().toLowerCase()
}

// The extension a stored MIME type reads as, or null. Any other text/* type reads as plain text.
export function extensionForMime(mime: string | null | undefined): string | null {
	if (mime === null || mime === undefined) {
		return null
	}

	const type = mimeEssence(mime)

	return MIME_TYPES.get(type) ?? (type.startsWith("text/") ? "txt" : null)
}

// The MIME type a lowercase, dot-less extension is served as, or null.
export function mimeForExtension(extension: string): string | null {
	return EXTENSION_TYPES.get(extension) ?? null
}

// A stored MIME type's canonical form (`image/vnd.microsoft.icon` → `image/x-icon`), or null when no row names it.
export function canonicalInlineType(mime: string): string | null {
	const extension = MIME_TYPES.get(mimeEssence(mime))

	return extension === undefined ? null : mimeForExtension(extension)
}
