import type { BrowserContext, Page, TestInfo } from "@playwright/test"

export interface PageStateLines {
	readonly calls: string[]
	readonly overlays: string[]
}

// What one page still had in flight inside its workers (the SDK's, the PDF engine's, the signer's), and the state of
// every dialog it still holds: whether one asked to close is still mounted, and which animation it waits on (the
// failure screenshot shows only the top of an 8000px viewport, where no dialog is). Bounded, because a wedged main
// thread never answers an evaluate.
async function pageState(page: Page, tab: string): Promise<PageStateLines> {
	const state = await Promise.race([
		page
			.evaluate(() => {
				const hooks = (window as unknown as { __filenE2E?: Partial<Window["__filenE2E"]> }).__filenE2E
				const overlays = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')].map(element => {
					const labelledBy = element.getAttribute("aria-labelledby")
					const name =
						(labelledBy === null ? null : document.getElementById(labelledBy)?.textContent) ??
						element.getAttribute("aria-label") ??
						""
					const flags = ["data-open", "data-closed", "data-starting-style", "data-ending-style"].filter(flag =>
						element.hasAttribute(flag)
					)
					const animations = element.getAnimations().map(animation => {
						const label =
							animation instanceof CSSAnimation
								? animation.animationName
								: animation instanceof CSSTransition
									? `transition ${animation.transitionProperty}`
									: "animation"

						return `${label} ${animation.playState}${animation.pending ? " pending" : ""} at ${String(Math.round(Number(animation.currentTime ?? 0)))}ms`
					})

					return `${String(element.getAttribute("role"))} "${name.slice(0, 60)}" ${flags.join(" ") || "(no state)"}${element.closest("[inert]") === null ? "" : " inert"}${element.checkVisibility() ? "" : " invisible"}; animations: ${animations.join(", ") || "none"}`
				})

				// A page without the app (a blank start page) has no calls to report.
				return {
					sdk: hooks?.pendingSdkCalls?.() ?? [],
					workers: hooks?.pendingWorkerCalls?.() ?? [],
					overlays
				}
			})
			.catch(() => ({ sdk: [], workers: [], overlays: [] })),
		new Promise<null>(resolve => {
			setTimeout(() => {
				resolve(null)
			}, 2_000)
		})
	])

	if (state === null) {
		return { calls: [`${tab} calls: (the page did not answer)`], overlays: [] }
	}

	return {
		calls: [
			...state.sdk.map(({ method, ageMs }) => `${tab} sdk call ${method} pending ${String(ageMs)}ms`),
			...state.workers.map(({ method, ageMs }) => `${tab} worker call ${method} pending ${String(ageMs)}ms`)
		],
		overlays: state.overlays.map(line => `${tab} ${line}`)
	}
}

export async function pageStateLines(context: BrowserContext): Promise<PageStateLines> {
	const pages = await Promise.all(context.pages().map((page, index) => pageState(page, `tab${String(index)}`)))

	return { calls: pages.flatMap(page => page.calls), overlays: pages.flatMap(page => page.overlays) }
}

// The lines as the diagnostics attachment shows them, under headings that say `when`.
export function stateReport({ calls, overlays }: PageStateLines, when: string): string[] {
	return [
		...(calls.length === 0 ? [] : [`-- calls pending ${when} --`, ...calls]),
		...(overlays.length === 0 ? [] : [`-- dialogs ${when} --`, ...overlays])
	]
}

// Only the top of the page: the helpers stretch the viewport to 8000px for virtualization, and the full
// capture (and the video) shrinks that to a sliver nobody can read.
const FAILURE_SCREENSHOT_HEIGHT = 900

async function topScreenshot(page: Page): Promise<Buffer | null> {
	const size = page.viewportSize()

	if (size === null || page.isClosed()) {
		return null
	}

	try {
		return await page.screenshot({
			clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, FAILURE_SCREENSHOT_HEIGHT) },
			timeout: 5_000
		})
	} catch {
		// A page that cannot paint any more has nothing to show.
		return null
	}
}

export async function attachTopScreenshots(context: BrowserContext, testInfo: TestInfo): Promise<void> {
	for (const [index, page] of context.pages().entries()) {
		const body = await topScreenshot(page)

		if (body !== null) {
			await testInfo.attach(`screenshot-top-tab${String(index)}`, { body, contentType: "image/png" })
		}
	}
}

// The page as a failed step left it, before a helper's cleanup (a scratch directory trashed from the root listing)
// moves it on: what the end-of-test diagnostics would otherwise report about the cleanup instead.
export async function attachStateAtFailure(page: Page, testInfo: TestInfo): Promise<void> {
	const lines = stateReport(await pageState(page, "page"), "at the failure")
	const body = await topScreenshot(page)

	await testInfo.attach("state at the failure", { body: lines.join("\n") || "(nothing pending)", contentType: "text/plain" })

	if (body !== null) {
		await testInfo.attach("screenshot-top at the failure", { body, contentType: "image/png" })
	}
}
