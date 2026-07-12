import { test, expect } from "./fixtures"

// The unauthenticated public-link viewer. These specs run WITHOUT an injected session (plain `test`,
// no `injectedSession` fixture) — a logged-OUT browser context — which is the whole point: the /f/
// and /d/ routes must boot and render with no session at all, gated only by the root BootGate, never
// bounced to /login and never collapsing into the boot-error screen. No live premium link exists to
// test a SUCCESS path (link creation is premium; the e2e account is free-tier), so success is out of
// scope here by construction — reachability + the route's own invalid surface + the legacy redirect
// are what prove the architecture.

// A well-formed but almost-certainly-nonexistent link: a valid uuid shape + a 64-hex key (decodes to
// a 32-byte key, comfortably past the route's min-fragment floor), so the route resolves the fragment
// and actually issues the anonymous worker round trip rather than short-circuiting on a bad key.
const RANDOM_UUID = "deadbeef-0000-4000-8000-0123456789ab"
const HEX_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

test.describe("public links (unauthenticated)", () => {
	test("a file link renders the viewer's own invalid state, not a login redirect or boot error", async ({ page, browserName }) => {
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		// Reachable with NO session: the URL stays on the viewer route (never redirected to /login), the
		// boot-error screen never shows, and the sign-in surface is nowhere on the page.
		await expect(page).toHaveURL(new RegExp(`/f/${RANDOM_UUID}`))
		await expect(page.getByText("Filen could not start")).toHaveCount(0)
		await expect(page.getByText("Sign in to Filen")).toHaveCount(0)

		// The route's OWN surface renders — the viewer, not some other page. It either sits in its
		// loading state or has already reached its shared invalid surface.
		await expect(page.getByText("Opening link…").or(page.getByText("This link is unavailable"))).toBeVisible({ timeout: 30_000 })

		// On engines whose SDK worker completes the cross-origin resolve, the nonexistent link lands on
		// the shared invalid surface — proving the ANONYMOUS worker path end to end (no session, real
		// round trip, graceful failure). Playwright-Firefox's COI worker fetch hangs (see boot.spec), so
		// it is verified only reaching the reachable loading state above.
		if (browserName !== "firefox") {
			await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: 30_000 })
			await expect(page.getByRole("link", { name: "Back to Filen" })).toBeVisible()
		}
	})

	test("a directory link renders the viewer's own invalid state, not a login redirect or boot error", async ({ page, browserName }) => {
		await page.goto(`/d/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page).toHaveURL(new RegExp(`/d/${RANDOM_UUID}`))
		await expect(page.getByText("Filen could not start")).toHaveCount(0)
		await expect(page.getByText("Sign in to Filen")).toHaveCount(0)

		await expect(page.getByText("Opening link…").or(page.getByText("This link is unavailable"))).toBeVisible({ timeout: 30_000 })

		if (browserName !== "firefox") {
			await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: 30_000 })
		}
	})

	test("renders the marketing-light chrome for a logged-out visitor — no login redirect", async ({ page }) => {
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		// The shared shell wraps every state, so the chrome is present the moment the route renders —
		// independent of whether the anonymous worker round trip has completed (so this holds even on
		// Playwright-Firefox, whose COI worker fetch hangs past boot). Never bounced to /login.
		await expect(page).toHaveURL(new RegExp(`/f/${RANDOM_UUID}`))

		const brand = page.getByRole("link", { name: "Filen home" })
		await expect(brand).toBeVisible({ timeout: 30_000 })
		await expect(brand).toHaveAttribute("href", "https://filen.io")

		// One quiet sign-in link plus one tasteful "Get Filen" CTA — the old-web upsell sidebar is dropped.
		await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible()
		const cta = page.getByRole("link", { name: "Get Filen" })
		await expect(cta).toBeVisible()
		await expect(cta).toHaveAttribute("href", "https://filen.io")

		// A one-line footer: the e2e tagline plus a minimal report-abuse affordance (a mailto, no API).
		await expect(page.getByText("Shared securely with end-to-end encryption")).toBeVisible()
		await expect(page.getByRole("link", { name: "Report abuse" })).toHaveAttribute("href", "mailto:abuse@filen.io")
	})

	test("the reachable surfaces do not overflow a narrow phone viewport", async ({ page }) => {
		// Public links get opened on phones. On the reachable states (the chrome plus, on non-Firefox, the
		// terminal invalid card) the body must never scroll horizontally at a 360px width. A protected
		// link's password gate is not reachable without a live premium link, so its overflow is covered by
		// the unit suite rendering the same primitives, not here.
		await page.setViewportSize({ width: 360, height: 780 })
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page.getByRole("link", { name: "Get Filen" })).toBeVisible({ timeout: 30_000 })

		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
		expect(overflow).toBeLessThanOrEqual(0)
	})

	test("a legacy hash-format link redirects to the new swapped path with the fragment key intact", async ({ page }) => {
		// Legacy hash-router shape: everything after the first '#' is a client-side fragment the server
		// never sees. Legacy /f/ meant a DIRECTORY, so it must land on the NEW /d/ route (letters
		// swapped), key preserved verbatim in the new fragment.
		await page.goto(`/#/f/${RANDOM_UUID}%23${HEX_KEY}`)

		await expect(page).toHaveURL(new RegExp(`/d/${RANDOM_UUID}#${HEX_KEY}`))
	})
})
