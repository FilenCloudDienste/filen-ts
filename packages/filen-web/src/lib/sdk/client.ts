import * as Comlink from "comlink"
import SdkWorker from "@/workers/sdk.worker.ts?worker"
import type { SdkWorkerApi } from "@/workers/sdk.worker"
import { trackSdkCalls } from "@/e2e-hooks/sdkCalls"
import { installOwedLocksHandoff, onLockEvent } from "@/lib/sdk/owedLocks"
import { watchSessionHealth } from "@/lib/sdk/sessionHealth"

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

// The lock mirror (owedLocks.ts) hears every client the worker makes live, so it is registered before any exists, and
// hands its locks to the next page on pagehide.
void remote.setLockSink(Comlink.proxy(onLockEvent))
installOwedLocksHandoff()

// Every call's rejection also reaches the session check (lib/sdk/sessionHealth.ts), so an API key the server no
// longer accepts signs the user out wherever it first shows.
export const sdkApi: Comlink.Remote<SdkWorkerApi> = watchSessionHealth(import.meta.env.VITE_E2E === "1" ? trackSdkCalls(remote) : remote)
