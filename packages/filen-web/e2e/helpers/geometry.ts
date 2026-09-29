import type { Locator } from "@playwright/test"

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
