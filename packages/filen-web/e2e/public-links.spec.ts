import { test, expect } from "./fixtures"
import { BOOT_SETTLE_TIMEOUT_MS, SIGN_IN_HEADING } from "./helpers/listing"

// The unauthenticated public-link viewer. These specs run WITHOUT an injected session
// (`injectSession: false`) — a logged-OUT browser context — which is the whole point: the /f/
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
const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const REPORT_ENDPOINT = "https://filen.io/api/v1/abuse-report"

test.describe("public links (unauthenticated)", () => {
	test.use({ injectSession: false })

	test("a file link renders the viewer's own invalid state, not a login redirect or boot error", async ({ page }) => {
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		// Reachable with NO session: the URL stays on the viewer route (never redirected to /login), the
		// boot-error screen never shows, and the sign-in surface is nowhere on the page.
		await expect(page).toHaveURL(new RegExp(`/f/${RANDOM_UUID}`))
		await expect(page.getByText("Filen could not start")).toHaveCount(0)
		await expect(page.getByText(SIGN_IN_HEADING)).toHaveCount(0)

		// The route's OWN surface renders — the viewer, not some other page. It either sits in its
		// loading state or has already reached its shared invalid surface.
		await expect(page.getByRole("status", { name: "Loading" }).or(page.getByText("This link is unavailable"))).toBeVisible({
			timeout: BOOT_SETTLE_TIMEOUT_MS
		})

		// The nonexistent link lands on the shared invalid surface — proving the ANONYMOUS worker path end
		// to end (no session, real round trip, graceful failure).
		await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.getByRole("link", { name: "Back to Filen" })).toBeVisible()
	})

	test("a directory link renders the viewer's own invalid state, not a login redirect or boot error", async ({ page }) => {
		await page.goto(`/d/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page).toHaveURL(new RegExp(`/d/${RANDOM_UUID}`))
		await expect(page.getByText("Filen could not start")).toHaveCount(0)
		await expect(page.getByText(SIGN_IN_HEADING)).toHaveCount(0)

		await expect(page.getByRole("status", { name: "Loading" }).or(page.getByText("This link is unavailable"))).toBeVisible({
			timeout: BOOT_SETTLE_TIMEOUT_MS
		})

		await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
	})

	test("renders the marketing-light chrome for a logged-out visitor — no login redirect", async ({ page }) => {
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		// The shared shell wraps every state, so the chrome is present the moment the route renders —
		// independent of whether the anonymous worker round trip has completed. Never bounced to /login.
		await expect(page).toHaveURL(new RegExp(`/f/${RANDOM_UUID}`))

		const brand = page.getByRole("link", { name: "Filen home" })
		await expect(brand).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(brand).toHaveAttribute("href", "https://filen.io")

		// One quiet sign-in link plus one tasteful "Get Filen" CTA — the old-web upsell sidebar is dropped.
		await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible()
		const cta = page.getByRole("link", { name: "Get Filen" })
		await expect(cta).toBeVisible()
		await expect(cta).toHaveAttribute("href", "https://filen.io")

		// A one-line footer: the e2e tagline plus the report-abuse dialog's trigger, and the open source licenses
		// the page's bundle ships, quieter at its far end.
		await expect(page.getByText("Shared securely with end-to-end encryption")).toBeVisible()
		await expect(page.getByRole("button", { name: "Report abuse" })).toBeVisible()
		await expect(page.getByRole("button", { name: "Open source licenses" })).toBeVisible()
	})

	test("pins the header and the footer to one viewport, the page itself never scrolling", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 640 })
		await page.goto(`/d/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		const footer = page.getByRole("contentinfo")
		const box = await footer.boundingBox()

		expect(box).not.toBeNull()
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(640, 0)
		await expect(page.getByRole("banner")).toBeInViewport()
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight))
			.toBeLessThanOrEqual(0)
	})

	// The challenge script and the report endpoint are both stubbed: no real report is ever sent. The stub
	// still crosses the page's CSP and cross-origin isolation, as Cloudflare's script does. WebKit routes
	// none of a service-worker-controlled page's requests, and the worker claims the page once it boots, so
	// the stubs would miss there and the real script and endpoint would be reached. Blocked for this test only.
	test.describe("abuse report", () => {
		test.use({ serviceWorkers: "block" })

		test("sends an abuse report through the footer's dialog", async ({ page }) => {
			const reports: unknown[] = []

			await page.route(TURNSTILE_SCRIPT, route =>
				route.fulfill({
					contentType: "text/javascript",
					headers: { "Cross-Origin-Resource-Policy": "cross-origin", "Access-Control-Allow-Origin": "*" },
					body: `window.turnstile = { render: (el, o) => { setTimeout(() => o.callback("e2e-token"), 0); return "w" }, reset() {}, remove() {} }`
				})
			)
			await page.route(REPORT_ENDPOINT, route => {
				reports.push(route.request().postDataJSON())

				return route.fulfill({
					status: 200,
					contentType: "application/json",
					headers: { "Access-Control-Allow-Origin": "*" },
					body: JSON.stringify({ success: true })
				})
			})
			await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)
			await page.getByRole("button", { name: "Report abuse" }).click()

			const dialog = page.getByRole("dialog", { name: "Report abuse" })
			const send = dialog.getByRole("button", { name: "Send" })

			await expect(dialog).toBeVisible()
			await expect(send).toBeDisabled()

			await dialog.getByRole("radio", { name: "Malware" }).click()
			await dialog.getByLabel("Your email").fill("visitor@example.com")
			await dialog.getByLabel("Details (optional)").fill("e2e")
			await expect(send).toBeEnabled()
			await send.click()

			await expect(dialog).toBeHidden()
			await expect(page.getByText("Report sent. Thank you.")).toBeVisible()
			expect(reports).toEqual([
				{ turnstileToken: "e2e-token", email: "visitor@example.com", reason: "malware", link: page.url(), comment: "e2e" }
			])
		})
	})

	test("the reachable surfaces do not overflow a narrow phone viewport", async ({ page }) => {
		// Public links get opened on phones. On the reachable states (the chrome plus, on non-Firefox, the
		// terminal invalid card) the body must never scroll horizontally at a 360px width. A protected
		// link's password gate is not reachable without a live premium link, so its overflow is covered by
		// the unit suite rendering the same primitives, not here.
		await page.setViewportSize({ width: 360, height: 780 })
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page.getByRole("link", { name: "Get Filen" })).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// The chrome above renders the moment the route does (see the chrome test's own note), so gating
		// on it alone would measure the TRANSIENT loading state and let an invalid card that
		// overflows 360px pass.
		await expect(page.getByText("This link is unavailable")).toBeVisible({ timeout: BOOT_SETTLE_TIMEOUT_MS })

		// Polled, not read once: the invalid card's own mount is what settles the layout, and a read taken
		// on the frame it commits can catch the document mid-reflow and report an overflow that is gone a
		// tick later.
		await expect
			.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
			.toBeLessThanOrEqual(0)
	})

	test("a legacy hash-format link redirects to the new swapped path with the fragment key intact", async ({ page }) => {
		// Legacy hash-router shape: everything after the first '#' is a client-side fragment the server
		// never sees. Legacy /f/ meant a DIRECTORY, so it must land on the NEW /d/ route (letters
		// swapped), key preserved verbatim in the new fragment.
		await page.goto(`/#/f/${RANDOM_UUID}%23${HEX_KEY}`)

		// The rewrite runs client-side once the app boots, so this closes on a cold boot, not on a server
		// redirect — the same budget every other first-paint wait in this file carries.
		await expect(page).toHaveURL(new RegExp(`/d/${RANDOM_UUID}#${HEX_KEY}`), { timeout: BOOT_SETTLE_TIMEOUT_MS })
	})

	test("a link route carries a generic title and a noindex robots meta", async ({ page }) => {
		// Belt to robots.txt's braces for a JS-executing crawler that reached the route anyway. The title
		// is deliberately generic — a shared item's NAME never enters the title or any meta tag. Needs only
		// the route to mount, not the SDK round trip, so no engine gate is required.
		await page.goto(`/f/${RANDOM_UUID}#${HEX_KEY}`)

		await expect(page).toHaveTitle("Shared file · Filen", { timeout: BOOT_SETTLE_TIMEOUT_MS })
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/)
	})
})
