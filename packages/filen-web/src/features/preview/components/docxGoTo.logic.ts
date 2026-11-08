import { typedPage } from "@/features/preview/components/commandBar.logic"

// The editor's page in view and page count for the status bar's Page X of Y, and whether Go To is open (Ctrl+G or
// the indicator). Read with useSyncExternalStore by the indicator alone, so scrolling to another page re-renders
// only it, never the ribbon.

export interface DocxPagePosition {
	// Index of the page in view.
	readonly page: number
	readonly count: number
	readonly goTo: boolean
}

export interface DocxPageStore {
	readonly get: () => DocxPagePosition
	readonly subscribe: (listener: () => void) => () => void
	readonly setPage: (page: number, count: number) => void
	readonly setGoTo: (open: boolean) => void
}

export function createDocxPageStore(): DocxPageStore {
	let current: DocxPagePosition = { page: 0, count: 0, goTo: false }
	const listeners = new Set<() => void>()
	const update = (next: DocxPagePosition): void => {
		current = next

		for (const listener of listeners) {
			listener()
		}
	}

	return {
		get: () => current,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		setPage: (page, count) => {
			if (page !== current.page || count !== current.count) {
				update({ ...current, page, count })
			}
		},
		setGoTo: open => {
			if (open !== current.goTo) {
				update({ ...current, goTo: open })
			}
		}
	}
}

// The page index a typed page number goes to (clamped to the document), or null for no number.
export function goToPageIndex(text: string, count: number): number | null {
	const page = typedPage(text, count)

	return page === null ? null : page - 1
}
