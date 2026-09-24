// Copies in progress. The copy engine brackets each job with begin()/end(); until it exists nothing
// calls begin(), so every check below reads idle.
class CopyActivity {
	private active = 0
	private recentsRefresh: (() => void) | null = null

	public begin(): void {
		this.active++
	}

	public end(): void {
		if (this.active === 0) {
			return
		}

		this.active--

		if (this.active === 0 && this.recentsRefresh) {
			const recentsRefresh = this.recentsRefresh

			this.recentsRefresh = null

			recentsRefresh()
		}
	}

	public isActive(): boolean {
		return this.active > 0
	}

	// Every file a copy creates is a new recent, so Recents patches are dropped while one runs and the
	// listing is refreshed once when the last one ends. Returns false when idle: the caller patches now.
	public deferRecents(refresh: () => void): boolean {
		if (this.active === 0) {
			return false
		}

		this.recentsRefresh = refresh

		return true
	}
}

const copyActivity = new CopyActivity()

export default copyActivity
