// Timing helpers for tests that bound work: the CPU time of the running thread is what the code spent, wall time
// also counts whatever else shares the machine; bounds on totals use the least of several runs.

// CPU milliseconds (user + system) the current thread has consumed so far (the process's where the runtime cannot
// tell a thread's). Through Reflect: the DOM test project has no node typings.
export function cpuMs(): number {
	const proc: unknown = Reflect.get(globalThis, "process")
	const thread: unknown = Reflect.get(proc as object, "threadCpuUsage")
	const usage = (
		typeof thread === "function" ? Reflect.apply(thread, proc, []) : Reflect.apply(Reflect.get(proc as object, "cpuUsage"), proc, [])
	) as { user: number; system: number }

	return (usage.user + usage.system) / 1000
}

// The value at `fraction` (0 to 1) of ascending `sorted` (nearest rank; 0 when empty).
export function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

export { budget } from "@filen/shared/tooling/testBudget"
