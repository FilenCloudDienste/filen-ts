import * as Comlink from "comlink"
import { InFlight } from "@filen/shared"
import { kvDelete, kvGetJson } from "@/lib/storage/adapter"
import { kvSetJsonQuiet } from "@/lib/storage/kvBestEffort"
import { log } from "@/lib/log"
import { rangeReads, type RangeReadBudget } from "@/lib/media/rangeReads"
import { holdRemuxWorker } from "@/lib/media/remuxClient"
import type { EdgeAnalysis, WindowPermits } from "@/lib/media/remuxTypes"
import { analysisRemuxSource } from "@/lib/media/playback/sources"
import type { GetTrackEdges, SourceRoute, TrackEdges, TrackEdgesRequestOptions } from "@/features/audio/lib/smoothTransitions.types"
import {
	EDGE_ANALYSIS_RANK,
	edgesFromRecord,
	toEdgesRecord,
	trackEdgesKey,
	trackEdgesRecordSchema,
	type TrackEdgesRecord
} from "@/features/audio/lib/trackEdges.logic"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// A track's smart edges, analysed once per file, ever: first from memory (the current and next tracks, a few more),
// then from its kv row, else (for the incoming track only) measured in the remux worker over the file's head and
// tail windows, each read behind every other background read. Only the file as it is (a direct route) is analysed: a
// transcode would run a second decoder beside playback's, and a MediaSource session is not mixed.

// Tracks kept in memory: the current one, the next, and the few before them a "previous" returns to.
const MEMORY_TRACKS = 8

export interface TrackEdgesDeps {
	readRecord: (uuid: string) => Promise<TrackEdgesRecord | null>
	writeRecord: (uuid: string, record: TrackEdgesRecord) => void
	deleteRecord: (uuid: string) => Promise<void>
	// The worker's answer; rejects when the bytes did not arrive or the signal aborted. Called once the first
	// window's permit is held; each window takes one from `permits`.
	analyze: (track: QueueTrack, signal: AbortSignal, permits: WindowPermits) => Promise<EdgeAnalysis>
	reads: Pick<RangeReadBudget, "acquire" | "release">
	now: () => number
}

// One analysis in flight, shared by every caller that wants it; it is called off once none of them does.
interface Analysis {
	promise: Promise<TrackEdges | null>
	controller: AbortController
	holders: number
}

function analysisRank(): number {
	return EDGE_ANALYSIS_RANK
}

// A call rather than a property read: it changes across awaits.
function isAborted(signal: AbortSignal): boolean {
	return signal.aborted
}

// One analysis's range-read permits, a window at a time. The first is taken before the worker is asked (so it is
// not woken to wait behind covers) and goes to the first window; every one still held is given back when the
// analysis ends, however it ends, and one granted after that is given back at once.
class AnalysisPermits implements WindowPermits {
	private readonly reads: TrackEdgesDeps["reads"]
	private held = 0
	private primed = false
	private closed = false

	public constructor(reads: TrackEdgesDeps["reads"]) {
		this.reads = reads
	}

	public async prime(): Promise<void> {
		await this.acquire()
		this.primed = true
	}

	public async acquire(): Promise<void> {
		if (this.primed) {
			this.primed = false

			return
		}

		await this.reads.acquire(analysisRank)

		if (this.closed) {
			this.reads.release()

			throw new DOMException("analysis ended", "AbortError")
		}

		this.held++
	}

	public release(): void {
		if (this.held === 0) {
			return
		}

		this.held--
		this.reads.release()
	}

	public close(): void {
		this.closed = true
		this.primed = false

		while (this.held > 0) {
			this.release()
		}
	}
}

export class TrackEdgesService {
	private readonly deps: TrackEdgesDeps
	// Map order is the LRU order, oldest first.
	private readonly memory = new Map<string, TrackEdges>()
	private readonly lookups = new InFlight<string, TrackEdges | null>()
	private readonly analyses = new Map<string, Analysis>()
	// Bumped by reset, so nothing that settles after logout is remembered or written.
	private epoch = 0

	public constructor(deps: TrackEdgesDeps) {
		this.deps = deps
	}

	// Never rejects: null when nothing is known.
	public async get(
		track: QueueTrack,
		route: SourceRoute,
		signal: AbortSignal,
		options: TrackEdgesRequestOptions = {}
	): Promise<TrackEdges | null> {
		if (signal.aborted) {
			return null
		}

		const remembered = this.memory.get(track.uuid)

		if (remembered !== undefined) {
			this.remember(track.uuid, remembered)

			return remembered
		}

		const stored = await this.lookups.coalesce(track.uuid, () => this.load(track.uuid))

		if (isAborted(signal)) {
			return null
		}

		if (stored !== null || options.cachedOnly === true || route !== "direct") {
			return stored
		}

		return await this.join(track, signal)
	}

	// Logout: every analysis is called off and memory forgotten; the kv rows go with the kv wipe itself.
	public reset(): void {
		this.epoch++
		this.memory.clear()

		for (const analysis of this.analyses.values()) {
			analysis.controller.abort()
		}

		this.analyses.clear()
	}

