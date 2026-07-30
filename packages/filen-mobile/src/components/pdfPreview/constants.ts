import { Platform } from "react-native"

/**
 * Largest document the viewer will open.
 *
 * pdf.js reserves a buffer the length of the whole file and, at open, walks the page tree to the LAST
 * page — which for a document whose page dictionaries are scattered through the file (the common
 * layout) pulls roughly one chunk per page. So the honest worst case is "opening reads and retains
 * the entire file", and nothing in the configuration changes that. Refusing above a threshold is the
 * memory protection, not an optimisation.
 *
 * Android is lower because the WebView renderer is a separate, more readily reclaimed process, and
 * losing it mid-document loses the document. Both numbers are judgement calls informed by device
 * measurement (~13.5 MB/s across the bridge, heap tracking roughly file size plus overhead); revisit
 * with field data rather than treating them as derived.
 */
export const MAX_PDF_BYTES = Platform.OS === "ios" ? 150 * 1024 * 1024 : 75 * 1024 * 1024

/**
 * Bytes pdf.js requests per range. Larger than its 64 KiB default: every request is a bridge round
 * trip with a base64 encode/decode on each side, so fewer, bigger reads win.
 */
export const PDF_RANGE_CHUNK_SIZE = 256 * 1024

/**
 * Hard ceiling on a single range read. The reader is a WebView-callable RPC, so it needs a bound that
 * does not depend on the caller behaving.
 */
export const PDF_MAX_RANGE_LENGTH = 2 * 1024 * 1024

/**
 * Total bytes one document may pull before the reader refuses. Reads are synchronous on the JS
 * thread, so an unbounded caller stalls the whole app rather than just the WebView. Four times the
 * file length leaves room for pdf.js to re-read regions it has evicted while still bounding abuse.
 */
export const PDF_CUMULATIVE_READ_FACTOR = 4

/**
 * Matches the zoom ceiling the native viewer shipped, so the gesture feels the same as before.
 */
export const PDF_MAX_ZOOM = 6

/**
 * Largest single image pdf.js will decode, in PIXELS — not bytes. pdf.js drops any image above this
 * outright, leaving a blank space where it was.
 *
 * Sized for real scans rather than for a memory budget, because it cannot serve as one: the limit
 * counts pixels while the cost depends on bit depth, so a 16 MP cap would refuse a 600 dpi bilevel
 * fax scan costing about 4 MB while happily decoding a 16 MP colour image costing 64 MB. Bounding the
 * wrong quantity produced blank pages on exactly the scanned documents people store.
 *
 * 80 MP covers a 600 dpi A3 page (≈70 MP) and everything smaller, including the 600 dpi A4 scans that
 * a 16 MP cap silently blanked. A full-page 1200 dpi scan (≈139 MP) is still refused. The actual
 * memory bounds are the file-size gate above and the isolated WebView renderer, not this number.
 */
export const PDF_MAX_IMAGE_SIZE = 80 * 1000 * 1000

/**
 * Ceiling on the backing store of any canvas pdf.js allocates internally, in bytes.
 *
 * This happens to match pdf.js's current internal default, which is exactly why it is pinned: an
 * unannounced change to that default would silently remove the only in-options bound on canvas
 * allocation, and nothing would fail loudly enough to notice.
 */
export const PDF_MAX_CANVAS_AREA_BYTES = 256 * 1024 * 1024

/**
 * Ceiling on the backing store of the canvases this viewer allocates itself, in bytes (4 bytes per
 * pixel). The option above only governs pdf.js's own canvases, not ours.
 */
export const PDF_MAX_PAGE_CANVAS_BYTES = 64 * 1024 * 1024
