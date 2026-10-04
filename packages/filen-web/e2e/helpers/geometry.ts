import type { Locator } from "@playwright/test"
import { expect } from "../fixtures"

// Strict null handling (no `!`): a locator with no box on screen is a real failure, surfaced here.
export async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
	const box = await locator.boundingBox()

	if (box === null) {
		throw new Error("expected the element to have an on-screen bounding box")
	}

	return box
}

export async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
	const box = await boxOf(locator)

	return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// Whether the page hit-tests `point` to `locator`'s element or something inside it.
export async function hitsAt(locator: Locator, point: { x: number; y: number }): Promise<boolean> {
	return locator.evaluate((element, { x, y }) => {
		const hit = document.elementFromPoint(x, y)

		return hit !== null && element.contains(hit)
	}, point)
}

// The centre of `locator` once the page hit-tests it there: a box read while the layout above it still
// settles can name a point another row covers a moment later.
export async function hitCenterOf(locator: Locator, timeout = 10_000): Promise<{ x: number; y: number }> {
	let center = { x: 0, y: 0 }

	await expect(async () => {
		center = await centerOf(locator)
		expect(await hitsAt(locator, center)).toBe(true)
	}).toPass({ timeout })

	return center
}
