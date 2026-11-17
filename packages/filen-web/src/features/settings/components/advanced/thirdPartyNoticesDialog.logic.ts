import { webUrl } from "@/lib/safeUrl"

// A notice's repository string is copied verbatim out of the dependency's own manifest, so the shipped
// payload carries plain https URLs next to git:/ssh:/git+https: ones and npm's bare "owner/repo"
// shorthand. Only a value the browser can actually open becomes an anchor; everything else renders as
// plain text, which is both the honest presentation and the reason this never has to trust a manifest
// with what goes into an href.
export function noticeRepositoryHref(repository: string | null): string | null {
	return repository !== null && webUrl(repository) !== null ? repository : null
}

// A notice whose license file came with no copyright line (stb-vorbis's Apache-2.0 LICENSE, for one) says so rather
// than show the text with nothing above it, as if a line had been lost.
export function noticeLacksCopyright(notice: { copyright: readonly string[]; texts: readonly number[] }): boolean {
	return notice.copyright.length === 0 && notice.texts.length > 0
}
