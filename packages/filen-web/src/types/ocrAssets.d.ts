// vite/ocr-assets-plugin.ts: the text recognition engine builds and language models, as this build serves them
// (content-hashed, same origin), and each engine build's glue (bundled by that build's OCR worker).
declare module "virtual:ocr-assets" {
	export const OCR_ASSETS: import("@filen/office/dom/pdfedit/ocr").OcrAssets
}

declare module "virtual:ocr-engine/*" {
	export const OCR_ENGINE_FACTORY: import("@filen/office/dom/pdfedit/ocr").TesseractFactory
}
