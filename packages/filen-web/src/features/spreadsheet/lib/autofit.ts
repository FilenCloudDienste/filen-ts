import type { SizeAxis } from "@/features/spreadsheet/lib/sizes.logic"

// The laid-out size of each rendered, unmerged cell's content in one column or row: what autofit fits.
// Reads the text's own box (a Range), so a stretched or truncated span still reports its content.
export function measureContents(root: HTMLElement, axis: SizeAxis, index: number): number[] {
	const selector =
		axis === "cols"
			? `[role="gridcell"][aria-colindex="${String(index + 2)}"]:not([data-merged]) > span`
			: `[role="row"][aria-rowindex="${String(index + 2)}"] [role="gridcell"]:not([data-merged]) > span`
	const range = document.createRange()
	const sizes: number[] = []

	for (const span of root.querySelectorAll<HTMLElement>(selector)) {
		if (span.textContent === "") {
			continue
		}

		range.selectNodeContents(span)

		const box = range.getBoundingClientRect()

		sizes.push(axis === "cols" ? box.width : box.height)
	}

	return sizes
}
