// vite/office-fonts-plugin.ts: each bundled font's URL by its path under @filen/office's assets/fonts.
declare module "virtual:office-fonts" {
	export const OFFICE_FONT_URLS: Readonly<Record<string, string>>
}

// vite/office-fonts-plugin.ts: each gzip'd TrueType face PDF export embeds, by its path under assets/fonts.
declare module "virtual:office-pdf-fonts" {
	export const OFFICE_PDF_FONT_URLS: Readonly<Record<string, string>>
}

// vite/office-fonts-plugin.ts: the PDF signature dialog's handwriting faces, in the manifest's order, each with the
// unicode-range of its cmap.
declare module "virtual:office-signature-fonts" {
	export const OFFICE_SIGNATURE_FONTS: readonly { readonly id: string; readonly url: string; readonly unicodeRange: string }[]
}
