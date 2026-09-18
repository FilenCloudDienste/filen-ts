import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

// Playwright does not auto-load .env; load the local credentials file explicitly. Node >= 24 ships
// process.loadEnvFile, which throws when the file is missing — tolerated here because CI supplies the
// same variables (FILEN_WEB_E2E_TEST_EMAIL / FILEN_WEB_E2E_TEST_PASSWORD) directly from repository
// secrets, and contributors without credentials simply run the SDK-free subset.
try {
	process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url)))
} catch {
	// no local .env — credentials come from the environment (or the authed specs skip)
}

const PORT = 4173
const BASE_URL = `http://localhost:${String(PORT)}`

// Lane membership is decided by ONE question: does the spec take the account-wide `drive-write` lock?
// (Verified per file by grepping for enterScratchDirectory / createDirectoryViaDialog / setInputFiles /
// createTestFile / trashScratchDirectory, then reading each hit.) That lock is a SERVER-SIDE LEASE with
// a client keep-alive — the wasm carries `v3/user/lock`, the resource name `drive-write`, and
// `Refreshed lock` — and the SDK's write path waits for it with unbounded patience and no error (it
// polls ~8640 times on a fibonacci backoff capped at 30s, which is forever in any practical sense).
// Two consequences shape everything below: a browser context killed mid-write stops refreshing its
// lease but does NOT release it, so it blocks every other client until the TTL expires; and one such
// orphaned lease cascades, because the next test to want the lock also hangs, also gets killed, and
// orphans another.
//
// READ_SPECS therefore is not a performance tier — it is the set that CANNOT take the lock, and so can
// neither be starved by it nor orphan one. Those get real concurrency and retries. Everything that
// writes gets bounded concurrency and NO retries: a retried write re-runs its creates and uploads
// against an account that is, by the very fact of the first failure, already contended.
//
// Most of this lane's newer members (downloads, drive-marquee, preview-media, preview-media-formats,
// thumbnails) are here because they no longer PROVISION anything: they read a shared, read-only
// fixture tree the fixtures-setup project builds once (e2e/helpers/fixtures.ts), instead of each test
// creating a scratch directory and uploading its own files. Provisioning was the only reason those
// specs ever took the lock.
const READ_SPECS =
	/\/(auth|boot|contacts|downloads|drive|drive-marquee|keymap|narrow-viewport|no-coi|no-opfs|preview-media|preview-media-formats|public-links|register|reset|settings|shell|shortcuts|storage|sw-version|thumbnails)\.spec\.ts$/
