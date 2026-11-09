import type { AnyRoute, AnyRouter } from "@tanstack/react-router"

// Route titles are thunks the router runs on navigation only. After a language change this runs the current matches'
// head functions again and sets the deepest title, as HeadContent would, without router.invalidate(), which would
// re-run every match's beforeLoad and loader too. The next navigation renders head tags from fresh results again.
export async function refreshDocumentTitle(router: AnyRouter): Promise<void> {
	const routes = router.routesById as Record<string, AnyRoute | undefined>
	const { matches } = router.state
	let title: string | undefined

	for (const match of matches) {
		const head = routes[match.routeId]?.options.head

		if (head !== undefined) {
			const result: unknown = await head({
				...(router.options.ssr === undefined ? {} : { ssr: router.options.ssr }),
				matches,
				match,
				params: match.params,
				loaderData: match.loaderData
			})

			title = titleOf(result) ?? title
		}

		if (match._notFound === true) {
			break
		}
	}

	if (title !== undefined) {
		document.title = title
	}
}

export function titleOf(head: unknown): string | undefined {
	if (typeof head !== "object" || head === null || !("meta" in head) || !Array.isArray(head.meta)) {
		return undefined
	}

	for (const tag of head.meta as unknown[]) {
		if (typeof tag === "object" && tag !== null && "title" in tag && typeof tag.title === "string") {
			return tag.title
		}
	}

	return undefined
}
