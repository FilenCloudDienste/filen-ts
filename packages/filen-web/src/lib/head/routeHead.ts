import { i18n } from "@/lib/i18n"

// The head tags this app emits. TanStack types a route match's `meta` as `unknown`, so the strictness
// lives here instead — one module owns the whole head contract, and route `head` options are the ONLY
// source of <title> in the app: React hoists every mounted <title> to the FRONT of <head>, so a second
// component-rendered one would fight the route's for that position and silently stick on a stale value.
export type HeadMetaTag = { title: string } | { name: string; content: string } | { property: string; content: string }

const SEPARATOR = " · "

// Segments run most-specific first and the product name always closes the title, matching how browsers
// truncate long tab labels from the right. Pure so it is unit-testable without i18n.
export function joinTitle(segments: readonly string[], appName: string): string {
	const parts = [...segments, appName].map(part => part.trim()).filter(part => part.length > 0)

	return parts.length === 0 ? appName : parts.join(SEPARATOR)
}

// The only way a route declares its title. `appName` is a brand string, never translated.
export function titleMeta(...segments: string[]): HeadMetaTag[] {
	return [{ title: joinTitle(segments, i18n.t("common:appName")) }]
}

// Every route's <meta name="robots"> value; only the public-link routes use it.
export const NOINDEX_META: HeadMetaTag = { name: "robots", content: "noindex, nofollow" }

// Structural minimum of a head ctx, declared as a supertype of TanStack's own so `routeHead(...)` is
// assignable to `head?:` without naming that option's generics.
export interface HeadContext {
	matches?: readonly { globalNotFound?: boolean }[]
}

// A URL that matches no route still fuzzy-matches its nearest ANCESTOR, and that ancestor's `head`
// still runs — so without this guard the ancestor's title would win over the not-found page's. Only
// the root match carries `globalNotFound`, and the root is `matches[0]`, hence the index.
export function isGlobalNotFound(ctx: HeadContext): boolean {
	return ctx.matches?.[0]?.globalNotFound === true
}

// The ONLY way a non-root route declares head tags. Non-title meta survives a not-found so the
// public-link routes keep their noindex on an unmatched sub-path; the title does not, so the root's
// not-found title wins.
//
// `title` is a thunk, not resolved strings: route options are evaluated when the route module is
// imported, so an eagerly resolved `i18n.t(...)` would freeze every tab label in the boot language.
export function routeHead(options: { title?: () => readonly string[]; meta?: readonly HeadMetaTag[] }): (ctx: HeadContext) => {
	meta: HeadMetaTag[]
} {
	return ctx => ({
		meta: [...(isGlobalNotFound(ctx) || !options.title ? [] : titleMeta(...options.title())), ...(options.meta ?? [])]
	})
}
