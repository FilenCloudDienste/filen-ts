// Copies in progress. The copy engine brackets each job with begin()/end() and flags it while the SDK
// reports it paused.
class CopyActivity {
	private active = 0
	// Running copies the SDK reports paused: nothing of theirs runs, so they create nothing until resumed.
	private paused = 0
	private recentsRefresh: (() => void) | null = null

	public begin(): void {
		this.active++
	}

	public end(): void {
		if (this.active === 0) {
			return
		}

		this.active--

		this.refreshRecentsOnceQuiet()
	}

	// A copy that ends paused is unflagged before its end().
	public setPaused(paused: boolean): void {
		if (!paused) {
			if (this.paused > 0) {
				this.paused--
			}

			return
		}

		this.paused++

		this.refreshRecentsOnceQuiet()
	}

	public isActive(): boolean {
		return this.active > 0
	}

	private isCreating(): boolean {
		return this.active > this.paused
	}

	// Every file a copy creates is a new recent, so Recents patches are dropped while one creates and the
	// listing is refreshed once none does. Returns false then: the caller patches now.
	public deferRecents(refresh: () => void): boolean {
		if (!this.isCreating()) {
			return false
		}

		this.recentsRefresh = refresh

		return true
	}

	private refreshRecentsOnceQuiet(): void {
		if (this.isCreating() || !this.recentsRefresh) {
			return
		}

		const recentsRefresh = this.recentsRefresh

		this.recentsRefresh = null

		recentsRefresh()
	}
}

const copyActivity = new CopyActivity()

export default copyActivity
