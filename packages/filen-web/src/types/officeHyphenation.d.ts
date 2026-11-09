// vite/office-hyphenation-plugin.ts: each hyphenation pattern file's URL by its path under @filen/office's
// assets/hyphenation.
declare module "virtual:office-hyphenation" {
	export const OFFICE_HYPHENATION_URLS: Readonly<Record<string, string>>
}
