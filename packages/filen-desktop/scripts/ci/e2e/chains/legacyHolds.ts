import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type {
	DesktopSyncHeldReason,
	DesktopSyncPair,
	DesktopSyncPhase,
	DesktopSyncPlan,
	DesktopSyncPlanAction,
	DesktopSyncPlanPage,
	DesktopSyncPlanSummary,
	DesktopSyncResult,
	DesktopSyncReview
} from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { desktop, desktopCall, underReminder } from "../app.ts"
import { type CloudEntry, runDir } from "../cloud.ts"
import { LEGACY_PAIRS, seededBytes } from "../fixtures.ts"
import { addLegacyPair } from "../legacyApp.ts"
import type { Findings } from "../findings.ts"
import { diffSnapshots, localSnapshot, type Snapshot } from "../snapshot.ts"
import { approveHeldThroughIssues, findingText, removeThroughNotice, startReviewThroughCard, syncText } from "../syncUi.ts"
import { json, LIVE_TIMEOUT_MS, ok, SETUP_TIMEOUT_MS, type Chain } from "./common.ts"

// Chain L's pairs that N's first run does not start on its own (plan D2, proving C2 and C4):
//   L16  review card         a file uploaded into e2e-l2c's cloud directory while 3.x is closed: a local-to-cloud pair
//                            whose first sync would delete it, so N holds the pair in review (heldDeletions,
//                            firstSyncWithDeletions). Through the page: the card's title and finding, its changes in ONE
//                            Show changes click, Start syncing, then the one held deletion approved in the Issues tab;
//                            the file leaves the cloud, the disk stays as it was
//   L17  whole-drive pair    a paused local-backup pair of the drive root, added to 3.x before it quits beside the five:
//                            N refuses it honestly (the notice offers Remove pair, never Start anyway). Removed through the
//                            notice; no hold left, the drive root's listing and the pair's local directory unchanged.
//                            No whole-drive pair is ever started
// Until each is in place (its setup step passed) the table below leaves its pair out, so L8, L9 and L10 expect the
// usual start.

export const CLOSED_UPLOAD = {
	pair: "e2e-l2c",
	path: "from-cloud-while-closed.txt",
	bytes: seededBytes("legacy/from-cloud-while-closed", 1500)
} as const
// The plan's actions are read this many at a time.
const PLAN_PAGE = 50

export const ROOT_PAIR = { name: "e2e-root", bytes: seededBytes("legacy/e2e-root", 900) } as const

// The whole-drive pair's one local file, named per run, job and chain (from the chain's cloud directory): an upload one
// run's pair left at the drive root never reads as another run's.
export function rootPairFile(cloudDir: string): string {
	return `root-local-${cloudDir.replace(/[^\w-]+/g, "-")}.txt`
}

// What is wrong with the dry run of a pair N's first run holds (L10), or null: its held deletions are the table's, with
// no conflict and no refusal, and every action (all of them listed) only adopts the baseline, moving no bytes.
export function heldPlanProblem(
	summary: DesktopSyncPlanSummary,
	actions: readonly DesktopSyncPlanAction[],
	want: Pick<FirstRunHold, "heldDeletions" | "heldReason">
): string | null {
	const ok =
		actions.length === summary.actions &&
		actions.every(action => action.kind === "adoptBaseline") &&
		summary.uploadBytes === 0 &&
		summary.downloadBytes === 0 &&
		summary.heldDeletions === want.heldDeletions &&
		summary.heldReason === want.heldReason &&
		summary.conflicts === 0 &&
		summary.refused === null

	return ok
		? null
		: `plan ${json(summary)}; ${String(actions.length)} actions listed: ${actions.map(action => `${action.kind} ${action.relPath}`).join(", ") || "none"}`
}

// How N's first run leaves a migrated pair it does not start.
export interface FirstRunHold {
	phase: DesktopSyncPhase
	paused: boolean
	review: Pick<DesktopSyncReview, "reason" | "findings">
	// Its dry run on N: the held deletions and why.
	heldDeletions: number
	heldReason: DesktopSyncHeldReason
}

// The one table L8, L9 and L10 read: per pair name, how its first run waits. Every other pair starts.
export const LEGACY_FIRST_RUN: Readonly<Record<string, FirstRunHold>> = {
	[CLOSED_UPLOAD.pair]: {
		phase: "review",
		paused: true,
		review: { reason: "migrated", findings: ["heldDeletions"] },
		heldDeletions: 1,
		heldReason: "firstSyncWithDeletions"
	}
}

// A pair as N's shell.json keeps it.
export interface ShellPairState {
	name: string
	pairId: string | null
	state: string
	review: unknown
	notices?: unknown
}

