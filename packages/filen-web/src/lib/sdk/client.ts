import * as Comlink from "comlink"
import SdkWorker from "@/workers/sdk.worker.ts?worker"
import type { SdkWorkerApi } from "@/workers/sdk.worker"

// rayon pool sizing: leave one core for the main thread / UI, and cap at 16 — worker spawn
// cost and per-worker memory keep growing on many-core machines while our upload/download/crypto
// throughput plateaus well before that, so more workers would only cost RAM.
export function threadCount(): number {
	const cores = navigator.hardwareConcurrency || 4
	return Math.min(Math.max(cores - 1, 1), 16)
}

// Exactly one dedicated worker owns the SDK Client for the app's lifetime — the Client never
// touches the main thread. Comlink turns the worker's `api` into an awaitable remote.
export const sdkApi: Comlink.Remote<SdkWorkerApi> = Comlink.wrap<SdkWorkerApi>(new SdkWorker())
