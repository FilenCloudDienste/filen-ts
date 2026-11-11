// The longest the event loop went without running a 1 ms interval while `run` settled: a timer drift probe for work
// that must stay off the JS thread.
async function longestStall(run: () => Promise<unknown>): Promise<number> {
	let last = performance.now()
	let longest = 0
	const probe = setInterval(() => {
		const now = performance.now()

		longest = Math.max(longest, now - last)
		last = now
	}, 1)

	try {
		// Lets the probe tick once first, so a stall at the start is measured from a running interval.
		await new Promise(resolve => setTimeout(resolve, 5))
		last = performance.now()
		await run()

		const now = performance.now()

		return Math.max(longest, now - last)
	} finally {
		clearInterval(probe)
	}
}

// The shortest longest stall of up to `attempts` runs, stopping at the first under `limitMs`: a loaded test machine
// rarely preempts the thread in every run, work that blocks it does in each.
export async function quietestStall(limitMs: number, run: () => Promise<unknown>, attempts = 3): Promise<number> {
	let quietest = Infinity

	for (let attempt = 0; attempt < attempts && quietest >= limitMs; attempt++) {
		quietest = Math.min(quietest, await longestStall(run))
	}

	return quietest
}
