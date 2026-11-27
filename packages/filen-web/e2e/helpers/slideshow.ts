import type { Locator, Page } from "@playwright/test"
import { expect } from "../fixtures"

// A running slideshow's control bar (slideshowBar.tsx), over the preview and the public link page alike.
export function slideshowBar(page: Page): Locator {
	return page.getByRole("group", { name: "Slideshow controls", exact: true })
}

// The bar hides with the cursor after 2.5 s idle and takes no pointer while hidden, and a click's hit test runs before
// its pointer moves, so a wait that outlasts the idle leaves the click on the slide. A pointer move over the stage (the
// viewport's middle while a slideshow runs) brings it back for the clicks that follow.
export async function revealSlideshowBar(page: Page): Promise<Locator> {
	const bar = slideshowBar(page)
	const viewport = page.viewportSize()
	const x = (viewport?.width ?? 1280) / 2
	const y = (viewport?.height ?? 720) / 2

	await page.mouse.move(x, y)
	await page.mouse.move(x + 1, y + 1)
	await expect(bar).not.toHaveClass(/pointer-events-none/u)

	return bar
}
