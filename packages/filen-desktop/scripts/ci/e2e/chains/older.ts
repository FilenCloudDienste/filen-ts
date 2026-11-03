import { randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import type { DesktopMountsOverview, DesktopSyncOverview } from "@filen/shared/desktop"
import type { Page } from "playwright-core"
import { LEGACY_KEYS } from "../../../../src/main/legacyData.ts"
import { LEGACY_PIN, OLDER_PIN, type LegacyPin } from "../../legacy.ts"
import { fail, waitFor } from "../../support.ts"
import type { Findings } from "../findings.ts"
import { LEGACY_PAIRS } from "../fixtures.ts"
import type { LegacyOldShape, LegacySyncPair } from "../legacyApp.ts"
import type { DesktopOs } from "../os.ts"
import { LEGACY_SDK_CONFIG_SHAPE } from "../seed.ts"

// Gap 1 in chain L (scripts/ci/e2e/chains/legacy.ts): what older 3.x clients left behind, and chain L run from one.
//
// From 3.0.53 (free coverage, no extra run): two shapes clients before 3.0.39 stored are planted among the five pairs.
// One pair has neither `excludeDotFiles` nor `localTrashDisabled` (the old engine read both by truthiness: both off),
// and the sync config sits in desktopConfig only, without the account's entry in the per-user map (the old web fell
// back to desktopConfig then; 4.x's effectiveConfig and the stash's fallback). Another account's pair in that map
// must not come along (the fallback belongs to the account that was signed in).
//
// From 3.0.47 (scripts/ci/legacy.ts OLDER_PIN): L1-L10, L13 and L15-L17 with its inventory; L11, L12, L14 and the
// profile wipe test N alone, which chain L does from 3.0.53, and are recorded as not run. 3.0.47's web (0.1.87) turns
// the network drive off when it fails to start, so where it cannot mount N must import it off. On macOS its start waits
// on FUSE-T's administrator prompt instead, a known 3.0.47 limitation (FUSE_T_PROMPT_ISSUE): the drive stays on.

// The fixture pair stored without its two switches: both are off in its fixture, so every other expectation holds.
export const BARE_PAIR = "e2e-lbak"
// Another account's pair, in the sync map only.
export const OTHER_ACCOUNT_PAIR = "e2e-other-account"

// What a real 3.0.47 sign-in stores in sdkConfig: @filen/sdk 0.1.193's login over filen-web 0.1.87's signed-out config,
// which has no tmpPath (the seed builds the same from the page's own signed-out config; the real sign-in checks it).
export const OLDER_SDK_CONFIG_SHAPE: readonly string[] = LEGACY_SDK_CONFIG_SHAPE.filter(line => line !== "tmpPath: string")

export function sdkConfigShapeOf(pin: LegacyPin): readonly string[] {
	return pin === OLDER_PIN ? OLDER_SDK_CONFIG_SHAPE : LEGACY_SDK_CONFIG_SHAPE
}

// Checks that test N only and run in chain L from 3.0.53 (name prefixes).
export const OLDER_SKIPPED: readonly string[] = [
	"L11 ",
	"L12 ",
	"L14 ",
	"N quits after the profile wipe",
	"L15 the next launch deletes the browser profile",
	"L15 old profile entries"
]

// The chain's findings for a pin: from 3.0.53 as they are; from an older release the skipped checks recorded as
// information, and the attachments chain L names "legacy-..." under the chain's own name (both chains can share a job's
// artifacts).
export function findingsFor(findings: Findings, pin: LegacyPin, name: string): Findings {
	if (pin === LEGACY_PIN) {
		return findings
	}

	// Recorded instead of run; true when it was.
	const skipped = (check: string): boolean => {
		if (!OLDER_SKIPPED.some(prefix => check.startsWith(prefix))) {
			return false
		}

		findings.info(check, `not run from ${pin.version}: it tests N only, chain L runs it from ${LEGACY_PIN.version}`)

		return true
	}

	return {
		...findings,
		check: async (check, probe) => skipped(check) || findings.check(check, probe),
		must: async (check, probe) => (skipped(check) ? undefined : findings.must(check, probe)),
		known: async (check, issue, probe) => !skipped(check) && findings.known(check, issue, probe),
		attach: (file, text) => findings.attach(file.replace(/^legacy-/, `${name}-`), text)
	}
}

// The planted shapes (from 3.0.53 only): the bare pair, the sync config in desktopConfig only, and another account's
// pair in the map. That account is any id but this one.
export function plantedShape(pairs: readonly LegacySyncPair[], userId: bigint, localDir: string, cloudDir: string): LegacyOldShape {
	const bare = pairs.find(pair => pair.name === BARE_PAIR) ?? fail(`no pair ${BARE_PAIR}`)
	const other: LegacySyncPair = {
		uuid: randomUUID(),
		name: OTHER_ACCOUNT_PAIR,
		localPath: path.join(localDir, OTHER_ACCOUNT_PAIR),
		remotePath: `/${cloudDir}/${OTHER_ACCOUNT_PAIR}`,
		remoteParentUUID: randomUUID(),
		mode: "twoWay",
		excludeDotFiles: false,
		paused: false,
		localTrashDisabled: false
	}

	return {
		bare: [bare.uuid],
		fallbackOnly: ["syncConfig"],
		others: { syncConfig: { [String(userId + 1n)]: { enabled: true, syncPairs: [other], dbPath: "" } } }
	}
}

// The old page's sync settings as it holds them now: the per-user map and desktopConfig's syncConfig (no other section,
// so no WebDAV password), parsed; null where absent or unreadable.
export async function readPlanted(page: Page): Promise<{ sync: unknown; syncConfig: unknown }> {
	return (await page.evaluate(
		([desktopKey, syncKey]) => {
			const parse = (key: string): unknown => {
				try {
					return JSON.parse(localStorage.getItem(key) ?? "null")
				} catch {
					return null
				}
			}

			return { sync: parse(syncKey), syncConfig: (parse(desktopKey) as { syncConfig?: unknown } | null)?.syncConfig ?? null }
		},
		[LEGACY_KEYS.desktopConfig, LEGACY_KEYS.sync] as const
	)) as { sync: unknown; syncConfig: unknown }
}

// The planted shapes still there as the old app quits (its web may have written the account's entry back into the map
// or the switches into the pairs while it ran; its update launch after that is brief, its sync held): without this, L8's and L9's planted checks could pass on the plain
// shape. The account has no entry in the map, the other account's pair does; desktopConfig holds every fixture pair,
// the bare one without both switches.
export function plantedHeld(read: { sync: unknown; syncConfig: unknown }, userId: bigint, bareUuid: string): string {
	const map = read.sync !== null && typeof read.sync === "object" ? (read.sync as Record<string, { syncPairs?: unknown }>) : {}
	const other = map[String(userId + 1n)]?.syncPairs
	const pairs = (read.syncConfig as { syncPairs?: unknown } | null)?.syncPairs
	const stored = Array.isArray(pairs) ? (pairs as Record<string, unknown>[]) : []
	const bare = stored.find(pair => pair["uuid"] === bareUuid)
	const names = stored.map(pair => pair["name"])
	const problems = [
		...(String(userId) in map ? ["the account has an entry in the sync map"] : []),
		...(Array.isArray(other) && other.some(pair => (pair as { name?: unknown } | null)?.name === OTHER_ACCOUNT_PAIR)
			? []
			: [`the other account's pair is gone from the map (keys ${JSON.stringify(Object.keys(map))})`]),
		...LEGACY_PAIRS.filter(pair => !names.includes(pair.name)).map(pair => `${pair.name} is not in desktopConfig`),
		...(bare === undefined
			? []
			: ["excludeDotFiles", "localTrashDisabled"].filter(key => key in bare).map(key => `${BARE_PAIR} has ${key}`))
	]

	if (problems.length > 0) {
		fail(problems.join("; "))
	}

	return `the sync map without the account (keys ${Object.keys(map).join(", ")}), ${String(stored.length)} pairs in desktopConfig, ${BARE_PAIR} without both switches`
}

// L8, planted: every fixture pair came from desktopConfig alone, and the other account's did not (no pair, no root).
export function fallbackImported(overview: DesktopSyncOverview, localDir: string): string {
	const names = overview.pairs.map(pair => pair.name)
	const missing = LEGACY_PAIRS.map(pair => pair.name).filter(name => !names.includes(name))

	if (missing.length > 0 || names.includes(OTHER_ACCOUNT_PAIR) || existsSync(path.join(localDir, OTHER_ACCOUNT_PAIR))) {
		fail(
			`pairs ${JSON.stringify(names)}; ${OTHER_ACCOUNT_PAIR}'s root ${existsSync(path.join(localDir, OTHER_ACCOUNT_PAIR)) ? "created" : "absent"}`
		)
	}

	return `${String(LEGACY_PAIRS.length)} pairs from desktopConfig alone (no entry for the account in its map); the other account's pair neither imported nor created`
}

// L9, planted: the pair without the two switches imported both as off: no rule file in its root, no local-trash notice.
export function bareImported(overview: DesktopSyncOverview, root: string): string {
	const pair = overview.pairs.find(candidate => candidate.name === BARE_PAIR) ?? fail(`${BARE_PAIR} is missing`)
	const rules = existsSync(path.join(root, ".filenignore"))

	if (rules || pair.info.length > 0) {
		fail(`${rules ? "a .filenignore in its root" : "no rule file"}; info ${JSON.stringify(pair.info)}`)
	}

	return "excludeDotFiles off (no .filenignore), localTrashDisabled off (no localTrashNowOn)"
}

// The old page's network drive switch as its web reads it: the account's map entry, else desktopConfig's.
async function legacyDriveEnabled(page: Pick<Page, "evaluate">): Promise<boolean | null> {
	return (await page
		.evaluate(
			([desktopKey, sdkKey, driveKey]) => {
				const parse = (key: string): unknown => {
					try {
						return JSON.parse(localStorage.getItem(key) ?? "null")
					} catch {
						return null
					}
				}
				const userId = (parse(sdkKey) as { userId?: number } | null)?.userId ?? 0
				const own = (parse(driveKey) as Record<string, { enabled?: unknown }> | null)?.[String(userId)]
				const config = own ?? (parse(desktopKey) as { networkDriveConfig?: { enabled?: unknown } } | null)?.networkDriveConfig

				return typeof config?.enabled === "boolean" ? config.enabled : null
			},
			[LEGACY_KEYS.desktopConfig, LEGACY_KEYS.sdkConfig, LEGACY_KEYS.networkDrive] as const
		)
		.catch(() => null)) as boolean | null
}

// On macOS 3.0.47's drive start waits on FUSE-T's installer, which asks for an administrator; on a hosted runner
// nobody answers, so it neither mounts nor turns the drive off.
export const FUSE_T_PROMPT_ISSUE =
	"3.0.47 on macOS: its network drive's start waits on FUSE-T's administrator prompt, which nobody answers here, so it never turns the drive off (a 3.0.47 limitation; N imports the drive as configured)"

// 3.0.47's drive once its start settled: mounted, or turned off by its web (where it cannot mount, that is the
// expected outcome, a check). Waits at most `timeoutMs`; neither by then is the outcome too (its start still hangs:
// the drive stays configured, as 3.0.53's does where it cannot mount, and N gets it on); on macOS that hang is
// FUSE_T_PROMPT_ISSUE, recorded as known.
export async function olderDrive(
	page: Pick<Page, "evaluate">,
	os: Pick<DesktopOs, "legacyDriveLive" | "driveMounted">,
	root: string,
	findings: Findings,
	timeoutMs: number,
	platform: NodeJS.Platform = process.platform
): Promise<{ off: boolean; detail: string }> {
	const outcome = await waitFor(
		"3.0.47's network drive to mount or turn off",
		timeoutMs,
		async () => {
			const mounted = await os.driveMounted(root)

			if (mounted !== null) {
				return { mounted: true, off: false, detail: `${mounted} mounted` }
			}

			return (await legacyDriveEnabled(page)) === false
				? { mounted: false, off: true, detail: "turned off by its web after its start failed" }
				: null
		},
		5000
	).catch(() => ({ mounted: false, off: false, detail: "neither mounted nor turned off: its start still runs" }))

	if (os.legacyDriveLive) {
		if (!outcome.mounted) {
			fail(`the drive did not mount here: ${outcome.detail}`)
		}
	} else {
		const check = `${OLDER_PIN.version} turns its network drive off where it cannot mount`
		const probe = (): string => {
			if (!outcome.off) {
				fail(outcome.detail)
			}

			return outcome.detail
		}

		if (platform === "darwin" && !outcome.off) {
			await findings.known(check, FUSE_T_PROMPT_ISSUE, probe)
		} else {
			await findings.check(check, probe)
		}
	}

	return { off: outcome.off, detail: outcome.detail }
}

// L5 where 3.0.47 had turned its drive off: N imported it off, and nothing is mounted at its mount point.
export async function driveImportedOff(overview: () => Promise<DesktopMountsOverview>, os: DesktopOs, root: string): Promise<string> {
	const drive = (await overview()).drive
	const mounted = await os.driveMounted(root)

	if (drive.enabled || drive.state === "running" || mounted !== null) {
		fail(`${JSON.stringify(drive)}; ${mounted ?? "nothing"} mounted at ${root}`)
	}

	return `off, as ${OLDER_PIN.version} left it; nothing mounted at ${root}`
}

// L15: nothing of Filen beside its userData after the sign-out and the uninstall (<appData>/@filen/<entry>): neither the
// old logs nor 3.0.47's network-drive directory (its rclone, rclone.conf with its local WebDAV bridge's credentials and
// monitor scripts), which N deletes once the migration verified.
export function leftoversBeside(userData: string): string {
	const dir = path.dirname(userData)
	const left = existsSync(dir) ? readdirSync(dir).filter(entry => entry !== path.basename(userData)) : []

	if (left.length > 0) {
		fail(`${dir} also holds ${left.join(", ")}`)
	}

	return `nothing beside ${path.basename(userData)}`
}

// L6: 3.0.47's network-drive directory (@filen/network-drive 0.9.x's platformConfigPath(), beside userData) is gone.
export function legacyNetworkDriveGone(userData: string): string {
	const dir = path.join(path.dirname(userData), "network-drive")

	if (existsSync(dir)) {
		fail(`${dir} is still there`)
	}

	return `${dir} gone`
}
