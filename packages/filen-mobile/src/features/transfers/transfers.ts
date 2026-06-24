import { PauseSignal } from "@/lib/signals"
import { uploadCore, downloadCore, type UploadParams, type DownloadParams } from "@/features/transfers/transferCore"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"

class Transfers {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()

	public cancelAll(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
		// Free the old pause signal's SDK handle before replacing it — uniffi handles are not
		// GC'd. Safe here: cancelAll() has aborted all in-flight transfers, and each transfer
		// drives the SDK via its own composite signal (disposed on settle), only attaching JS
		// listeners to this one — so nothing still in flight reads the freed handle.
		this.globalPauseSignal.dispose()
		this.globalPauseSignal = new PauseSignal()
	}

	// Pause/resume every live transfer by iterating their per-transfer signals — NOT by toggling
	// `globalPauseSignal`. Each transfer's SDK pause state is the composite of (global, per-transfer)
	// and `registerPauseListeners` flips the store `paused` flag from BOTH inputs. Driving the global
	// input alone leaves it incoherent: a later per-row resume() flips the store flag to running while
	// the composite stays paused (global still paused) → UI shows "running" at frozen progress, and the
	// global input stays sticky-paused for any future programmatic upload/download. Iterating per
	// transfer keeps the store flag, the per-transfer signal and the composite consistent — matching the
	// transfers screen's pause-all/resume-all handlers. (The global signal is still threaded into every
	// composite so cancelAll() can dispose/replace it; these methods simply never touch it.)
	public pauseAll(): void {
		for (const transfer of useTransfersStore.getState().transfers) {
			transfer.pause()
		}
	}

	public resumeAll(): void {
		for (const transfer of useTransfersStore.getState().transfers) {
			transfer.resume()
		}
	}

	/** Returns uploaded items as the result. If null, the transfer has been cancelled. */
	public async upload(params: UploadParams) {
		return await uploadCore(this.globalAbortController, this.globalPauseSignal, params)
	}

	public async download(params: DownloadParams) {
		return await downloadCore(this.globalAbortController, this.globalPauseSignal, params)
	}
}

const transfers = new Transfers()

export default transfers