// Whether N's shell settled every migrated pair as expected: the held ones (`held`) in review, the refused ones
// (`refused`, never given to the engine) unsupported with the whole-drive notice, every other one active. A pair in
// review that the table does not expect fails at once.
export function firstRunSettled(
	pairs: readonly ShellPairState[] | undefined,
	held: ReadonlySet<string>,
	refused: ReadonlySet<string>
): boolean {
	const review = pairs?.find(pair => pair.state === "review" && !held.has(pair.name))

	if (review !== undefined) {
		fail(`${review.name} waits in review: ${json(review.review)}`)
	}

	return (
		pairs?.length === LEGACY_PAIRS.length + refused.size &&
		pairs.every(pair =>
			refused.has(pair.name)
				? pair.state === "unsupported" &&
					pair.pairId === null &&
					(pair.notices === undefined || (Array.isArray(pair.notices) && pair.notices.includes("refusedWholeDrive")))
				: pair.pairId !== null && pair.state === (held.has(pair.name) ? "review" : "active")
		)
	)
}

// What differs from how the table (`hold`, null for a pair it leaves out) says a pair waits after N's first run.
export function firstRunProblems(
	name: string,
	found: Pick<DesktopSyncPair, "phase" | "paused" | "review">,
	hold: FirstRunHold | null
): string[] {
	if (hold === null) {
		return [
			...(found.review === null ? [] : [`${name}: review ${json(found.review)}`]),
			...(found.phase === "idle" ? [] : [`${name}: ${found.phase}`])
		]
	}

	const review = found.review === null ? null : { reason: found.review.reason, findings: found.review.findings }

	return [
		...(json(review) === json(hold.review) ? [] : [`${name}: review ${json(found.review)}, expected ${json(hold.review)}`]),
		...(found.phase === hold.phase ? [] : [`${name}: ${found.phase}, expected ${hold.phase}`]),
		...(found.paused === hold.paused ? [] : [`${name}: paused ${String(found.paused)}`])
	]
}

// The drive root against its listing before N: every entry still there as it was, none added since named like a file
// of the whole-drive pair's local directory (`forbidden`). Other entries added since are other jobs' (information).
export function driveRootChanges(
	before: readonly CloudEntry[],
	after: readonly CloudEntry[],
	forbidden: readonly string[]
): { problems: string[]; added: string[] } {
	const now = new Map(after.map(entry => [entry.path, entry]))
	const then = new Set(before.map(entry => entry.path))

	return {
		problems: [
			...before.flatMap(entry => {
				const found = now.get(entry.path)

				return found === undefined
					? [`${entry.path} gone`]
					: found.id !== entry.id || found.isDir !== entry.isDir
						? [`${entry.path} replaced`]
						: []
			}),
			...after
				.filter(entry => !then.has(entry.path) && forbidden.includes(entry.path))
				.map(entry => `${entry.path} uploaded to the drive root`)
		],
		added: after.filter(entry => !then.has(entry.path) && !forbidden.includes(entry.path)).map(entry => entry.path)
	}
}

