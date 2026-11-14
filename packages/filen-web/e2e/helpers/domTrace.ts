import type { Page, TestInfo } from "@playwright/test"

// A diagnostic for a step whose UI never shows on CI only: from `startDomTrace` on, the page records (with ms offsets)
// every element matching `selectors` that mounts or unmounts, and every listed event that reaches the document
// (capture phase: type, pointer type, target, whether a handler prevented it). Attached by `attachDomTrace`, so a
// failure says whether the UI never mounted, mounted and went, or never got its input.
export async function startDomTrace(page: Page, selectors: readonly string[], events: readonly string[]): Promise<void> {
	await page.evaluate(
		({ selectors, events }) => {
			const start = performance.now()
			const lines: string[] = []
			const at = (): string => `+${String(Math.round(performance.now() - start))}ms`
			const describe = (element: Element): string => {
				const label = element.getAttribute("aria-label") ?? element.getAttribute("placeholder") ?? ""
				const role = element.getAttribute("role") ?? ""

				return `<${element.tagName.toLowerCase()}${role === "" ? "" : ` role=${role}`}${label === "" ? "" : ` "${label}"`}${
					element.className && typeof element.className === "string"
						? ` .${element.className.split(" ").slice(0, 3).join(".")}`
						: ""
				}>`
			}
			const scan = (node: Node, verb: string): void => {
				if (!(node instanceof Element)) return

				for (const selector of selectors) {
					const found = [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]

					for (const element of found) {
						lines.push(`${at()} ${verb} ${selector}: ${describe(element)}`)
					}
				}
			}

			new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.addedNodes) scan(node, "mounted")
					for (const node of record.removedNodes) scan(node, "unmounted")
				}
			}).observe(document.body, { childList: true, subtree: true })

			for (const type of events) {
				document.addEventListener(
					type,
					event => {
						const pointer = event instanceof PointerEvent ? ` ${event.pointerType}` : ""
						const target = event.target instanceof Element ? describe(event.target) : "(document)"

						// After the target's own handlers, so defaultPrevented says whether any of them took it.
						setTimeout(() => {
							lines.push(`${at()} ${type}${pointer} on ${target}${event.defaultPrevented ? " (prevented)" : ""}`)
						}, 0)
					},
					{ capture: true }
				)
			}

			document.addEventListener(
				"focusin",
				event => {
					lines.push(`${at()} focus ${event.target instanceof Element ? describe(event.target) : "(document)"}`)
				},
				{ capture: true }
			)

			Object.assign(window, { __e2eDomTrace: lines })
		},
		{ selectors, events }
	)
}

export async function attachDomTrace(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	const lines = await page
		.evaluate(() => (window as unknown as { __e2eDomTrace?: string[] }).__e2eDomTrace ?? ["(no trace started)"])
		.catch((error: unknown) => [`(trace unreadable: ${String(error)})`])

	await testInfo.attach(name, { body: lines.slice(-400).join("\n") || "(nothing recorded)", contentType: "text/plain" })
}