	public async delete(uuids: readonly string[]): Promise<void> {
		for (const uuid of uuids) {
			this.memory.delete(uuid)
		}

		await Promise.all(uuids.map(uuid => this.deps.deleteRecord(uuid).catch(() => undefined)))
	}

	private remember(uuid: string, edges: TrackEdges): void {
		this.memory.delete(uuid)
		this.memory.set(uuid, edges)

		for (const oldest of this.memory.keys()) {
			if (this.memory.size <= MEMORY_TRACKS) {
				break
			}

			this.memory.delete(oldest)
		}
	}

	private async load(uuid: string): Promise<TrackEdges | null> {
		const epoch = this.epoch
		const record = await this.deps.readRecord(uuid).catch((error: unknown) => {
			log.warn("audio", "stored track edges could not be read", error)

			return null
		})
		const edges = record === null ? null : edgesFromRecord(record)

		if (edges !== null && epoch === this.epoch) {
			this.remember(uuid, edges)
		}

		return edges
	}

	private join(track: QueueTrack, signal: AbortSignal): Promise<TrackEdges | null> {
		const analysis = this.analyses.get(track.uuid) ?? this.start(track)

		analysis.holders++

		return new Promise(resolve => {
			let left = false
			const leave = (edges: TrackEdges | null): void => {
				if (left) {
					return
				}

				left = true
				signal.removeEventListener("abort", onAbort)
				analysis.holders--

				// The last caller gone: an analysis still running is called off (one that settled is unaffected).
				if (analysis.holders === 0) {
					analysis.controller.abort()

					if (this.analyses.get(track.uuid) === analysis) {
						this.analyses.delete(track.uuid)
					}
				}

				resolve(edges)
			}
			const onAbort = (): void => {
				leave(null)
			}

			signal.addEventListener("abort", onAbort, { once: true })
			void analysis.promise.then(leave)
		})
	}

	private start(track: QueueTrack): Analysis {
		const controller = new AbortController()
		const analysis: Analysis = { promise: this.analyze(track, controller.signal), controller, holders: 0 }

		this.analyses.set(track.uuid, analysis)
		void analysis.promise.then(() => {
			if (this.analyses.get(track.uuid) === analysis) {
				this.analyses.delete(track.uuid)
			}
		})

		return analysis
	}

	// A finished analysis is remembered and persisted, `failed` (undecodable) ones too; a read that failed is
	// neither, so a later play tries again.
	private async analyze(track: QueueTrack, signal: AbortSignal): Promise<TrackEdges | null> {
		const epoch = this.epoch
		const permits = new AnalysisPermits(this.deps.reads)

		try {
			await permits.prime()

			const edges = isAborted(signal) ? null : await this.deps.analyze(track, signal, permits)

			if (edges === null || isAborted(signal) || epoch !== this.epoch) {
				return null
			}

			this.remember(track.uuid, edges)
			this.deps.writeRecord(track.uuid, toEdgesRecord(edges, this.deps.now()))

			return edges
		} catch (error) {
			if (!isAborted(signal) && epoch === this.epoch) {
				log.warn("audio", "track edge analysis read failed", error)
			}

			return null
		} finally {
			permits.close()
		}
	}
}

// The analysis in the remux worker over a port of its own. An abort closes the port's download, which ends the
// worker's reads; the worker's own answer is then dropped.
async function analyzeInWorker(track: QueueTrack, signal: AbortSignal, permits: WindowPermits): Promise<EdgeAnalysis> {
	const hold = await holdRemuxWorker()
	const source = analysisRemuxSource(track.file)
	const aborted = Promise.withResolvers<never>()
	const onAbort = (): void => {
		source.close()
		aborted.reject(signal.reason)
	}

	aborted.promise.catch(() => undefined)
	signal.addEventListener("abort", onAbort, { once: true })

	try {
		const port = await Promise.race([source.openPort(), aborted.promise])
		const answer = hold.remote.analyzeEdges(Comlink.transfer({ port, size: Number(track.file.size) }, [port]), Comlink.proxy(permits))

		answer.catch(() => undefined)

		return await Promise.race([answer, hold.dead, aborted.promise])
	} finally {
		signal.removeEventListener("abort", onAbort)
		source.close()
		hold.release()
	}
}

export const trackEdges = new TrackEdgesService({
	readRecord: uuid => kvGetJson(trackEdgesKey(uuid), trackEdgesRecordSchema),
	writeRecord: (uuid, record) => {
		void kvSetJsonQuiet(trackEdgesKey(uuid), record, "audio", "track edges")
	},
	deleteRecord: uuid => kvDelete(trackEdgesKey(uuid)),
	analyze: analyzeInWorker,
	reads: rangeReads,
	now: () => Date.now()
})

export const getTrackEdges: GetTrackEdges = (track, route, signal, options) => trackEdges.get(track, route, signal, options)

export function resetTrackEdges(): void {
	trackEdges.reset()
}

export function deleteTrackEdges(uuids: readonly string[]): Promise<void> {
	return trackEdges.delete(uuids)
}
