import { rm } from "node:fs/promises"
import path from "node:path"
import type { CacheStatusListener, JsClient, SyncEngineListener } from "@filen/sdk-rs"
import type { NativeSdk, SyncEngine } from "./addon.ts"

export type OpenedEngine = { engine: SyncEngine; reset: boolean } | { fatal: "baselineInUse" | "open"; error: unknown }

function refusalOf(sdk: NativeSdk, error: unknown): string | null {
	return sdk.FilenSdkError.hasInner(error) ? (sdk.FilenSdkError.getInner(error).syncRefusal()?.tag ?? null) : null
}

// The cache is configured first (pure storage: no worker, file or request until a root is added), so the engine's
// pairs are announced from the open on. A baseline at another schema version is deleted and opened anew once, with
// `reset`: the pairs went with it and main re-adds them from its mirror. A baseline another engine has open is fatal.
export async function openEngine(
	sdk: NativeSdk,
	client: JsClient,
	dir: string,
	listeners: { cache: CacheStatusListener; sync: SyncEngineListener }
): Promise<OpenedEngine> {
	const baseline = path.join(dir, "baseline.db")

	try {
		await client.configureCache(path.join(dir, "cache.db"), listeners.cache)
	} catch (error) {
		return { fatal: "open", error }
	}

	for (let attempt = 0; ; attempt++) {
		try {
			return { engine: await client.openSyncEngine(baseline, listeners.sync), reset: attempt > 0 }
		} catch (error) {
			const refusal = refusalOf(sdk, error)

			if (refusal === "BaselineInUse") {
				return { fatal: "baselineInUse", error }
			}

			if (refusal !== "BaselineSchemaMismatch" || attempt > 0) {
				return { fatal: "open", error }
			}

			// Only the baseline and its SQLite companions; the cache DB is unaffected.
			await Promise.all(["", "-wal", "-shm"].map(suffix => rm(baseline + suffix, { force: true })))
		}
	}
}
