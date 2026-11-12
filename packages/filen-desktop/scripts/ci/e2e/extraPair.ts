import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type {
	DesktopSyncLocalRootChoice,
	DesktopSyncMode,
	DesktopSyncPair,
	DesktopSyncPlan,
	DesktopSyncResult
} from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { errorMessage, fail, waitFor } from "../support.ts"
import { desktop, desktopCall, putOffKeysReminder, underReminder } from "./app.ts"
import { json, ok, type Chain } from "./chains/common.ts"
import { POLL_MS, type Sampler } from "./offlineBlock.ts"
import { CHOOSER_BUDGET_MS } from "./os.ts"

// What the checks that bring a pair of their own share (chains/diskFullCheck.ts, cloudFullCheck.ts): the pair added
// as a user adds one (the native folder chooser, the dry run released, started), read, synced on request and removed
// again; a background watch of the sampler that remembers every offline, error and attention it saw; file hashes.

const CHOOSER_TITLE = "Choose a directory to sync"

export interface ExtraPair {
	name: string
	id: string
	localRoot: string
	remoteRoot: string
}

// The app's chooseLocalDirectory answered with `dir` through the OS's folder chooser; evidence files start with
// `evidence`. The app's call is raced against the driver: a call that answers without a directory (canceled, refused or
// failed) while the driver still waits for a dialog fails at once, since no dialog is coming. An ok answer can come
// before the driver saw its dialog close; the driver's own outcome then decides.
export async function chooseThrough(
	chain: Pick<Chain, "page" | "os">,
	dir: string,
	evidence: string
): Promise<Extract<DesktopSyncLocalRootChoice, { status: "ok" }>> {
	const choice = desktop<DesktopSyncLocalRootChoice>(chain.page(), "window.desktop.sync.chooseLocalDirectory()", CHOOSER_BUDGET_MS)
	const answered = choice.then(
		chosen => ({ chosen }),
		(error: unknown) => ({ error })
	)
	const driven = chain.os.chooseDirectory(CHOOSER_TITLE, dir, evidence).then(() => null)

	void driven.catch(() => undefined)

	const early = await Promise.race([
		driven,
		answered.then(answer => ("chosen" in answer && answer.chosen.status === "ok" ? driven : answer))
	])

	if (early !== null) {
		await chain.os.screenDump(`${evidence}-answered-early.png`)
		fail(
			`chooseLocalDirectory answered while the chooser still waited for its dialog: ${"chosen" in early ? json(early.chosen) : errorMessage(early.error)}`
		)
	}

	const answer = await answered

	if ("error" in answer) {
		await chain.os.screenDump(`${evidence}-no-answer.png`)

		throw answer.error
	}

	if (answer.chosen.status !== "ok") {
		fail(`chooseLocalDirectory: ${json(answer.chosen)} (the chooser's steps: ${path.basename(evidence)}-*.png)`)
	}

	return answer.chosen
}

// `remoteRoot` is the cloud directory's uuid. `record` learns of the pair as soon as it exists, so that a failed start
// still leaves it for removal.
export async function addPairThroughChooser(
	chain: Chain,
	pair: { name: string; mode: DesktopSyncMode; localRoot: string; remoteRoot: string },
	record?: (added: ExtraPair) => void
): Promise<ExtraPair> {
	const evidence = path.join(chain.artifacts, `${chain.name}-chooser-${pair.name}`)

	// The master-key reminder a relaunch brings back is modal over the window the panel opens on: put off when it shows.
	await putOffKeysReminder(chain.page(), 1000).catch((error: unknown) => console.log(`the master-key reminder: ${errorMessage(error)}`))

	const chosen = await chooseThrough(chain, pair.localRoot, evidence)

	const added = ok(
		"addPair",
		await desktop<DesktopSyncResult<{ pairId: string; plan: DesktopSyncPlan | null }>>(
			chain.page(),
			`window.desktop.sync.addPair(${json({ localRootId: chosen.id, remoteRoot: pair.remoteRoot, mode: pair.mode, name: pair.name })})`
		)
	)

	const result = { name: pair.name, id: added.pairId, localRoot: chosen.path, remoteRoot: pair.remoteRoot }

	record?.(result)

	if (added.plan !== null) {
		await desktopCall(chain.page(), `window.desktop.sync.releasePlan(${json(added.plan.planId)})`)
	}

	ok("startPair", await desktop<DesktopSyncResult<null>>(chain.page(), `window.desktop.sync.startPair(${json(added.pairId)})`))

	return result
}

