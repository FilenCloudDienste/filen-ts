import { existsSync, readFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect, SESSION_FILE } from "./fixtures"
import { waitForE2eHooks } from "./helpers/e2eHooks"
import { bootTo, dismissStartupReminders } from "./helpers/listing"
import { SESSION_SLOT } from "@/e2e-hooks/sessionSlot"

interface SessionFile {
	session: string
}

// Reads the harvested session directly rather than via the injectedSession fixture: that fixture's
// addInitScript re-fires on EVERY navigation of its page (Playwright's documented behavior, not just
// the first), including the reload logout itself triggers — left alone, it would silently re-seed
// and resurrect the very session this test clears. seedOncePerPage below replaces it with a version
// that only ever seeds once per page.
function readHarvestedSession(): string | null {
	if (!existsSync(SESSION_FILE)) {
		return null
	}

	const { session } = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile

	return session
}

// Seeds sessionStorage for ONE page's very first navigation only, via a localStorage marker this
// script owns end-to-end (kvClear never touches localStorage — it only wipes the app's own
// sqlite-backed kv). Every later navigation of the same page (reload included) finds the marker set
// and skips re-seeding, so whatever the app's own kv actually holds at that point is what decides
// whether the page renders authed — not a stale replay of the original blob.
async function seedOncePerPage(page: Page, session: string): Promise<void> {
	await page.addInitScript(
		([slot, blob, markerKey]) => {
			if (localStorage.getItem(markerKey) === "1") {
				return
			}

			localStorage.setItem(markerKey, "1")
			sessionStorage.setItem(slot, blob)
		},
		[SESSION_SLOT, session, "filen.e2e.session.seeded-once"] as const
	)
}

// The CSP's connect-src allowlist (vite.config.ts) IS the exact host family the SDK ever talks to:
// *.filen.io / *.filen.net / *.filen-1.net..filen-6.net (the wasm binary's baked-in failover hosts).
// Same-origin artifact/wasm fetches (this preview server's own host) never match this pattern, so
// filtering on it alone already excludes them without a separate allowlist.
const SDK_HOST_RE = /(^|\.)filen(-[1-6])?\.(io|net)$/

const email = process.env["FILEN_WEB_E2E_TEST_EMAIL"] ?? ""

// A cold authed boot is a wasm init + rayon pool spin-up + OPFS open — the same budget
// playwright.config.ts pins navigationTimeout to — and after a logout it additionally follows the
// whole phased wipe plus the reload that triggers it. The 10s expect default governs UI
// responsiveness only and was never sized for any of that. (bootTo carries the same budget for the
// authed-shell case; this one is for the sign-in surface a logout lands on.)
const COLD_BOOT_TIMEOUT_MS = 30_000

// The wrong-password attempt is a live, un-retryable round trip: v3/auth/info, wasm key derivation,
// v3/login, and only then the toast. Same reason as above — the expect default never covered network.
const LIVE_LOGIN_TIMEOUT_MS = 30_000

