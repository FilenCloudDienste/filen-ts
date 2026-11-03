import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import path from "node:path"
import { errorMessage, fail, waitFor } from "../../support.ts"
import { addPairThroughChooser, describePair, pairOf, removePair, sha256, sha256File, type ExtraPair, waitPair } from "../extraPair.ts"
import { fixtureTree, seededBytes, treeSnapshot, writeTree } from "../fixtures.ts"
import { createSampler } from "../offlineBlock.ts"
import { createSmallVolume, SMALL_VOLUME_MIB, type SmallVolume } from "../smallVolume.ts"
import { diffSnapshots, localSnapshot } from "../snapshot.ts"
import type { Chain } from "./common.ts"

// P13: the local disk full. A remoteToLocal pair in a directory of a small volume of its own (smallVolume.ts), a filler
// beside the pair that leaves less room than a new cloud file needs, then that file in the cloud:
//   halted      the pair halts with localStorageFull, in error, and the sync status asks for attention
//   no damage   no partial file and no download temp (*.filendl) anywhere on the volume, the pair's files unchanged
//   recovery    with the filler deleted (and no syncNow), the file lands byte for byte within 3 minutes
//   cleanup     the pair removed and the volume gone
// N runs as the chain started it; nothing here signs in.

const MIB = 1024 * 1024
const PAIR = "e2e-diskfull"
// Left free beside the filler, and the cloud file that does not fit in it.
const LEFT_BYTES = 4 * MIB
const BIG_BYTES = 12 * MIB
const BIG = "big.bin"
const CONVERGE_MS = 3 * 60 * 1000
const HALT_MS = 3 * 60 * 1000
const RECOVER_MS = 3 * 60 * 1000
const TMP_SUFFIX = ".filendl"

function tempFiles(root: string): string[] {
	return existsSync(root) ? readdirSync(root, { recursive: true, encoding: "utf8" }).filter(entry => entry.endsWith(TMP_SUFFIX)) : []
}

// `bytes` of zeros in 1 MiB writes (no buffer of the whole size).
function writeFiller(file: string, bytes: number): void {
	const block = Buffer.alloc(MIB)
	const fd = openSync(file, "w")

	try {
		for (let left = bytes; left > 0; left -= MIB) {
			writeSync(fd, block, 0, Math.min(MIB, left))
		}
	} finally {
		closeSync(fd)
	}
}

export async function runDiskFullCheck(chain: Chain): Promise<void> {
	const { findings, cloud, target } = chain
	const cloudDir = `${chain.cloudDir}/${PAIR}`
	const tree = fixtureTree(`previous/${PAIR}`, false)
	const big = seededBytes(`previous/${PAIR}/${BIG}`, BIG_BYTES)
	// Set inside the checks that make them.
	const made: { volume?: SmallVolume; pair?: ExtraPair } = {}

	await findings.check("P13 a small volume of its own", async () => {
		const volume = await createSmallVolume(target.platform, path.join(chain.work, "small-volume"))

		made.volume = volume

		return `${volume.description}, ${String(Math.round(volume.free() / MIB))} MiB free`
	})

	const small = made.volume

	if (small === undefined) {
		return
	}

	const root = path.join(small.root, PAIR)
	const filler = path.join(small.root, "filler.bin")

	try {
		await findings.check("P13 a remoteToLocal pair on it, in sync", async () => {
			const seed = path.join(chain.work, "seed", PAIR)

			writeTree(seed, tree)
			await cloud.upload(seed, cloudDir)
			mkdirSync(root, { recursive: true })
			const { id } = (made.pair = await addPairThroughChooser(chain, {
				name: PAIR,
				mode: "remoteToLocal",
				localRoot: root,
				remoteRoot: await cloud.dirId(cloudDir)
			}))

			await waitPair(chain, id, `${PAIR} to converge`, CONVERGE_MS, found => found.phase === "idle" && found.lastSyncedAt !== null)
			await waitFor(`${PAIR} to hold the tree`, CONVERGE_MS, async () =>
				diffSnapshots(treeSnapshot(tree), await localSnapshot(root), { identity: false }).length === 0 ? true : null
			)

			return `pair ${id} at ${root}`
		})
		const extra = made.pair

		if (extra === undefined) {
			return
		}

		const before = await localSnapshot(root)
		const sampler = createSampler(chain, new Set([extra.id]))

		await findings.check("P13 the disk full: halted localStorageFull, in error, attention; no partial file", async () => {
			const room = small.free()

			// A volume whose free figure is not its own (a quota not applied) would have the filler fill the disk it lives on.
			if (room > SMALL_VOLUME_MIB * MIB) {
				fail(`the volume reports ${String(room)} bytes free, more than its ${String(SMALL_VOLUME_MIB)} MiB`)
			}

			writeFiller(filler, Math.max(0, room - LEFT_BYTES))

			const free = small.free()

			if (free >= BIG_BYTES) {
				fail(`${String(free)} bytes still free after the filler`)
			}

			const local = path.join(chain.work, BIG)

			writeFileSync(local, big)
			await cloud.uploadFile(local, `${cloudDir}/${BIG}`)
			sampler.reset()

			const halted = await waitPair(
				chain,
				extra.id,
				`${PAIR} to halt on the full disk`,
				HALT_MS,
				found => found.halted === "localStorageFull" && found.phase === "error"
			)
			const attention = await sampler.watch(30_000, sample => sample.syncAttention)

			if (attention.hit === null) {
				fail(`the rail did not ask for attention: "${attention.last.rail}" (${describePair(halted)})`)
			}

			const problems = [
				...(existsSync(path.join(root, BIG)) ? [`${BIG} is on disk`] : []),
				...tempFiles(small.root).map(file => `download temp ${file} left`),
				...diffSnapshots(before, await localSnapshot(root), { identity: true }).map(line => `pair ${line}`)
			]

			if (problems.length > 0) {
				fail(problems.join("; "))
			}

			return `${String(Math.round(free / MIB))} MiB free for a ${String(BIG_BYTES / MIB)} MiB file: ${describePair(halted)}; rail "${attention.hit.rail}"; nothing partial, the pair's files unchanged`
		})

		await findings.check("P13 the filler deleted: the file lands byte for byte within 3 min, no syncNow", async () => {
			rmSync(filler, { force: true })

			const freed = Date.now()

			await waitPair(chain, extra.id, `${PAIR} to recover`, RECOVER_MS, found => found.halted === null && found.phase === "idle")

			const landed = await waitFor(`${BIG} on disk`, Math.max(5000, freed + RECOVER_MS - Date.now()), () =>
				existsSync(path.join(root, BIG)) && tempFiles(small.root).length === 0 ? true : null
			).catch(() => false)

			if (!landed) {
				fail(`${BIG} not on disk: ${describePair(await pairOf(chain, extra.id))}`)
			}

			if (sha256File(path.join(root, BIG)) !== sha256(big)) {
				fail(`${BIG} differs from the cloud's`)
			}

			return `landed ${String(Math.round((Date.now() - freed) / 1000))} s after the filler went, byte for byte`
		})
	} finally {
		if (made.pair !== undefined) {
			findings.info("P13 the pair removed", await removePair(chain, made.pair.id).catch(errorMessage))
		}

		rmSync(filler, { force: true })
		await findings.check("P13 the volume removed", async () => {
			const removed = await small.remove()

			if (await small.mounted()) {
				fail(`${small.root} is still mounted (${removed})`)
			}

			return removed
		})
		await cloud.purge(cloudDir).catch((error: unknown) => console.log(`cleanup: ${errorMessage(error)}`))
	}
}