export async function pairOf(chain: Chain, id: string): Promise<DesktopSyncPair> {
	return (await chain.syncOverview()).pairs.find(pair => pair.id === id) ?? fail(`pair ${id} is gone`)
}

// The pair once `done` holds for it, within `timeoutMs`; a failure names its last state.
export async function waitPair(
	chain: Chain,
	id: string,
	what: string,
	timeoutMs: number,
	done: (pair: DesktopSyncPair) => boolean
): Promise<DesktopSyncPair> {
	let last: DesktopSyncPair | null = null

	try {
		return await waitFor(what, timeoutMs, async () => {
			last = await pairOf(chain, id)

			return done(last) ? last : null
		})
	} catch (error) {
		fail(`${errorMessage(error)}; last: ${last === null ? "none" : describePair(last)}`)
	}
}

export function describePair(pair: DesktopSyncPair): string {
	return `${pair.name} ${pair.phase}, halted ${String(pair.halted)}, lastError ${pair.lastError ?? "none"}, issues ${json(pair.issues)}, degraded ${json(pair.degraded)}`
}

export async function syncNow(chain: Chain, id: string): Promise<void> {
	ok("syncNow", await desktop<DesktopSyncResult<null>>(chain.page(), `window.desktop.sync.syncNow(${json(id)})`))
}

export async function removePair(chain: Chain, id: string): Promise<string> {
	ok("removePair", await desktop<DesktopSyncResult<null>>(chain.page(), `window.desktop.sync.removePair(${json(id)})`))
	await waitFor(`pair ${id} to be removed`, 60_000, async () =>
		(await chain.syncOverview()).pairs.some(pair => pair.id === id) ? null : true
	)

	return `pair ${id} removed`
}

export function sha256File(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex")
}

export function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex")
}

// What a watch saw: the first sample of each kind, described, or null.
export interface Seen {
	samples: number
	offline: string | null
	error: string | null
	attention: string | null
	// Sampling failures (a page call that failed), counted.
	failed: number
}

export interface PairWatch {
	seen(): Seen
	stop(): Promise<Seen>
}

// Samples in the background every POLL_MS until stop(), remembering the first offline, error and attention.
export function watchPairs(sampler: Sampler): PairWatch {
	const seen: Seen = { samples: 0, offline: null, error: null, attention: null, failed: 0 }
	let running = true

	const loop = (async () => {
		while (running) {
			try {
				const sample = await sampler.sample()

				seen.samples++
				seen.offline ??= sample.offline > 0 ? sample.phases : null
				seen.error ??= sample.errors > 0 ? sample.phases : null
				seen.attention ??= sample.syncAttention ? sample.rail : null
			} catch {
				seen.failed++
			}

			await sleep(POLL_MS)
		}
	})()

	return {
		seen: () => ({ ...seen }),
		async stop() {
			running = false
			await loop

			return { ...seen }
		}
	}
}

// Fails when the watch saw any of `forbidden`; else says what it saw.
export function nothingSeen(seen: Seen, forbidden: readonly ("offline" | "error" | "attention")[]): string {
	const hits = forbidden.flatMap(kind => (seen[kind] === null ? [] : [`${kind}: ${seen[kind] ?? ""}`]))

	if (hits.length > 0) {
		fail(`seen ${hits.join("; ")}`)
	}

	return `no ${forbidden.join(", no ")} in ${String(seen.samples)} samples`
}

// The pair's Issues tab (filen-web issuesTab.tsx) as a user opens it: the rail's Computer group from the keyboard, its
// Sync item, the pair in the sync sidebar, Issues. Resolves once `text` shows there. The master-key reminder, modal
// over the shell, is put off whenever it covers a step.
export async function issuesShow(page: Page, pairName: string, text: string, timeoutMs: number): Promise<string> {
	const { value } = await underReminder(page, async () => {
		const computer = page.locator('[aria-label^="Computer"]').first()

		await computer.waitFor({ state: "visible", timeout: timeoutMs })
		await computer.focus()
		await page.keyboard.press("ArrowRight")
		await page.getByRole("menuitem", { name: /^Sync/ }).click({ timeout: timeoutMs })
		await page.locator('a[href*="/sync/"]').filter({ hasText: pairName }).first().click({ timeout: timeoutMs })
		await page.getByRole("link", { name: /^Issues/ }).click({ timeout: timeoutMs })
		await page.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs })

		return `the Issues tab says "${text}"`
	})

	return value
}
