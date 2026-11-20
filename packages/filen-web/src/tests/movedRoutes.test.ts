import { describe, expect, it, vi } from "vitest"
import { isRedirect } from "@tanstack/react-router"

// The page-selecting params that moved from the search into the path: /contacts/<section>, /playlists/<uuid>,
// /sync/<pairId>/<tab> and /settings/plans/<plan>. Each route's guard sends an unknown value to the page's default.
// The old ?param form is rewritten before the router starts (legacyUrl.test.ts).

vi.mock("@/features/contacts/components/contactsList", () => ({ ContactsList: () => null }))
vi.mock("@/features/settings/components/billing/plansView", () => ({ PlansView: () => null }))
vi.mock("@/features/settings/components/accountGate", () => ({ AccountGate: () => null }))
vi.mock("@/features/audio/screens/playlists", () => ({ PlaylistsScreen: () => null }))

const { Route: ContactsIndexRoute } = await import("@/routes/_app/contacts.index")
const { Route: ContactsSectionRoute } = await import("@/routes/_app/contacts.$section")
const { Route: SyncTabRoute } = await import("@/routes/_app/sync.$pairId.$tab")
const { Route: PlansPlanRoute } = await import("@/routes/_app/settings/plans.$plan")
const { Route: PlaylistsIndexRoute } = await import("@/routes/_app/playlists.index")
const { Route: PlaylistsUuidRoute } = await import("@/routes/_app/playlists.$uuid")

interface RedirectOptions {
	to?: string
	params?: Record<string, string>
	replace?: boolean
}

type BeforeLoad = (ctx: { params: Record<string, string> }) => unknown

function guard(route: { options: unknown }): BeforeLoad {
	const beforeLoad = (route.options as { beforeLoad?: BeforeLoad }).beforeLoad

	if (beforeLoad === undefined) {
		throw new Error("route has no beforeLoad")
	}

	return beforeLoad
}

function redirectOf(run: () => unknown): RedirectOptions | null {
	try {
		run()
	} catch (e) {
		expect(isRedirect(e)).toBe(true)

		return (e as { options: RedirectOptions }).options
	}

	return null
}

describe("/contacts/$section", () => {
	it("opens the default section from bare /contacts", () => {
		expect(redirectOf(() => guard(ContactsIndexRoute)({ params: {} }))).toMatchObject({
			to: "/contacts/$section",
			params: { section: "all" },
			replace: true
		})
	})

	it.each(["all", "requests", "pending", "contacts", "blocked"])("keeps the %s section", section => {
		expect(redirectOf(() => guard(ContactsSectionRoute)({ params: { section } }))).toBeNull()
	})

	it.each(["online", "", "ALL", "..", "requests%2F"])("sends %j to the default section", section => {
		expect(redirectOf(() => guard(ContactsSectionRoute)({ params: { section } }))).toMatchObject({
			to: "/contacts/$section",
			params: { section: "all" },
			replace: true
		})
	})
})

describe("/sync/$pairId/$tab", () => {
	it.each(["activity", "issues", "ignored", "settings"])("keeps the %s tab", tab => {
		expect(redirectOf(() => guard(SyncTabRoute)({ params: { pairId: "12", tab } }))).toBeNull()
	})

	it.each(["bogus", "", "Issues"])("sends %j to the pair's default tab", tab => {
		expect(redirectOf(() => guard(SyncTabRoute)({ params: { pairId: "12", tab } }))).toMatchObject({
			to: "/sync/$pairId",
			params: { pairId: "12" },
			replace: true
		})
	})
})

describe("/settings/plans/$plan", () => {
	it.each(["1", "27", String(Number.MAX_SAFE_INTEGER)])("keeps plan %s", plan => {
		expect(redirectOf(() => guard(PlansPlanRoute)({ params: { plan } }))).toBeNull()
	})

	it.each(["0", "-3", "1.5", "1e3", "abc", "99999999999999999999"])("sends %j to the plans without one", plan => {
		expect(redirectOf(() => guard(PlansPlanRoute)({ params: { plan } }))).toMatchObject({ to: "/settings/plans", replace: true })
	})
})

describe("/playlists/$uuid", () => {
	it("selects only: the layout renders the screen for the bare and the uuid form", () => {
		expect(PlaylistsIndexRoute.options.component).toBeUndefined()
		expect(PlaylistsUuidRoute.options.component).toBeUndefined()
	})
})
