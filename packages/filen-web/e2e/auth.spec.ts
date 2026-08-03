import { existsSync, readFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { test, expect, SESSION_FILE } from "./fixtures"
import { dismissStartupReminders } from "./helpers/listing"

// Mirrors fixtures.ts's own (non-exported) constant — see storage.spec.ts's follower-tab test for
// the same local-redeclaration precedent.
const SESSION_SLOT = "filen.e2e.session"

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
			await expect(page.getByText("Wrong email or password. Please try again.")).toBeVisible()

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

		await page.goto("/")
		// THE RULE (helpers/listing.ts): the blocking startup reminder renders the rest of the shell
		// inert, so it is dismissed before any role-based landmark assertion — and again after the
		// reload, which re-arms it.
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		const sdkHostRequests: string[] = []
		page.on("request", req => {
			if (SDK_HOST_RE.test(new URL(req.url()).hostname)) {
				sdkHostRequests.push(req.url())
			}
		})

		await page.reload()
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

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
		await page.goto("/")
		// The authed shell raises a blocking startup reminder modal that renders the rest of the app
		// inert/aria-hidden until dismissed — while it is open the shell's own nav is not even in the role
		// tree, so it must be dismissed BEFORE any role-based shell assertion or interaction below, not
		// just before the Account click. This spec drives the shell directly (never through the listing
		// gate that dismisses it), so it dismisses per tab here.
		await dismissStartupReminders(page)
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()

		// A second, already-signed-in tab opened BEFORE logout — the realistic multi-tab scenario the
		// auth broadcast channel exists to keep coherent. The once-per-page marker lives in localStorage,
		// which is shared across the context, so this second call is a no-op: `second` renders authed
		// because the first seed already persisted the session into the shared kv. What matters is that
		// neither page re-seeds on its post-logout reload, so both converge onto the wiped kv state.
		const second = await context.newPage()

		await seedOncePerPage(second, session)
		await second.goto("/")
		await dismissStartupReminders(second)
		await expect(second.getByRole("navigation", { name: "Filen" })).toBeVisible()

		await page.getByRole("button", { name: "Account", exact: true }).click()
		await page.getByRole("menuitem", { name: "Sign out", exact: true }).click()
		await page.getByRole("button", { name: "Sign out", exact: true }).click() // the confirm dialog's own action button

		await expect(page.getByText("Sign in to Filen")).toBeVisible()

		// kvHas, not kvGet: the session key holds an OBJECT (StringifiedClient), not a plain string, so
		// kvGet's stringSchema would report "null" whether the row is genuinely gone or merely the wrong
		// shape for that schema — kvHas checks existence directly, independent of shape.
		const sessionStillPresent = await page.evaluate(() => window.__filenE2E.kvHas("sdk.session.v1"))
		expect(sessionStillPresent).toBe(false)

		// The second tab's own worker still holds its own live client; reloading is what re-reads the
		// now-empty shared kv (seedOncePerPage's marker means this reload does NOT re-seed) and
		// converges it onto sign-in too.
		await second.reload()
		await expect(second.getByText("Sign in to Filen")).toBeVisible()

		await second.close()
	})
})