// `findings` is the chain's, as chain L records them (scripts/ci/e2e/chains/older.ts findingsFor).
export function legacyHolds(chain: Chain, findings: Findings = chain.findings) {
	const { cloud, cloudDir, work, rootOf, page } = chain
	const state: {
		uploaded: boolean
		l2cLocal?: Snapshot
		root?: { driveRoot: CloudEntry[]; local: Snapshot }
		// Set before 3.x is given the pair, so whatever it uploads is cleaned up even when the setup step fails after.
		rootFile?: string
	} = { uploaded: false }
	const hold = (name: string): FirstRunHold | null => (state.uploaded ? (LEGACY_FIRST_RUN[name] ?? null) : null)
	const refused = (): ReadonlySet<string> => new Set(state.root === undefined ? [] : [ROOT_PAIR.name])
	const overviewPair = async (name: string): Promise<DesktopSyncPair | undefined> =>
		(await chain.syncOverview()).pairs.find(pair => pair.name === name)

	return {
		// With 3.x running, before it quits: the whole-drive pair, paused (it never syncs there), beside the others.
		async addRootPair(legacyPage: Page): Promise<string> {
			const dir = rootOf(ROOT_PAIR.name)
			const file = rootPairFile(cloudDir)

			mkdirSync(dir, { recursive: true })
			writeFileSync(path.join(dir, file), ROOT_PAIR.bytes)

			const driveRoot = (await cloud.list("", false)) ?? fail("the drive root does not list")

			state.rootFile = file
			const count = await addLegacyPair(legacyPage, {
				uuid: randomUUID(),
				name: ROOT_PAIR.name,
				localPath: dir,
				remotePath: "/",
				remoteParentUUID: chain.remote.rootUuid,
				mode: "localBackup",
				excludeDotFiles: false,
				paused: true,
				localTrashDisabled: false
			})

			if (count !== LEGACY_PAIRS.length + 1) {
				fail(`the old config holds ${String(count)} pairs`)
			}

			state.root = { driveRoot, local: await localSnapshot(dir) }

			return `${ROOT_PAIR.name} (localBackup, paused) of the drive root; ${String(driveRoot.length)} entries at the drive root`
		},

		// With 3.x closed, before N's baseline: the cloud file e2e-l2c's first sync on N would delete.
		async uploadWhileClosed(): Promise<string> {
			const file = path.join(work, "closed-upload.txt")

			writeFileSync(file, CLOSED_UPLOAD.bytes)
			await cloud.uploadFile(file, `${cloudDir}/${CLOSED_UPLOAD.pair}/${CLOSED_UPLOAD.path}`)
			state.l2cLocal = await chain.snapshotOf(CLOSED_UPLOAD.pair)
			state.uploaded = true

			return `${CLOSED_UPLOAD.pair}/${CLOSED_UPLOAD.path} in the cloud only`
		},

		hold,
		// The pairs beside LEGACY_PAIRS that N's overview lists until L17 removes them.
		extraPairs: (): number => refused().size,
		shellSettled: (pairs: readonly ShellPairState[] | undefined): boolean =>
			firstRunSettled(pairs, new Set(Object.keys(LEGACY_FIRST_RUN).filter(name => hold(name) !== null)), refused()),

		// L10 for the held pairs: their dry run holds exactly the table's deletions and nothing else. A migrated pair held
		// in review never ran a pass on N, so its plan adopts the baseline (adoptBaseline rows) and moves no bytes.
		async heldPlans(pairIds: readonly { name: string; id: string }[]): Promise<string> {
			const problems: string[] = []
			const seen: string[] = []

			for (const { name, id } of pairIds) {
				const want = hold(name)

				if (want === null) {
					continue
				}

				const plan = ok(
					"plan",
					await desktop<DesktopSyncResult<DesktopSyncPlan | null>>(page(), `window.desktop.sync.plan(${json(id)})`)
				)

				if (plan === null) {
					problems.push(`${name}: no plan (the cloud side not read)`)

					continue
				}

				const actions: DesktopSyncPlanAction[] = []

				try {
					for (let offset = 0; offset < plan.summary.actions; offset += PLAN_PAGE) {
						const listed = ok(
							"planPage",
							await desktop<DesktopSyncResult<DesktopSyncPlanPage>>(
								page(),
								`window.desktop.sync.planPage(${json(plan.planId)}, "actions", ${String(offset)}, ${String(PLAN_PAGE)})`
							)
						)

						if (listed.list !== "actions" || listed.entries.length === 0) {
							break
						}

						actions.push(...listed.entries)
					}
				} finally {
					await desktopCall(page(), `window.desktop.sync.releasePlan(${json(plan.planId)})`)
				}

				const problem = heldPlanProblem(plan.summary, actions, want)

				if (problem !== null) {
					problems.push(`${name}: ${problem}`)
				}

				seen.push(
					`${name} holds ${String(plan.summary.heldDeletions)} (${String(plan.summary.heldReason)}), adopts ${String(actions.length)} baseline entries`
				)
			}

			if (problems.length > 0) {
				fail(problems.join("; "))
			}

			return seen.join("; ") || "no pair held"
		},

		// L16 and L17 through the page, signed in and unlocked on N.
		async run(pairIds: readonly { name: string; id: string }[]): Promise<void> {
			if (state.uploaded) {
				const name = CLOSED_UPLOAD.pair
				const want = LEGACY_FIRST_RUN[name] ?? fail(`no table entry for ${name}`)
				const id = pairIds.find(pair => pair.name === name)?.id ?? fail(`no pair ${name}`)
				const read = async () => (await chain.syncOverview()).pairs.find(pair => pair.id === id) ?? fail(`${name} is gone`)

				const started = await findings.check(
					`L16 ${name}'s review card: title, finding, its changes in one Show changes click; Start syncing (C4)`,
					async () => {
						const { value, putOff } = await underReminder(page(), () =>
							startReviewThroughCard(
								page(),
								name,
								{
									title: syncText("reviewTitleMigrated"),
									findings: want.review.findings.map(findingText),
									heldPath: CLOSED_UPLOAD.path
								},
								SETUP_TIMEOUT_MS
							)
						)
						const running = await waitFor(
							"the pair to run and its pass to hold the deletion",
							SETUP_TIMEOUT_MS,
							async () => {
								const current = await read()

								return !current.paused && current.review === null && current.issues.heldDeletions === want.heldDeletions
									? current
									: null
							},
							5000
						).catch(async (error: unknown) => fail(`${errorMessage(error)}: ${json(await read())}`))

						return `${value}; running, issues ${json(running.issues)}${putOff > 0 ? `; the reminder put off ${String(putOff)} time(s)` : ""}`
					}
				)

				if (started) {
					await findings.check(
						`L16 the held deletion approved through the Issues tab: gone from the cloud, the disk as it was`,
						async () => {
							await underReminder(page(), () => approveHeldThroughIssues(page(), name, false, SETUP_TIMEOUT_MS))
							await waitFor("the file to leave the cloud", LIVE_TIMEOUT_MS, async () =>
								(await cloud.list(`${cloudDir}/${name}`, false))?.some(entry => entry.path === CLOSED_UPLOAD.path) === false
									? true
									: null
							)
							await waitFor("no held deletion counted", SETUP_TIMEOUT_MS, async () =>
								(await read()).issues.heldDeletions === 0 ? true : null
							)

							const changed = diffSnapshots(state.l2cLocal ?? new Map(), await chain.snapshotOf(name), { identity: true })

							if (changed.length > 0) {
								fail(`the disk changed: ${changed.join("; ")}`)
							}

							return `${CLOSED_UPLOAD.path} gone from the cloud; ${name}'s directory unchanged on disk`
						}
					)
				}
			}

			const root = state.root
			const rootFile = state.rootFile

			if (root !== undefined && rootFile !== undefined) {
				await findings.check(
					`L17 the whole-drive pair is refused honestly: ${syncText("noticeRemove")}, never ${syncText("holdStartAnyway")} (C2); removed, no hold left, the drive root and its directory unchanged`,
					async () => {
						const before = (await overviewPair(ROOT_PAIR.name)) ?? fail(`no pair ${ROOT_PAIR.name}`)

						if (!before.notices.includes("refusedWholeDrive") || before.holds.length > 0 || before.phase !== "unsupported") {
							fail(`${ROOT_PAIR.name}: phase ${before.phase}, notices ${json(before.notices)}, holds ${json(before.holds)}`)
						}

						const { value } = await underReminder(page(), () =>
							removeThroughNotice(page(), ROOT_PAIR.name, "refusedWholeDrive", SETUP_TIMEOUT_MS)
						)
						const overview = await waitFor("the pair to be removed", SETUP_TIMEOUT_MS, async () => {
							const current = await chain.syncOverview()

							return current.pairs.some(pair => pair.name === ROOT_PAIR.name) ? null : current
						})
						const held = overview.pairs.filter(pair => pair.holds.length > 0).map(pair => `${pair.name} ${json(pair.holds)}`)
						const { problems, added } = driveRootChanges(root.driveRoot, (await cloud.list("", false)) ?? [], [rootFile])
						const local = diffSnapshots(root.local, await localSnapshot(rootOf(ROOT_PAIR.name)), { identity: true })

						if (held.length > 0 || problems.length > 0 || local.length > 0) {
							fail([...held.map(line => `hold: ${line}`), ...problems, ...local.map(line => `local ${line}`)].join("; "))
						}

						return `${value}; no hold left; every drive-root entry as before${added.length > 0 ? ` (added meanwhile, not by this pair: ${added.join(", ")})` : ""}; ${ROOT_PAIR.name}'s directory unchanged`
					}
				)
			}

			// Whatever uploaded the pair's file to the drive root (outside the swept directory), it is moved into this run's
			// directory, which the sweep removes. The check above already fails on it when it ran; this one when it did not.
			if (rootFile !== undefined) {
				const what = `L17 nothing of ${ROOT_PAIR.name} left at the drive root`
				const clear = async (): Promise<string> => {
					if ((await cloud.list("", false))?.some(entry => entry.path === rootFile) !== true) {
						return "nothing to clear"
					}

					await cloud.moveto(rootFile, `${runDir()}/drive-root-leftovers/${rootFile}`)

					return `${rootFile} was at the drive root; moved into ${runDir()}`
				}

				if (root === undefined) {
					await findings.check(what, async () => {
						const cleared = await clear()

						return cleared === "nothing to clear" ? cleared : fail(cleared)
					})
				} else {
					findings.info(what, await clear().catch(errorMessage))
				}
			}
		}
	}
}

export type LegacyHolds = ReturnType<typeof legacyHolds>
