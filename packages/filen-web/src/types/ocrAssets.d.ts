// vite/ocr-assets-plugin.ts: the text recognition engine builds and language models, as this build serves them
// (content-hashed, same origin), and the engine builds' glue (bundled by the OCR worker).
declare module "virtual:ocr-assets" {
	export const OCR_ASSETS: import("@filen/office/dom/pdfedit/ocr").OcrAssets
}

declare module "virtual:ocr-engines" {
	export const OCR_ENGINE_FACTORIES: Readonly<
		Record<import("@filen/office/dom/pdfedit/ocr").OcrEngineVariant, import("@filen/office/dom/pdfedit/ocr").TesseractFactory>
	>
}
