import { PDF_MAX_CANVAS_AREA_BYTES, PDF_MAX_IMAGE_SIZE, PDF_RANGE_CHUNK_SIZE } from "@/components/pdfPreview/constants"

/**
 * The `getDocument` parameters, built in one place so the security-critical values are assertable in
 * a unit test rather than reviewed by eye in a large component.
 *
 * Every entry is deliberate. The ones that matter most:
 *
 * - `useWorkerFetch: false` is PINNED, never left to inference. pdf.js decides this by asking whether
 *   its asset URLs look fetchable, which is true under Metro (http) and false in a release build
 *   (file://). That single auto-detection is what makes a naive integration work perfectly in
 *   development and fail completely in production.
 * - `useSystemFonts: false` forces the bundled standard fonts. Left on, pdf.js satisfies the base-14
 *   fonts from the platform's own fonts — which differ between iOS and Android, so the same document
 *   would lay out differently on each. Identical rendering is the reason this viewer exists.
 * - `disableStream` and `disableAutoFetch` must be set TOGETHER; either alone is a no-op.
 * - `enableXfa: false` keeps XFA — a whole second, scriptable form engine — switched off.
 * - No `docBaseUrl`: it can be overridden from the document's own catalog, and it is what relative
 *   URLs inside a document resolve against.
 * - No `password`: passwords arrive through `onPassword`, so they never sit in the options object.
 *
 * `enableScripting` is absent on purpose and must stay absent. It is not a `getDocument` parameter at
 * all — it belongs to the annotation layer, whose own default is opt-in — and naming it here would
 * imply this is where that decision lives.
 *
 * `isEvalSupported` is likewise absent, and NOT an oversight: it no longer exists in this major
 * version. Every eval path was removed upstream, so passing it would assert a protection that is not
 * actually being applied — worse than not passing it, because a reader would stop looking.
 */
export function buildPdfDocumentOptions({
	binaryDataFactory,
	range
}: {
	binaryDataFactory: unknown
	range: unknown
}): Record<string, unknown> {
	return {
		range,
		rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
		useWorkerFetch: false,
		useSystemFonts: false,
		BinaryDataFactory: binaryDataFactory,
		disableStream: true,
		disableAutoFetch: true,
		maxImageSize: PDF_MAX_IMAGE_SIZE,
		canvasMaxAreaInBytes: PDF_MAX_CANVAS_AREA_BYTES,
		enableXfa: false,
		// VerbosityLevel.ERRORS. A literal rather than the enum so this module stays free of pdfjs
		// imports and testable in node.
		verbosity: 0
	}
}
