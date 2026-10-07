import * as Comlink from "comlink"
import SdkWorker from "@/workers/sdk.worker.ts?worker"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import { trackSdkCalls } from "@/e2e-hooks/sdkCalls"

// rayon pool sizing: every core but two, which stay free for the UI thread and the SDK's single
// coordinator thread (rayon only runs chunk crypto and hashing). Capped at 12: past that, worker spawn
// cost and per-worker memory keep growing while transfer throughput no longer does.
export function threadCount(): number {
	const cores = navigator.hardwareConcurrency || 4

	return Math.min(Math.max(cores - 2, 2), 12)
}

// Exactly one dedicated worker owns the SDK Client for the app's lifetime — the Client never
// touches the main thread. Comlink turns the worker's `api` into an awaitable remote.
// E2E builds count the calls in flight (e2e-hooks/sdkCalls.ts); a normal build drops the branch.
const remote = Comlink.wrap<SdkWorkerApi>(new SdkWorker())

export const sdkApi: Comlink.Remote<SdkWorkerApi> = import.meta.env.VITE_E2E === "1" ? trackSdkCalls(remote) : remote
