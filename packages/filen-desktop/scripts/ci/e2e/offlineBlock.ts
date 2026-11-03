import { userInfo } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopLockStatus, DesktopSyncPair } from "@filen/shared/desktop"
import { fail, powershellBounded, psQuote, runBounded, type BoundedResult } from "../support.ts"
import type { Target } from "../targets.ts"
import { desktop, unlockThroughScreen } from "./app.ts"
import type { Chain } from "./chains/common.ts"
import { START_TIMEOUT_MS } from "./update.ts"

// Taking N offline on a hosted runner without touching anyone else's network: N's own processes lose it (Linux: N runs
// with the group filen-e2e and an iptables owner rule rejects that group's packets off the loopback interface; macOS:
// the same group and a pf anchor matching it, the app's pf states killed; Windows: firewall rules on Filen.exe and the
// bundled rclone.exe). The loopback interface stays open (its debugging port, WebDAV, the drive). Used by chain P's P11
// and the offline spike. Every tool runs bounded.

const GROUP = "filen-e2e"
const RULE = "filen-e2e-offline"
const PF_ANCHOR = "com.apple/filen-e2e"
const TOOL_TIMEOUT_MS = 60_000

export interface OfflineBlock {
	// The command N is started through (null: as it is).
	readonly via: readonly string[] | null
	// Before N starts through `via`.
	prepare(): Promise<string>
	block(target: Target, pids: readonly number[]): Promise<string>
	// Idempotent; also after a failed or partial block.
	lift(): Promise<string>
	// N's established connections off the loopback interface, as the OS lists them.
	connections(pids: readonly number[]): Promise<string>
}

function output(result: BoundedResult): string {
	const status = result.timedOut ? "timed out" : `exit ${String(result.status)}`

	return `${status} ${result.stdout.trim()} ${result.stderr.trim()}`.trim()
}

async function tool(command: string, args: readonly string[], input?: string): Promise<BoundedResult> {
	return runBounded(command, args, TOOL_TIMEOUT_MS, input === undefined ? {} : { input })
}

// Runs and fails by name on a non-zero exit.
async function must(command: string, args: readonly string[], input?: string): Promise<string> {
	const result = await tool(command, args, input)

	if (result.status !== 0) {
		fail(`${command} ${args.join(" ")}: ${output(result)}`)
	}

	return output(result)
}

const user = userInfo().username
const sudoVia = ["sudo", "-E", "-u", user, "-g", GROUP, "--"] as const

// Packets of the group's sockets leaving by any interface but the loopback (its debugging port, WebDAV and drive stay).
const IPTABLES_RULES: readonly (readonly string[])[] = [
	[
		"!",
		"-o",
		"lo",
		"-m",
		"owner",
		"--gid-owner",
		GROUP,
		"-p",
		"tcp",
		"-m",
		"comment",
		"--comment",
		RULE,
		"-j",
		"REJECT",
		"--reject-with",
		"tcp-reset"
	],
	["!", "-o", "lo", "-m", "owner", "--gid-owner", GROUP, "-m", "comment", "--comment", RULE, "-j", "REJECT"]
]

const linuxBlock: OfflineBlock = {
	via: sudoVia,
	async prepare() {
		await must("sudo", ["groupadd", "-f", GROUP])
		await must("sudo", ["usermod", "-aG", GROUP, user])

		return `group ${GROUP} with ${user}`
	},
	async block() {
		const done: string[] = []

		for (const table of ["iptables", "ip6tables"]) {
			for (const [index, rule] of IPTABLES_RULES.entries()) {
				await must("sudo", [table, "-I", "OUTPUT", String(index + 1), ...rule])
			}

			done.push(table)
		}

		return `${done.join(" and ")}: OUTPUT rejects group ${GROUP} off lo (TCP with a reset)`
	},
	async lift() {
		const removed: string[] = []

		for (const table of ["iptables", "ip6tables"]) {
			for (const rule of IPTABLES_RULES) {
				// Inserted once per block; a few rounds cover a repeated block.
				for (let round = 0; round < 3 && (await tool("sudo", [table, "-D", "OUTPUT", ...rule])).status === 0; round++) {
					removed.push(table)
				}
			}
		}

		return `${String(removed.length)} rules removed`
	},
	async connections(pids) {
		// As root: the app's processes run with another group, and ss names a socket's process only where it may look.
		const listed = await tool("sudo", ["ss", "-tnpH", "state", "established"])
		const peers = listed.stdout
			.split("\n")
			.filter(line => pids.some(pid => line.includes(`pid=${String(pid)},`)))
			// Columns: Recv-Q Send-Q Local Peer Process.
			.map(line => line.trim().split(/\s+/)[3] ?? "?")
			.filter(peer => !/^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer))

		return perRemote(peers)
	}
}

