// vite/pdfjs-assets-plugin.ts: the directories pdf.js fetches its character maps, standard fonts, image decoders and
// ICC profile from (same origin, versioned).
declare module "virtual:pdfjs-assets" {
	export const PDFJS_ASSETS: {
		readonly cMapUrl: string
		readonly standardFontDataUrl: string
		readonly wasmUrl: string
		readonly iccUrl: string
	}
}
