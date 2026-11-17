// Whether a document is tagged (has a structure tree), and each page's tree, read once. A document is tagged when its
// first page asked has a tree (not by MarkInfo, which tagged files often lack): an untagged document pays that one
// round trip, and none of its pages streams marked content or asks again. A page's tree is kept with the page object,
// so a page coming back into view never asks the worker (or reads its struct elements) again.

const taggedDocuments = new WeakMap<object, Promise<boolean>>()
const pageTrees = new WeakMap<object, Promise<unknown>>()
const documentPrefixes = new WeakMap<object, string>()
let nextPrefix = 0

export interface StructTreePage {
	getStructTree?(): Promise<unknown>
}

// The page's structure tree, or null (an untagged document, an engine without trees, or a read that failed).
export function pageStructTree(document: object, page: StructTreePage): Promise<unknown> {
	const read = page.getStructTree

	if (read === undefined) return Promise.resolve(null)

	const cached = pageTrees.get(page)

	if (cached !== undefined) return cached

	const known = taggedDocuments.get(document)
	let tree: Promise<unknown>

	if (known === undefined) {
		tree = read.call(page).catch(() => null)
		taggedDocuments.set(
			document,
			tree.then(found => found !== null)
		)
	} else tree = known.then(tagged => (tagged ? read.call(page).catch(() => null) : null))

	pageTrees.set(page, tree)

	return tree
}

// The document's id prefix, so two documents in the DOM never share an id.
export function documentStructPrefix(document: object): string {
	let prefix = documentPrefixes.get(document)

	if (prefix === undefined) {
		prefix = `fo-pdf-${String(nextPrefix++)}-`
		documentPrefixes.set(document, prefix)
	}

	return prefix
}