// pf's token from `pfctl -E`, released on lift so pf goes back to how the runner had it.
let pfToken: string | null = null

const macBlock: OfflineBlock = {
	via: sudoVia,
	async prepare() {
		if ((await tool("dscl", [".", "-read", `/Groups/${GROUP}`])).status !== 0) {
			await must("sudo", ["dseditgroup", "-o", "create", "-q", GROUP])
		}

		await must("sudo", ["dseditgroup", "-o", "edit", "-a", user, "-t", "user", GROUP])

		return `group ${GROUP} with ${user}`
	},
	async block(_target, pids) {
		const enabled = await tool("sudo", ["pfctl", "-E"])

		pfToken = /Token\s*:\s*(\d+)/.exec(`${enabled.stdout}\n${enabled.stderr}`)?.[1] ?? null
		// The system ruleset, which holds the com.apple anchors, then the group's rule in one of them.
		await must("sudo", ["pfctl", "-q", "-f", "/etc/pf.conf"])
		await must(
			"sudo",
			["pfctl", "-q", "-a", PF_ANCHOR, "-f", "-"],
			`block return out quick on ! lo0 proto { tcp udp } group ${GROUP}\n`
		)

		// The app's open connections already have states that pass them; killed so their next packet meets the rule.
		const remotes = await macRemotes(pids)

		for (const kill of pfStateKills(remotes)) {
			await tool("sudo", ["pfctl", "-q", ...kill])
		}

		return `pf ${pfToken === null ? "enabled (no token)" : `enabled (token ${pfToken})`}; ${PF_ANCHOR} blocks group ${GROUP} off lo0; states to ${String(remotes.length)} remote addresses killed`
	},
	async lift() {
		const flushed = await tool("sudo", ["pfctl", "-q", "-a", PF_ANCHOR, "-F", "all"])
		const released = pfToken === null ? null : await tool("sudo", ["pfctl", "-q", "-X", pfToken])

		pfToken = null

		return `anchor flushed (${output(flushed)}); ${released === null ? "no token to release" : `token released (${output(released)})`}`
	},
	async connections(pids) {
		return perRemote(await macRemotes(pids, false))
	}
}

// pfctl -k arguments killing every state from any local address to each remote, in the remote's own address family
// (pfctl skips a source and destination of different families: an IPv4 source kills no state to an IPv6 remote).
export function pfStateKills(remotes: readonly string[]): string[][] {
	return remotes.map(remote => ["-k", remote.includes(":") ? "::/0" : "0.0.0.0/0", "-k", remote])
}

// How long the block may take to take a running N's pairs offline: a blocked connection fails at once (a reset) on
// Linux, Windows and macOS on arm64.
export const LIVE_OFFLINE_MS = 30_000

// The remote ends of N's established TCP connections off the loopback interface: addresses only (distinct), or
// address:port per connection.
async function macRemotes(pids: readonly number[], addressOnly = true): Promise<string[]> {
	if (pids.length === 0) {
		return []
	}

	const listed = await tool("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-a", "-p", pids.join(",")])
	const remotes = listed.stdout
		.split("\n")
		.map(line => /->(\[?[^\]\s]+?\]?):(\d+)\s/.exec(line))
		.filter(match => match !== null)
		.map(match => ({ address: (match[1] ?? "").replace(/^\[|\]$/g, ""), port: match[2] ?? "" }))
		.filter(remote => !remote.address.startsWith("127.") && remote.address !== "::1")
		.map(remote => (addressOnly ? remote.address : `${remote.address}:${remote.port}`))

	return addressOnly ? [...new Set(remotes)] : remotes
}

