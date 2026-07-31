import { Platform } from "react-native"

/**
 * Largest document the viewer will open.
 *
 * Lower than the PDF ceiling for the same file size, because a .docx costs more than its bytes:
 * it is a zip, so it is decompressed in full before anything renders, docx-preview builds a complete
 * DOM for the document rather than one page at a time, and every embedded image is inlined as a
 * `data:` URL (`useBase64URL`) at 4/3 of its decompressed size. The file on disk is the smallest
 * number in that chain.
 *
 * Android is lower again because the WebView renderer is a separate, more readily reclaimed process,
 * and losing it mid-document loses the document. Both numbers are judgement calls informed by the
 * mechanism, not measurements; revisit with field data rather than treating them as derived.
 */
export const MAX_DOCX_BYTES = Platform.OS === "ios" ? 100 * 1024 * 1024 : 50 * 1024 * 1024