// Own surfaces, own limits: notes hits the free plan's 10-note cap, chats the conversation-create rate
// limiter. Neither touches the drive lock, but both race THEMSELVES, so each owns a serial lane.
const NOTES_SPEC = /\/notes\.spec\.ts$/
const CHATS_SPEC = /\/chats\.spec\.ts$/

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	// The OVERALL pool. On CI this is a 4-vCPU runner and every page carries a Chromium renderer plus
	// the SDK's own wasm thread pool (threadCount() = 2 there), so four pages already oversubscribe it.
	// A project's own `workers` is an UPPER BOUND inside this pool, not a reservation — hence the read
	// lane's CI cap of 2 below, which leaves the serial write lane a slot instead of starving it.
	workers: process.env["CI"] ? 3 : 6,
	forbidOnly: Boolean(process.env["CI"]),
	// Set PER LANE, not globally — see the READ_SPECS note above for why a retry is safe on a lane that
	// cannot take the drive lock and actively harmful on one that can.
	retries: 0,
	// Unconditional: a wedged LOCAL run holds the same shared account as a CI one and poisons the next
	// run, so both get the backstop. Expiry is not a clean stop — Playwright abandons the phase loop and
	// hands the cleanup runner the SAME already-expired deadline, so fixtures-teardown never runs and
	// the fixture root is left behind on the live account. That leak is bounded and self-healing: the
	// root is ONE row named `e2e-fixtures-<runId>`, which isScratchDebrisName's anchored `^(e2e-|…)`
	// matches, so the next run's cleanup sweep drains it and its whole subtree in a single round.
	//
	// NOT derived from the lane ceilings below, and it cannot be: chromium-write alone is serial over
	// 14 spec files at 900s each, more declared ceiling than any run budget could hold. Those are
	// per-test worst cases a healthy run never spends; this is the outer bound on the run as a whole.
	// The mandatory serial chain under it IS additive, though — 600s webServer + 120s auth-setup (suite
	// default) + 600s cleanup-setup + 900s fixtures-setup + 420s fixtures-teardown = 44 min of budget
	// before and after any spec at all.
	globalTimeout: 120 * 60_000,
	reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }], ["list"]] : [["html", { open: "never" }], ["list"]],
	// Covers auth-setup, firefox and webkit only — every real lane below sets its own. Kept tight all the
	// same: a write that hangs holds its test open for the whole budget, and the kill at the end of it
	// orphans a `drive-write` lease that blocks every later test (see the READ_SPECS note), so a generous
	// default turns one stuck write into a cascade. A slow CI runner is answered with fewer workers.
	timeout: 120_000,
	// Governs UI responsiveness only — a live write opts into LIVE_WRITE_TIMEOUT_MS at its own call
	// site (helpers/listing.ts), so this budget never has to cover the network.
	expect: { timeout: 10_000 },
	// The session blob is secret-equivalent; a trace would capture it as an addInitScript / evaluate
	// argument, so tracing stays off. Failure screenshots are an acceptable residual: the password
	// input always renders masked (screenshots capture pixels, not DOM values), and auth-setup /
	// auth.spec type only the dedicated e2e test account's email — never a customer's, never the
	// session blob.
	use: {
		baseURL: BASE_URL,
		trace: "off",
		screenshot: "only-on-failure",
		// Same reasoning as the screenshot above — pixels only, never DOM values or call arguments — and
		// far and away the best triage tool for a failure that only reproduces on CI.
		video: process.env["CI"] ? "retain-on-failure" : "off",
		// A cold authed boot is a wasm init + rayon pool spin-up + OPFS open + session resume; 30s is
		// several times the slowest observed CI boot, and bounded so a dead preview server says so.
		navigationTimeout: 30_000,
		// Bounded, not Playwright's unlimited default: an action whose target silently detaches
		// mid-interaction (a menu closed by a concurrent re-render) must FAIL with a diagnosable
		// actionability error, not absorb the whole test budget — a menu click once hung a 240s test
		// this way. Actionability is a LOCAL, in-page property: nothing legitimate waits a minute to
		// become clickable, and the old 60s only ever bought a slower path to the same error. Slow
		// STATE changes belong in expect polls / toPass envelopes, not action waits.
		actionTimeout: 15_000
	},
	projects: [
		{ name: "auth-setup", testMatch: /auth\.setup\.ts/ },
		// Self-cleaning sweep: removes every drive-root / trash / playlist item matching a retired e2e
		// scratch-name prefix before any spec project starts (see setup/cleanup.setup.ts). Depends on
		// auth-setup rather than duplicating its login, and every spec project below depends on THIS
		// instead of auth-setup directly — Playwright resolves the chain, so auth-setup still always runs
		// first. Generous timeout above even the suite default: a debris-heavy account is swept one item
		// per round across three surfaces, each with its own wall-clock budget — this is the outer bound
		// those budgets sit inside, not a target.
		{ name: "cleanup-setup", testMatch: /cleanup\.setup\.ts/, dependencies: ["auth-setup"], timeout: 600_000 },
		// Builds the ONE shared read-only fixture tree every non-provisioning spec reads from, and names
		// the project that removes it again (Playwright runs a `teardown` project after its owner AND
		// everything depending on that owner has finished, so nothing is still reading the tree when it
		// goes). Every chromium lane below depends on this — including the two that never touch the tree
		// (notes, chats), which costs them the setup's wall-clock but guarantees the teardown cannot fire
		// while any chromium spec is still live on the account. Same generous timeout as cleanup-setup:
		// it does a dozen-odd creates and every upload the suite needs, serially, in one context.
		{
			name: "fixtures-setup",
			testMatch: /fixtures\.setup\.ts/,
			dependencies: ["cleanup-setup"],
			teardown: "fixtures-teardown",
			// Above cleanup-setup's own: this budget has to cover the root create's bounded retries (the
			// stale-lease case, see fixtures.setup.ts) AND the whole serial build after them.
			timeout: 900_000
		},
		// Above what the single trash can actually burn, because a KILL here is the expensive outcome: it
		// orphans the `drive-write` lease the trash was holding AND skips the catch that names the leaked
		// root for the next run's sweep. The worst case is 30s goto + trashScratchDirectory (30s
		// overlay-reload fallback + 15s sidebar click + 30s settle + 15s row poll + 170s selectAndTrashRow,
		// whose confirm wait this caller widens to 120s for a root holding 13 subdirectories and 26 files)
		// = 290s. It runs once per run, so the headroom costs a healthy run nothing.
		{ name: "fixtures-teardown", testMatch: /fixtures\.teardown\.ts/, timeout: 420_000 },
		// Cannot take the drive lock, so it can neither starve nor orphan one: real concurrency, and a
		// retry here is a genuine transient-infra retry rather than a second write against an account
		// the first attempt already left contended.
		{
			name: "chromium-read",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["fixtures-setup"],
			testMatch: READ_SPECS,
			workers: process.env["CI"] ? 2 : 5,
			// ONE retry, not two. This is the only lane that retries at all and it carries most of the
			// suite, so it is also where the signal is weakest: at two retries a test that passes one run
			// in three still reports green. One absorbs a single blip against the live account while a
			// genuine break still has to fail both attempts.
			retries: process.env["CI"] ? 1 : 0,
			// The suite default is 120s because a kill there orphans a `drive-write` lease — a rationale
			// that does not apply to this lane at all, nothing here takes the lock. What does apply is the
			// other half of it: a wait has to be able to reach its OWN pin and name what it was waiting
			// for, instead of being cut off by a harness kill that names nothing. Several specs here pin
			// past 120s unaided, because entering the shared fixture tree is itself expensive: one entry
			// declares 30s goto + 30s settle + TWO descents (each 30s row + 30s descendInto retry envelope
			// + 10s breadcrumb + 30s settle) + 30s settle = 290s.
			//
			// 480s, rather than a ceiling sized off the single most expensive spec in the lane: it holds
			// that 290s preamble with a body's worth of headroom left over for the five specs that read the
			// tree (downloads, drive-marquee, preview-media, preview-media-formats, thumbnails), while the
			// other fifteen here never touch it and would only inherit dead headroom — and none of those
			// waits is spent on a healthy run, each closes on a rendered row. A spec whose own pinned waits
			// need more says so with test.setTimeout, where the cost is visible in the file —
			// downloads.spec.ts (it enters the tree TWICE, so it pays the whole preamble again) and
			// preview-media-formats.spec.ts (two 60s pdf.js canvas renders on top of it) are the two that do.
			// A kill here costs the run wall clock, not the account's write lock — though with the retry
			// above, a systematically hung test costs it twice, which is what globalTimeout backstops.
			timeout: 480_000
		},
		// Everything that takes the drive lock, ONE worker. Writes serialise on the account-wide lease
		// regardless, so a second worker adds no throughput — it only contends: its writes queue behind
		// the first's, every extra in-flight write is one more lease a timeout can orphan, and a create
		// that loses the race wedges its dialog pending, which makes the page inert and leaves the
		// client blind past the SDK backoff's 22s mark. Serialised, the only hold a test ever waits out
		// is an orphaned lease's own 30s TTL, which every write budget here already covers — though what
		// a test actually WAITS is longer than that TTL: the SDK probes for the lease on a backoff that
		// is blind for long stretches, so a lease free at 30s is not noticed until the next probe.
		// Measured end to end, the first write after another context closed costs 35-72s (the method and
		// the numbers are in helpers/listing.ts's LIVE_WRITE_TIMEOUT_MS note).
		//
		// drive-search.spec.ts is a member like any other — it builds its own nested scratch tree, so it
		// takes the lock by the lane's own criterion — but it leans on the single worker for a second
		// reason. Subtree search opens the SDK's cache-search engine, whose convergence resync walks the
		// subtree under that same lock, yet acquires it BOUNDED and politely-yielding while every FS
		// write acquires it unboundedly. A CONCURRENT unbounded writer therefore starves the search
		// indefinitely: it never converges, the listing never leaves its searching state, and no
		// assertion ceiling can fix that because the starvation has no bound. `workers: 1` is exactly
		// the guarantee that there is never one. It used to sit in its own project depending on this
		// one, which bought that same guarantee plus one thing nobody wanted: Playwright does not
		// schedule a project whose dependency failed, so any single write failure silently dropped the
		// only live coverage the cache-search engine has.
		{
			name: "chromium-write",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["fixtures-setup"],
			testIgnore: [READ_SPECS, NOTES_SPEC, CHATS_SPEC],
			workers: 1,
			retries: 0,
			// Above the suite default because this lane, and only this lane, pays for the scratch directory
			// a live-write test brackets itself with — and BOTH ends have to fit inside one test. That is
			// not a comfort requirement: a test the harness KILLS never releases the lease it is holding,
			// which is the orphan this whole lane design exists to prevent, while a test that fails on an
			// assertion's own pin unwinds cleanly. So the ceiling has to sit above what those brackets can
			// burn on a contended account (helpers/listing.ts). Counting only the waits pinned at their own
			// call sites there:
			//
			//   create retry loop  338s = attempt 1 154s (30s settle + 120s pinned create wait + 4s dialog
			//                             probes) + attempt 2 169s (the same, plus the 15s adopt poll,
			//                             which is gated on attempt > 1) + 15s reload
			//   descent            130s = 30s row + 30s descendInto retry envelope + 10s breadcrumb
			//                             + 2 x 30s settle
			//   teardown           260s = 30s overlay-reload fallback + 15s sidebar click + 30s settle
			//                             + 15s row poll + 170s selectAndTrashRow envelope (40s
			//                             interaction + 120s confirm + 10s trailing row)
			//   -----------------------
			//                      728s, and all of it is reachable on a run that still PASSES: each of
			//                      those loops retries, so burning the whole envelope is a slow success,
			//                      not a failure.
			//
			// FOUR waits inside createDirectoryViaDialog are NOT pinned and are excluded above: the
			// "New directory" click, the name fill and the "Create" click each inherit the 15s
			// actionTimeout, and the dialog's own toBeVisible inherits the 10s expect default — +55s per
			// attempt, so the loop's literal ceiling is 448s and the total 838s. This budget deliberately
			// assumes they do not all expire: unlike the pinned waits, none of them closes on a live
			// account write. They are local actionability/visibility waits against a dialog the page has
			// already rendered, so a run that spends them is not slow, it is broken somewhere else.
			//
			// The old 120s held neither end, and the end it cut was the teardown — leaking the scratch
			// directory onto the shared account and reporting a timeout instead of the real failure; 300s
			// and then 480s held the brackets only by understating them, and 720s was derived when a create
			// attempt was pinned at 45s rather than at the measured cost of waiting out an orphaned lease.
			// What is left over above 728s is the test body's, and a body whose own pinned waits need more
			// says so with test.slow / test.setTimeout, where the cost is visible in the file.
			timeout: 900_000
		},
		// Serial lanes for the two surfaces that race THEMSELVES rather than the drive: notes against the
		// free plan's 10-note cap, chats against the conversation-create rate limiter. Neither takes the
		// drive lock, so neither is ordered after anything — but neither is it free of the lanes above:
		// they all draw on the one `workers` pool, so on CI, where that pool is 3 and the read lane caps
		// at 2, these two contend with the write lane for the remaining slot.
		// Both lanes below carry a derived ceiling for the same reason chromium-read and chromium-write
		// do: a test that outruns its budget is killed by the HARNESS, which names nothing and dies before
		// teardown — and here that strands notes against the free plan's 10-note cap. Their longest tests
		// declare far more than the 120s suite default: notes.spec's createAndOpenTestNote preamble alone
		// is ~175s of bounded waiting before a first assertion, and its history test pins ~555s on top.
		// Hence 600s, and the per-test test.setTimeout calls that papered over it can go.
		{
			name: "chromium-notes",
			timeout: 600_000,
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["fixtures-setup"],
			testMatch: NOTES_SPEC,
			workers: 1,
			retries: 0
		},
		{
			name: "chromium-chats",
			timeout: 600_000,
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["fixtures-setup"],
			testMatch: CHATS_SPEC,
			workers: 1,
			retries: 0
		},
		{
			// Verified empirically (login-free probe, real getDirectory()/SAH-pool open against this
			// exact Playwright build): Playwright's bundled Firefox has working OPFS-SAH storage, so it
			// boots the app — unlike webkit below. It does NOT run the full suite: every spec whose tests
			// need an authenticated SDK read is gated chromium-only in the test body (helpers/firefox.ts),
			// and each of those files is gated in ALL of its tests, so scoping the lane to the files that
			// actually have something to run here is exact rather than approximate. Without it firefox
			// built a browser context and installed the session init script for ~113 tests that then
			// skipped on their first line. A new spec opts in by being listed here.
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			dependencies: ["cleanup-setup"],
			testMatch: /\/(boot|keymap|no-coi|no-opfs|public-links|register|reset|shell|storage|sw)\.spec\.ts$/
		},
		{
			// Playwright's bundled WebKit cannot open OPFS-SAH storage (verified empirically: it
			// exposes navigator.storage.getDirectory, but calling it rejects with a generic
			// UnknownError) — with OPFS now a hard boot requirement, EVERY route boots straight to
			// /no-opfs, so webkit can never reach the `@no-sdk` app specs (shell/keymap/register/reset)
			// that need a real boot-to-ready. Real Safari 16.4+ has OPFS and works fine; this is a
			// Playwright-WebKit limitation only, the same story as its lack of SharedArrayBuffer —
			// scoped down to the capability-gate pages themselves (no-coi + no-opfs), which render
			// independently of whether the app can boot at all, so it still needs no auth-setup
			// dependency and stays runnable without credentials.
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			grep: /@capability/
		}
	],
	webServer: {
		// Build with the e2e hooks, then serve dist with the full COI + hardened-CSP header set. Dev
		// mode is CSP-exempt, so e2e always runs against preview.
		command: "pnpm run build && pnpm run preview",
		url: BASE_URL,
		reuseExistingServer: !process.env["CI"],
		// The command builds the app from scratch when no server is reused (always on CI) — a slow
		// runner needs real headroom for typecheck + vite build + preview boot before the first test.
		timeout: 600_000,
		env: {
			VITE_E2E: "1",
			NODE_OPTIONS: "--max-old-space-size=8192"
		}
	}
})
