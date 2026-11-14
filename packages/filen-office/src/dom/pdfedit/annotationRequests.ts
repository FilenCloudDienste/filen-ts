import type { PdfAttachmentInfo } from "../../core/pdfedit/annotations"
import {
	listAnnotationAttachments,
	listAnnotations,
	listDocumentAttachments,
	PdfAnnotationError,
	readAttachment,
	readCommentThreads,
	withPageScope
} from "./annotations/index"
import { PdfEngineRefusal, type PdfEngineContext } from "./context"
import type { PdfRequestHandler } from "./requests"

// The annotation tools' reads (any role; nothing changes the document): a page's annotations for the select tool and
// the popover, the comment threads for the Comments panel, and the attachments, handed out only as bytes to download.

type AnnotationOp = "annotations" | "comments" | "attachments" | "attachment"

type Handlers = { readonly [K in AnnotationOp]: PdfRequestHandler<K> }

// Most pages one read takes (the pages in view and around them).
const MAX_PAGES = 64

function pagesOf(context: PdfEngineContext, pages: readonly number[]): number[] {
	const count = context.open().document.countPages()

	if (pages.length > MAX_PAGES) throw new PdfEngineRefusal("badRequest", "too many pages")

	return [...new Set(pages)].filter(page => Number.isInteger(page) && page >= 0 && page < count)
}

export const ANNOTATION_REQUESTS: Handlers = {
	annotations: (context, { pages }) => {
		const { document } = context.open()

		return {
			value: pagesOf(context, pages).map(page => ({
				page,
				annotations: withPageScope(document, () => listAnnotations(document, page))
			}))
		}
	},
	comments: (context, { pages }) => {
		const { document } = context.open()

		const wanted = pages === undefined ? Array.from({ length: document.countPages() }, (_, page) => page) : pagesOf(context, pages)

		// Page by page, each closed before the next (a long document's pages never all open at once).
		return { value: wanted.flatMap(page => withPageScope(document, () => readCommentThreads(document, [page]))) }
	},
	attachments: context => {
		const { document } = context.open()
		const out: PdfAttachmentInfo[] = listDocumentAttachments(document)

		for (let page = 0; page < document.countPages(); page++)
			out.push(...withPageScope(document, () => listAnnotationAttachments(document, page)))

		return { value: out }
	},
	attachment: (context, { source }) => {
		const { document } = context.open()
		let bytes: Uint8Array | null

		try {
			bytes = withPageScope(document, () => readAttachment(document, source))
		} catch (error) {
			if (error instanceof PdfAnnotationError) throw new PdfEngineRefusal("badRequest", error.message)

			throw error
		}

		return bytes === null ? { value: null } : { value: bytes, transfer: [bytes.buffer] }
	}
}
