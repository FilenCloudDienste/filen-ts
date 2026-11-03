import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage, fail } from "../../support.ts"
import type { Chain } from "../chains/common.ts"
import {
	appPids,
	createSampler,
	describeSample as describe,
	POLL_MS,
	relaunchThrough,
	type OfflineBlock,
	type Sample,
	seconds
} from "../offlineBlock.ts"

// Spike `offline`: can N be taken offline on a hosted runner without touching anyone else's network, and what does it
// do then? Inside chain P, after the update and before the sign-out: N's own processes lose the network (Linux: N runs
// with the group filen-e2e and an iptables owner rule rejects that group's packets; macOS: the same group and a pf
// anchor matching it, the app's pf states killed; Windows: firewall rules on Filen.exe and rclone.exe), and the spike
// measures how long until its pairs are offline, whether attention stays off, whether open connections break, an edit
// made meanwhile, then how long until the pairs recover and the edit uploads once the block is lifted. Everything is
// information; only a harness error fails. The block is lifted whatever happens. Every tool runs bounded.

const CAP_MS = 5 * 60 * 1000
const QUEUE_MS = 2 * 60 * 1000
// When the open connections are listed again during a live drop.
const CONNECTIONS_AGAIN_MS = 60_000

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
	const sampler = createSampler(chain, new Set(options.pairs.map(pair => pair.id)))
	const { sample, watch } = sampler
	const pids = () => appPids(chain)
	const relaunch = (what: string, via: readonly string[] | null) => relaunchThrough(chain, what, via, options.pin)

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
				await relaunch("N-offline-restart", null)

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
				sampler.attentionSeen().length === 0 ? "never (the rail stayed neutral)" : sampler.attentionSeen().join(" | ")
			)
			findings.info("offline: halts and lastError texts over the probe", sampler.errorsSeen().join(" | ") || "none")

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
