import { describe, expect, it } from "vitest"
import { collapsedCrumbRange } from "@/features/drive/components/breadcrumb.logic"

// Every step between two crumbs costs separator + 2 * gap = 10 + 2 * 5 = 20.
const BASE = { separator: 10, gap: 5, ellipsis: 20 }

describe("collapsedCrumbRange", () => {
	it("hides nothing when the trail fits, or before anything is measured", () => {
		// 4 * 50 + 3 * 20 = 260
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 50, 50, 50], available: 260 })).toEqual({ start: 0, end: 0 })
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 50, 50, 50], available: 0 })).toEqual({ start: 0, end: 0 })
		expect(collapsedCrumbRange({ ...BASE, widths: [500], available: 100 })).toEqual({ start: 0, end: 0 })
	})

	it("folds the oldest ancestors below the root first, keeping the root and the current directory", () => {
		// root, …, c, d: 50 + 20 + 50 + 50 + 3 * 20 = 230
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 50, 50, 50, 50], available: 230 })).toEqual({ start: 1, end: 3 })
		// root, …, d: 50 + 20 + 50 + 2 * 20 = 160
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 50, 50, 50, 50], available: 160 })).toEqual({ start: 1, end: 4 })
	})

	it("folds the root too once only the current directory still fits beside the menu", () => {
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 50, 50, 50, 50], available: 100 })).toEqual({ start: 0, end: 4 })
		expect(collapsedCrumbRange({ ...BASE, widths: [50, 300], available: 200 })).toEqual({ start: 0, end: 1 })
	})
})