// Connections counted per remote end: "3 established off loopback: a:443 x2, b:443".
function perRemote(peers: readonly string[]): string {
	const counts = new Map<string, number>()

	for (const peer of peers) {
		counts.set(peer, (counts.get(peer) ?? 0) + 1)
	}

	const listed = [...counts].map(([peer, count]) => (count > 1 ? `${peer} x${String(count)}` : peer))

	return `${String(peers.length)} established off loopback${listed.length > 0 ? `: ${listed.join(", ")}` : ""}`
}

// The firewall profiles as the runner had them, put back on lift.
let profilesBefore: string | null = null

// One outbound rule per program N runs: Filen.exe (main, helpers, the native host) and the drive's rclone.exe, which
// the group and owner rules elsewhere catch as N's child but a Windows rule matches by program only.
const WINDOWS_RULES = [RULE, `${RULE}-rclone`] as const

export function windowsFirewallRules(executable: string): { name: string; program: string }[] {
	return [
		{ name: WINDOWS_RULES[0], program: executable },
		{ name: WINDOWS_RULES[1], program: path.win32.join(path.win32.dirname(executable), "resources", "rclone", "rclone.exe") }
	]
}

const windowsBlock: OfflineBlock = {
	via: null,
	prepare: async () => "nothing to prepare: the rules match Filen.exe and rclone.exe",
	async block(target) {
		const profiles = await powershellBounded('Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled)" }', TOOL_TIMEOUT_MS)

		profilesBefore = profiles.stdout.trim().split(/\r?\n/).join(",")

		const rules = windowsFirewallRules(target.executable)
		const script = [
			"$ErrorActionPreference = 'Stop'",
			// A rule only applies where its profile's firewall is on.
			"Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True",
			...rules.map(
				rule =>
					`New-NetFirewallRule -Name ${psQuote(rule.name)} -DisplayName ${psQuote(rule.name)} -Direction Outbound -Program ${psQuote(rule.program)} -Action Block -Profile Any | Out-Null`
			)
		].join("; ")
		const result = await powershellBounded(script, TOOL_TIMEOUT_MS)

		if (result.status !== 0) {
			fail(`firewall rules: ${output(result)}`)
		}

		return `profiles before: ${profilesBefore}; outbound block on ${rules.map(rule => rule.program).join(" and ")}, every profile on`
	},
	async lift() {
		const restore =
			profilesBefore === null
				? ""
				: profilesBefore
						.split(",")
						.map(entry => entry.split("="))
						.filter(([name, enabled]) => name !== undefined && name !== "" && enabled !== undefined)
						.map(
							([name, enabled]) =>
								`Set-NetFirewallProfile -Profile ${name ?? ""} -Enabled ${enabled === "True" ? "True" : "False"}`
						)
						.join("; ")
		const result = await powershellBounded(
			[...WINDOWS_RULES.map(name => `Remove-NetFirewallRule -Name ${psQuote(name)} -ErrorAction SilentlyContinue`), restore]
				.filter(part => part !== "")
				.join("; "),
			TOOL_TIMEOUT_MS
		)

		profilesBefore = null

		return `rules removed, profiles restored (${output(result)})`
	},
	async connections(pids) {
		if (pids.length === 0) {
			return "no process"
		}

		const result = await powershellBounded(
			`Get-NetTCPConnection -State Established -OwningProcess ${pids.join(",")} -ErrorAction SilentlyContinue | Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1$)' } | ForEach-Object { "$($_.RemoteAddress):$($_.RemotePort)" }`,
			TOOL_TIMEOUT_MS
		)

		return perRemote(
			result.stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line !== "")
		)
	}
}

export function offlineBlockFor(target: Target): OfflineBlock {
	return target.platform === "linux" ? linuxBlock : target.platform === "mac" ? macBlock : windowsBlock
}

export const POLL_MS = 2000

export interface Sample {
	at: number
	phases: string
	offline: number
	// Pairs whose pass waits for the cloud directory's listing (phase "waitingForCloud").
	waiting: number
	// Pairs in phase "error".
	errors: number
	pairs: number
	lastErrors: number
	// The rail's group label carries the sync and mounts status the tray shows (filen-web railGroup.tsx).
	rail: string
	syncAttention: boolean
}

