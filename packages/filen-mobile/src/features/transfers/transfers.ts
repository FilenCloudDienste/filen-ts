import { PauseSignal } from "@/lib/signals"
import { uploadCore, downloadCore, type UploadParams, type DownloadParams } from "@/features/transfers/transferCore"

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

	public pauseAll(): void {
		this.globalPauseSignal.pause()
	}

	public resumeAll(): void {
		this.globalPauseSignal.resume()
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
