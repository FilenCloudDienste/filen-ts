import { PauseSignal } from "@/lib/signals"
import { uploadCore, downloadCore, type UploadParams, type DownloadParams } from "@/features/transfers/transferCore"
import useTransfersStore from "@/features/transfers/store/useTransfers.store"

class Transfers {
	// Two abort scopes. Manual, user-initiated transfers use the FOREGROUND scope and are cancelled when the
	// app backgrounds without an active Android foreground service (they cannot complete while frozen and
	// would pin the SDK's shared concurrency / file-IO-memory permits on a dead socket). Sync-engine transfers
	// (camera-upload, offline) use the BACKGROUND scope and are NEVER cancelled by the app→background
	// transition: they run from the OS background task, are idempotent / retried, and rely on the foreground
	// service + SDK TCP keepalive.
	private foregroundAbortController = new AbortController()
	private backgroundAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()

	// Cancel EVERY in-flight transfer (both scopes) and reset. Used by logout (auth.ts) and the transfers
	// screen's "Cancel all" button.
	public cancelAll(): void {
		this.foregroundAbortController.abort()
		this.foregroundAbortController = new AbortController()
		this.backgroundAbortController.abort()
		this.backgroundAbortController = new AbortController()
		// Free the old pause signal's SDK handle before replacing it — uniffi handles are not GC'd. Safe
		// here: cancelAll() has aborted all in-flight transfers, and each transfer drives the SDK via its own
		// composite signal (disposed on settle), only attaching JS listeners to this one.
		this.globalPauseSignal.dispose()
		this.globalPauseSignal = new PauseSignal()
	}

	// Cancel only FOREGROUND-scoped (manual) in-flight transfers and reset that scope. Called from the
	// app→background lifecycle hook when no Android foreground service is protecting the transfers. The
	// background scope is left untouched, and the shared pause signal is NOT disposed (background transfers
	// still in flight reference it).
	public cancelForegroundTransfers(): void {
		this.foregroundAbortController.abort()
		this.foregroundAbortController = new AbortController()
	}

	// Pause/resume every live transfer by iterating their per-transfer signals — NOT by toggling
	// globalPauseSignal. Each transfer's SDK pause state is the composite of (global, per-transfer) and
	// registerPauseListeners flips the store `paused` flag from BOTH inputs. Driving the global input alone
	// leaves it incoherent. Iterating per transfer keeps the store flag, the per-transfer signal and the
	// composite consistent. (The global signal is still threaded into every composite so cancelAll() can
	// dispose/replace it; these methods simply never touch it.)
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
		const abortController = params.background ? this.backgroundAbortController : this.foregroundAbortController

		return await uploadCore(abortController, this.globalPauseSignal, params)
	}

	public async download(params: DownloadParams) {
		const abortController = params.background ? this.backgroundAbortController : this.foregroundAbortController

		return await downloadCore(abortController, this.globalPauseSignal, params)
	}
}

const transfers = new Transfers()

export default transfers