export interface Sampler {
	sample(): Promise<Sample>
	// The first sample satisfying `done` within `capMs`, or null with the last one.
	watch(capMs: number, done: (sample: Sample) => boolean): Promise<{ hit: Sample | null; last: Sample }>
	// Every distinct rail label with attention, and every distinct "<pair>: <halted>, <lastError>", seen so far.
	attentionSeen(): readonly string[]
	errorsSeen(): readonly string[]
	// Starts both lists over.
	reset(): void
}

// A sample of `pairs` (this check's, in the overview's order) with the rail label read at `at`.
export function sampleOf(pairs: readonly DesktopSyncPair[], rail: string, at: number): Sample {
	return {
		at,
		phases: pairs.map(pair => `${pair.name}:${pair.phase}${pair.lastError === null ? "" : "(lastError)"}`).join(", "),
		offline: pairs.filter(pair => pair.phase === "offline").length,
		waiting: pairs.filter(pair => pair.phase === "waitingForCloud").length,
		errors: pairs.filter(pair => pair.phase === "error").length,
		pairs: pairs.length,
		lastErrors: pairs.filter(pair => pair.lastError !== null).length,
		rail,
		syncAttention: rail.includes("Sync, needs attention")
	}
}

export function createSampler(chain: Chain, pairIds: ReadonlySet<string>): Sampler {
	let attention: string[] = []
	let errors: string[] = []

	const sample = async (): Promise<Sample> => {
		const overview = await chain.syncOverview()
		const mine = overview.pairs.filter(pair => pairIds.has(pair.id))
		const rail =
			(await chain
				.page()
				.locator('[aria-label^="Computer"]')
				.first()
				.getAttribute("aria-label", { timeout: 5000 })
				.catch(() => null)) ?? "?"

		if (rail.includes("attention") && !attention.includes(rail)) {
			attention = [...attention, rail]
		}

		for (const pair of mine) {
			const seen = `${pair.name}: ${pair.halted ?? "not halted"}, ${pair.lastError ?? "no lastError"}`

			if ((pair.lastError !== null || pair.halted !== null) && !errors.includes(seen)) {
				errors = [...errors, seen]
			}
		}

		return sampleOf(mine, rail, Date.now())
	}

	return {
		sample,
		async watch(capMs, done) {
			const deadline = Date.now() + capMs
			let last = await sample()

			while (!done(last) && Date.now() < deadline) {
				await sleep(POLL_MS)
				last = await sample()
			}

			return { hit: done(last) ? last : null, last }
		},
		attentionSeen: () => attention,
		errorsSeen: () => errors,
		reset() {
			attention = []
			errors = []
		}
	}
}

export function describeSample(sample: Sample): string {
	return `${sample.phases}; ${String(sample.waiting)} of ${String(sample.pairs)} waiting for the cloud; rail "${sample.rail}"`
}

export function seconds(from: number, to: number): string {
	return `${((to - from) / 1000).toFixed(1)} s`
}

// N's processes (helpers and rclone included).
export async function appPids(chain: Chain): Promise<number[]> {
	return (await chain.os.appProcesses(chain.target))
		.map(line => Number(line.split(" ")[0]))
		.filter(pid => Number.isInteger(pid) && pid > 0)
}

// N quit and started through `via` (null: as the chain starts it), unlocked with `pin` when it starts locked. The drive
// N mounts through a wrapper is reachable only by the wrapper's group (FUSE admits the mounting user and group only),
// so a chain goes on with N started plainly.
export async function relaunchThrough(chain: Chain, what: string, via: readonly string[] | null, pin: string): Promise<void> {
	await chain.quit(what)
	await startThrough(chain, via, pin)
}

// N started through `via` (null: as the chain starts it), unlocked with `pin` when it starts locked.
export async function startThrough(chain: Chain, via: readonly string[] | null, pin: string): Promise<void> {
	chain.launchVia = via
	await chain.connect()

	const lock = await desktop<DesktopLockStatus>(chain.page(), "window.desktop.lock.status()")

	if (lock.locked) {
		await unlockThroughScreen(chain.page(), pin, START_TIMEOUT_MS)
	}
}
