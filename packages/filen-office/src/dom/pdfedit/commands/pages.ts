import { PdfEngineRefusal } from "../context"
import {
	deletePages,
	duplicatePages,
	insertBlankPages,
	insertImagePage,
	insertPagesFrom,
	PageOpError,
	reorderPages,
	rotatePages,
	type PageOpResult
} from "../pages/index"
import { pageSource, sourceBytes } from "../pages/sources"
import { isIndex, isRecord, type PdfCommandContext, type PdfCommandTable } from "./types"

// Page organisation: move, rotate, delete, duplicate and insert (a blank page, a picture, pages of a second document
// the engine holds open). Each is one journal operation over the pages block (pages/organise.ts). A command reports
// every page whose place or look changed, so the page column and the thumbnails draw exactly those again.

// The most pages one command names, and the largest picture it takes (bytes, before decoding).
const MAX_PAGES = 100_000
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_BLANK = 100

export interface PdfPageCommands {
	// Every old page index once, in the new order.
	"pages.move": { readonly order: readonly number[] }
	"pages.rotate": { readonly pages: readonly number[]; readonly degrees: 90 | -90 | 180 }
	// At least one page stays.
	"pages.delete": { readonly pages: readonly number[] }
	"pages.duplicate": { readonly pages: readonly number[] }
	// Before page `at` (0..pageCount).
	"pages.insertBlank": { readonly at: number; readonly count: number }
	"pages.insertImage": { readonly at: number; readonly bytes: Uint8Array }
	// Pages (0-based) of a second document opened with attachSource.
	"pages.insertFrom": { readonly at: number; readonly source: number; readonly pages: readonly number[] }
}

function isPageList(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_PAGES && value.every(isIndex)
}

function pageList(args: unknown, key: string): readonly number[] | null {
	if (!isRecord(args)) return null

	const pages = args[key]

	return isPageList(pages) ? pages : null
}

function existing(context: PdfCommandContext, pages: readonly number[]): readonly number[] {
	const count = context.document.countPages()

	if (pages.some(page => page >= count)) throw new PdfEngineRefusal("badRequest", "no such page")

	return pages
}

// The pages whose place changed (each position now showing another page than before, or a new one) and those the
// operation drew anew.
export function changedPages(result: PageOpResult): number[] {
	const pages = new Set(result.touched)

	result.from.forEach((old, index) => {
		if (old !== index) pages.add(index)
	})

	return [...pages].sort((a, b) => a - b)
}

// A refusal of the pages block as the engine's.
function run(operation: () => PageOpResult): number[] {
	try {
		return changedPages(operation())
	} catch (error) {
		if (error instanceof PageOpError) throw new PdfEngineRefusal("badRequest", error.reason)

		throw error
	}
}

export const PAGE_COMMANDS: PdfCommandTable<PdfPageCommands> = {
	"pages.move": {
		tool: "pages",
		parse: args => {
			const order = pageList(args, "order")

			return order === null ? null : { order }
		},
		run: (context, { order }) => run(() => reorderPages(context.document, order))
	},
	"pages.rotate": {
		tool: "pages",
		parse: args => {
			const pages = pageList(args, "pages")
			const degrees = isRecord(args) ? args["degrees"] : undefined

			return pages !== null && (degrees === 90 || degrees === -90 || degrees === 180) ? { pages, degrees } : null
		},
		run: (context, { pages, degrees }) => run(() => rotatePages(context.document, existing(context, pages), degrees))
	},
	"pages.delete": {
		tool: "pages",
		// The deleted pages stay in the file's earlier versions.
		removesContent: true,
		parse: args => {
			const pages = pageList(args, "pages")

			return pages === null ? null : { pages }
		},
		run: (context, { pages }) => run(() => deletePages(context.document, existing(context, pages)))
	},
	"pages.duplicate": {
		tool: "pages",
		parse: args => {
			const pages = pageList(args, "pages")

			return pages === null ? null : { pages }
		},
		run: (context, { pages }) => run(() => duplicatePages(context.document, existing(context, pages)))
	},
	"pages.insertBlank": {
		tool: "pages",
		parse: args => {
			if (!isRecord(args)) return null

			const { at, count } = args

			return isIndex(at) && isIndex(count) && count >= 1 && count <= MAX_BLANK ? { at, count } : null
		},
		run: (context, { at, count }) => run(() => insertBlankPages(context.document, at, count))
	},
	"pages.insertImage": {
		tool: "pages",
		parse: args => {
			if (!isRecord(args)) return null

			const { at, bytes } = args

			return isIndex(at) && bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES ? { at, bytes } : null
		},
		bytes: ({ bytes }) => bytes.length,
		run: (context, { at, bytes }) => run(() => insertImagePage(context.mupdf, context.document, bytes, at))
	},
	"pages.insertFrom": {
		tool: "pages",
		parse: args => {
			if (!isRecord(args)) return null

			const { at, source } = args
			const pages = pageList(args, "pages")

			return isIndex(at) && isIndex(source) && pages !== null ? { at, source, pages } : null
		},
		// The pages' file at most (a second insertion from it copies its objects again).
		bytes: ({ source }, mupdf) => sourceBytes(mupdf, source),
		run: (context, { at, source, pages }) => {
			const document = pageSource(context.mupdf, source)

			if (document === null) throw new PdfEngineRefusal("badRequest", "no such source document")

			return run(() => insertPagesFrom(context.document, document, pages, at))
		}
	}
}