test.describe("auth", () => {
	// This block makes a real call to the rate-limited login endpoint, so it must never retry: under
	// CI (retries: 1 in playwright.config) a flake would fire a SECOND real failed login in the same
	// run and bust the budget. Same guard auth.setup.ts uses for its one real success.
	test.describe("real login attempt", () => {
		test.describe.configure({ retries: 0 })

		test("a wrong password surfaces the label-first error through the minified worker", async ({ page, browserName }) => {
			// The run's ONE deliberate failed login (auth-setup's one success + this one failure, exactly
			// once each per full run). The firefox lane no longer collects this file (playwright.config.ts
			// scopes it to the specs that have something to run there), so this gate is the guarantee that
			// no second browser project can ever double it.
			test.skip(browserName !== "chromium", "chromium-only: a second browser project would double the failed-login budget")
			test.skip(email === "", "no e2e credentials configured")

			await page.goto("/login")
			await expect(page.getByText("Sign in to Filen")).toBeVisible()

			await page.getByLabel("Email", { exact: true }).fill(email)
			// Deliberately NOT the real password — this test never reads FILEN_WEB_E2E_TEST_PASSWORD, only
			// the email (a dedicated e2e test account, not a customer's).
			await page.getByLabel("Password", { exact: true }).fill("wrong-password-e2e-probe")
			await page.getByRole("button", { name: "Sign in", exact: true }).click()

			// errors.ts pre-seeds a catalog translation for EmailOrPasswordWrong, so errorLabel() renders
			// this exact string regardless of the live server's own wording — the regression net this test
			// exists for is that the MINIFIED production worker still duck-types the live FilenSdkError
			// (toErrorDTO's isSdkError probe survives minification) and reports the right kind, not that the
			// server's message happens to match.
			try {
				await expect(page.getByText("Wrong email or password. Please try again.")).toBeVisible({ timeout: LIVE_LOGIN_TIMEOUT_MS })
			} catch (cause) {
				// loginForm.tsx surfaces this through toast.error(errorLabel(...)), so the toast is the sole
				// carrier of the reason — and the other outcome this real, rate-limited endpoint can return
				// is a rate-limit error whose toast reads nothing like the string above. Unattached, that
				// failure reports only "expected 'Wrong email or password…' to be visible" and points the
				// next reader at the error catalog instead of at the rate limit.
				const toasts = await page
					.locator("[data-sonner-toast]")
					.allInnerTexts()
					.catch(() => [])

				throw new Error(`the wrong-password toast never rendered; toasts on the page: ${JSON.stringify(toasts)}`, { cause })
			}

			// A rejected attempt never navigates — still on the sign-in form.
			await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible()
		})
	})

	test("an authed session survives a reload without re-authenticating against the SDK API", async ({
		page,
		injectedSession,
		browserName
	}) => {
		// Playwright-firefox's documented authed-shell-reload instability (Corrupted Content Error) when
		// reloading an already-authed page.
		test.skip(browserName !== "chromium", "reload-resume is chromium-gated: Playwright-firefox authed-shell-reload instability")
		expect(injectedSession.length).toBeGreaterThan(0)

		await bootTo(page, "/")

		const sdkHostRequests: string[] = []
		page.on("request", req => {
			if (SDK_HOST_RE.test(new URL(req.url()).hostname)) {
				sdkHostRequests.push(req.url())
			}
		})

		// THE RULE (helpers/listing.ts): the blocking startup reminder renders the rest of the shell
		// inert, so it is dismissed before any role-based landmark assertion — the reload re-arms it.
		await page.reload()
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible({ timeout: COLD_BOOT_TIMEOUT_MS })

		// The authed shell's own account query (IconRail's AccountMenu + the export-keys reminder) fires
		// its normal reads (verified live: user/info, user/settings, user/account) the instant it mounts,
		// reload or not — that is ordinary app behavior, not a resume cost, so it is not what this test
		// is about. Waiting for it puts the observation window past the point where a login call would
		// already have had to happen if resume needed one — auth guards run before the shell renders at
		// all. What resumeSession() must never do is re-authenticate: injectClient (unauth.fromStringified)
		// is a synchronous, zero-network wasm call (sdk.worker.ts), so the login endpoint (verified via
		// `strings` over sdk-rs_bg.wasm: the literal path "v3/login") is the one thing that must never
		// appear here.
		//
		// Polled over the recorded array, never page.waitForRequest: that subscribes at call time and
		// never replays, and these reads fire the instant the shell mounts — the very condition the
		// visibility wait above is satisfied by. Nothing refetches them afterwards (queries/account.ts
		// has no refetchInterval), so a late subscription simply waits forever. The listener above was
		// attached BEFORE the reload, so it cannot miss them.
		await expect.poll(() => sdkHostRequests.some(url => new URL(url).pathname.includes("/v3/user/")), { timeout: 30_000 }).toBe(true)

		const loginRequests = sdkHostRequests.filter(url => url.includes("/v3/login"))
		expect(loginRequests, sdkHostRequests.join("\n")).toEqual([])
	})

	test("logout signs out, wipes the local session, and a second tab converges to sign-in", async ({ page, context, browserName }) => {
		// Second-SDK-worker-tab crash (storage.spec's follower-tab test hits the identical rationale) plus
		// the same authed-shell-reload instability as the test above.
		test.skip(browserName !== "chromium", "second-tab convergence is chromium-gated: Playwright-firefox second-SDK-worker-tab crash")

		const session = readHarvestedSession()

		test.skip(session === null, "no injected session (e2e credentials not configured)")

		if (session === null) {
			// Unreachable once the skip above fires — Playwright aborts the test there — but tsc has no
			// way to know that, so this is what actually narrows the type for everything below.
			return
		}

		await seedOncePerPage(page, session)
		await bootTo(page, "/")

		// A second, already-signed-in tab opened BEFORE logout — the realistic multi-tab scenario the
		// auth broadcast channel exists to keep coherent. The once-per-page marker lives in localStorage,
		// which is shared across the context, so this second call is a no-op: `second` renders authed
		// because the first seed already persisted the session into the shared kv. What matters is that
		// neither page re-seeds on its post-logout reload, so both converge onto the wiped kv state.
		const second = await context.newPage()

		await seedOncePerPage(second, session)
		await bootTo(second, "/")

		// Each surface asserted before it is clicked: the three steps are one chained interaction, and
		// a click issued against a menu that has not opened (or a confirm that has not mounted) fails
		// as an actionability timeout on the NEXT step, naming a locator rather than the step that
		// actually did not happen.
		const accountMenu = page.getByRole("menu")
		const signOutItem = accountMenu.getByRole("menuitem", { name: "Sign out", exact: true })
		// the confirm dialog's own action button
		const signOutConfirm = page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true })

		await page.getByRole("button", { name: "Account", exact: true }).click()
		await expect(signOutItem).toBeVisible()
		await signOutItem.click()
		await expect(signOutConfirm).toBeVisible()
		await signOutConfirm.click()

		// Everything between the click and this render is one budget: runLogout's eight phases
		// (cancel-queries, clear-query-cache, sdk-logout, clear-session, kv-clear, wipe-service-worker,
		// broadcast, reload — sdk-logout being a live call of its own), then a complete cold boot before
		// the sign-in form exists at all.
		await expect(page.getByText("Sign in to Filen")).toBeVisible({ timeout: COLD_BOOT_TIMEOUT_MS })

		// The logout reload is a cold boot, and the hooks arrive on their own fire-and-forget import —
		// a rendered sign-in form is no proof they are back.
		await waitForE2eHooks(page)

		// kvHas, not kvGet: the session key holds an OBJECT (StringifiedClient), not a plain string, so
		// kvGet's stringSchema would report "null" whether the row is genuinely gone or merely the wrong
		// shape for that schema — kvHas checks existence directly, independent of shape.
		const sessionStillPresent = await page.evaluate(() => window.__filenE2E.kvHas("sdk.session.v1"))
		expect(sessionStillPresent).toBe(false)

		// The second tab's own worker still holds its own live client; reloading is what re-reads the
		// now-empty shared kv (seedOncePerPage's marker means this reload does NOT re-seed) and
		// converges it onto sign-in too.
		await second.reload()
		await expect(second.getByText("Sign in to Filen")).toBeVisible({ timeout: COLD_BOOT_TIMEOUT_MS })

		await second.close()
	})
})
