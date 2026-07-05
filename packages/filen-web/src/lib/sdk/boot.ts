import { sdkApi, threadCount } from "@/lib/sdk/client"
import { toErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { useBootStore } from "@/stores/boot"
import { log } from "@/lib/log"

// The worker's Comlink boundary always throws a plain ErrorDTO; Comlink transport failures (a worker
// that never loaded) throw something else — normalize both to an ErrorDTO for the store.
function asErrorDTO(e: unknown): ErrorDTO {
	return typeof e === "object" && e !== null && "species" in e && "label" in e ? (e as ErrorDTO) : toErrorDTO(e)
}

// Drives the worker boot + the async-runtime smoke test, reflecting each phase into the boot store.
// Boot success is NOT health: probeAsync() (an unauth network op that must settle) gates "ready".
export async function bootSdk(): Promise<void> {
	const { setBooting, setReady, setError } = useBootStore.getState()
	setBooting()
	try {
		const result = await sdkApi.boot({ threads: threadCount() })
		if (!result.ok) {
			setError(result.reason, { species: "plain", message: result.detail, label: result.detail })
			log.error("boot", `${result.reason}: ${result.detail}`)
			return
		}
		await sdkApi.probeAsync()
		setReady()
		log.info("boot", `ready (${String(result.threads)} threads)`)
	} catch (e) {
		setError("async-runtime", asErrorDTO(e))
		log.error("boot", "boot/probe threw", e)
	}
}
