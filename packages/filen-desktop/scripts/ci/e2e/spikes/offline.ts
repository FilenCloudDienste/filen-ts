import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { DesktopLockStatus } from "@filen/shared/desktop"
import { errorMessage, fail, powershellBounded, psQuote, runBounded, type BoundedResult } from "../../support.ts"
import type { Target } from "../../targets.ts"
import { desktop, unlockThroughScreen } from "../app.ts"
import type { Chain } from "../chains/common.ts"
import { START_TIMEOUT_MS } from "../update.ts"

// Spike `offline`: can N be taken offline on a hosted runner without touching anyone else's network, and what does it
// do then? Inside chain P, after the update and before the sign-out: N's own processes lose the network (Linux: N runs
// with the group filen-e2e and an iptables owner rule rejects that group's packets; macOS: the same group and a pf
// anchor matching it, the app's pf states killed; Windows: a firewall rule on Filen.exe), and the spike measures how
// long until its pairs are offline, whether attention stays off, whether open connections break, an edit made
// meanwhile, then how long until the pairs recover and the edit uploads once the block is lifted. Everything is
// information; only a harness error fails. The block is lifted whatever happens. Every tool runs bounded.

const GROUP = "filen-e2e"
const RULE = "filen-e2e-offline"
const PF_ANCHOR = "com.apple/filen-e2e"
const TOOL_TIMEOUT_MS = 60_000
const CAP_MS = 5 * 60 * 1000
const QUEUE_MS = 2 * 60 * 1000
const POLL_MS = 2000
// When the open connections are listed again during a live drop.
const CONNECTIONS_AGAIN_MS = 60_000

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

		for (const remote of remotes) {
			await tool("sudo", ["pfctl", "-q", "-k", "0.0.0.0/0", "-k", remote])
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

const windowsBlock: OfflineBlock = {
	via: null,
	prepare: async () => "nothing to prepare: the rule matches Filen.exe",
	async block(target) {
		const profiles = await powershellBounded('Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.Enabled)" }', TOOL_TIMEOUT_MS)

		profilesBefore = profiles.stdout.trim().split(/\r?\n/).join(",")

		const script = [
			"$ErrorActionPreference = 'Stop'",
			// A rule only applies where its profile's firewall is on.
			"Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True",
			`New-NetFirewallRule -Name ${psQuote(RULE)} -DisplayName ${psQuote(RULE)} -Direction Outbound -Program ${psQuote(target.executable)} -Action Block -Profile Any | Out-Null`
		].join("; ")
		const result = await powershellBounded(script, TOOL_TIMEOUT_MS)

		if (result.status !== 0) {
			fail(`firewall rule: ${output(result)}`)
		}

		return `profiles before: ${profilesBefore}; outbound block on ${target.executable}, every profile on`
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
			[`Remove-NetFirewallRule -Name ${psQuote(RULE)} -ErrorAction SilentlyContinue`, restore].filter(part => part !== "").join("; "),
			TOOL_TIMEOUT_MS
		)

		profilesBefore = null

		return `rule removed, profiles restored (${output(result)})`
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

interface Sample {
	at: number
	phases: string
	offline: number
	pairs: number
	lastErrors: number
	attention: boolean
	rail: string
}

export interface OfflineProbeOptions {
	pairs: readonly { name: string; id: string; localRoot: string }[]
	// The pair the offline edit goes into, and its cloud directory.
	editPair: string
	editCloudDir: string
	pin: string
}

// The probe; each measurement is a finding of its own, as information.
export async function runOfflineProbe(chain: Chain, block: OfflineBlock, options: OfflineProbeOptions): Promise<void> {
	const { findings, target } = chain
	const ids = new Set(options.pairs.map(pair => pair.id))
	const pids = async () =>
		(await chain.os.appProcesses(target)).map(line => Number(line.split(" ")[0])).filter(pid => Number.isInteger(pid) && pid > 0)
	let attentionSeen: string[] = []
	// Every distinct "<pair>: <halted> <lastError>" seen, in order.
	const errorsSeen: string[] = []

	const sample = async (): Promise<Sample> => {
		const overview = await chain.syncOverview()
		const mine = overview.pairs.filter(pair => ids.has(pair.id))
		// The rail's group label carries the sync and mounts status the tray shows (filen-web railGroup.tsx).
		const rail =
			(await chain
				.page()
				.locator('[aria-label^="Computer"]')
				.first()
				.getAttribute("aria-label", { timeout: 5000 })
				.catch(() => null)) ?? "?"
		const attention = rail.includes("attention")

		if (attention && !attentionSeen.includes(rail)) {
			attentionSeen = [...attentionSeen, rail]
		}

		for (const pair of mine) {
			const seen = `${pair.name}: ${pair.halted ?? "not halted"}, ${pair.lastError ?? "no lastError"}`

			if ((pair.lastError !== null || pair.halted !== null) && !errorsSeen.includes(seen)) {
				errorsSeen.push(seen)
			}
		}

		return {
			at: Date.now(),
			phases: mine.map(pair => `${pair.name}:${pair.phase}${pair.lastError === null ? "" : "(lastError)"}`).join(", "),
			offline: mine.filter(pair => pair.phase === "offline").length,
			pairs: mine.length,
			lastErrors: mine.filter(pair => pair.lastError !== null).length,
			attention,
			rail
		}
	}

	// The first sample satisfying `done` within `capMs`, or null with the last one.
	const watch = async (capMs: number, done: (sample: Sample) => boolean): Promise<{ hit: Sample | null; last: Sample }> => {
		const deadline = Date.now() + capMs
		let last = await sample()

		while (!done(last) && Date.now() < deadline) {
			await sleep(POLL_MS)
			last = await sample()
		}

		return { hit: done(last) ? last : null, last }
	}

	const seconds = (from: number, to: number) => `${((to - from) / 1000).toFixed(1)} s`
	const describe = (sample: Sample) => `${sample.phases}; rail "${sample.rail}"`

	// N through `via` (null: as the chain starts it), unlocked; the drive N mounts is reachable only by its own group.
	const relaunch = async (what: string, via: readonly string[] | null): Promise<void> => {
		chain.launchVia = via
		await chain.quit(what)
		await chain.connect()

		const lock = await desktop<DesktopLockStatus>(chain.page(), "window.desktop.lock.status()")

		if (lock.locked) {
			await unlockThroughScreen(chain.page(), options.pin, START_TIMEOUT_MS)
		}
	}

	await findings.check("offline spike: the probe ran (harness errors only)", async () => {
		try {
			if (block.via !== null) {
				await relaunch("N-before-offline", block.via)
			}

			findings.info("offline: before the block", `${describe(await sample())}; ${await block.connections(await pids())}`)

			const blocked = Date.now()

			findings.info("offline: block", await block.block(target, await pids()))
			findings.info("offline: right after the block", await block.connections(await pids()))

			let first: Sample | null = null
			const allOffline = (current: Sample) => {
				first ??= current.offline > 0 ? current : null

				return current.offline === current.pairs
			}
			let reached = await watch(CONNECTIONS_AGAIN_MS, allOffline)

			if (reached.hit === null) {
				findings.info(
					`offline: ${seconds(0, CONNECTIONS_AGAIN_MS)} into the block`,
					`${describe(reached.last)}; ${await block.connections(await pids())}`
				)
				reached = await watch(CAP_MS - CONNECTIONS_AGAIN_MS, allOffline)
			}

			findings.info(
				"offline: live drop",
				`${first === null ? "no pair offline" : `first pair offline after ${seconds(blocked, (first as Sample).at)}`}; ${
					reached.hit === null
						? `not every pair offline within ${seconds(0, CAP_MS)}`
						: `every pair offline after ${seconds(blocked, reached.hit.at)}`
				}; ${describe(reached.last)}; ${await block.connections(await pids())}`
			)

			// Windows: a rule may leave open connections alone; the next launch then meets it from its first request.
			if (first === null && target.platform === "win") {
				await chain.quit("N-offline-restart")
				await chain.connect()

				const lock = await desktop<DesktopLockStatus>(chain.page(), "window.desktop.lock.status()")

				if (lock.locked) {
					await unlockThroughScreen(chain.page(), options.pin, START_TIMEOUT_MS)
				}

				const restarted = Date.now()

				reached = await watch(CAP_MS, current => current.offline === current.pairs)
				findings.info(
					"offline: fallback, a launch with the block in place",
					`${reached.hit === null ? `not every pair offline within ${seconds(0, CAP_MS)}` : `every pair offline after ${seconds(restarted, reached.hit.at)}`}; ${describe(reached.last)}`
				)
			}

			// The edit made while offline.
			const pair = options.pairs.find(candidate => candidate.name === options.editPair) ?? fail(`no pair ${options.editPair}`)
			const name = `offline-${randomBytes(4).toString("hex")}.txt`
			const edited = Date.now()

			writeFileSync(path.join(pair.localRoot, name), `${name}\n`)

			const queued = await watch(QUEUE_MS, current => current.phases.includes(`${pair.name}:offline`))
			const inCloud = async () => (await chain.cloud.list(options.editCloudDir, false))?.some(item => item.path === name) === true

			findings.info(
				"offline: an edit while offline",
				`${name}: ${queued.hit === null ? `${pair.name} not offline within ${seconds(0, QUEUE_MS)}` : `${pair.name} offline ${seconds(edited, queued.hit.at)} after the edit`}; ${
					(await inCloud()) ? "already in the cloud (not queued)" : "not in the cloud (queued)"
				}; ${describe(queued.last)}`
			)

			findings.info("offline: lift", await block.lift())

			const lifted = Date.now()
			let recovered: Sample | null = null
			let cleared: Sample | null = null
			let uploadedAt: number | null = null
			const deadline = lifted + CAP_MS

			while (Date.now() < deadline && (recovered === null || cleared === null || uploadedAt === null)) {
				const current = await sample()

				recovered ??= current.offline === 0 ? current : null
				cleared ??= current.lastErrors === 0 ? current : null

				if (uploadedAt === null && (await inCloud())) {
					uploadedAt = Date.now()
				}

				await sleep(POLL_MS)
			}

			const end = await sample()

			findings.info(
				"offline: reconnect",
				[
					recovered === null ? "a pair still offline" : `no pair offline after ${seconds(lifted, (recovered as Sample).at)}`,
					cleared === null ? "a lastError left" : `every lastError cleared after ${seconds(lifted, (cleared as Sample).at)}`,
					uploadedAt === null
						? `${name} not uploaded within ${seconds(0, CAP_MS)}`
						: `${name} uploaded after ${seconds(lifted, uploadedAt)}`,
					describe(end)
				].join("; ")
			)
			findings.info(
				"offline: attention over the probe",
				attentionSeen.length === 0 ? "never (the rail stayed neutral)" : attentionSeen.join(" | ")
			)
			findings.info("offline: halts and lastError texts over the probe", errorsSeen.join(" | ") || "none")

			return "measured (see the offline findings)"
		} catch (error) {
			fail(`harness: ${errorMessage(error)}`)
		} finally {
			findings.info("offline: lifted in the end", await block.lift().catch(errorMessage))

			// The chain goes on with N as it starts it: the group's drive is out of the harness's reach (FUSE lets only
			// the mounting user and group in).
			if (block.via !== null) {
				await relaunch("N-after-offline", null)
				findings.info("offline: N started again without the wrapper", "connected")
			}
		}
	})
}
