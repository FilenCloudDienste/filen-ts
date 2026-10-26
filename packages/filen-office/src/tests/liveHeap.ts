import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

// The live heap of this process (heap and array buffers after full collections), for memory budgets: garbage the
// collector has not reached yet is not what the code holds, and other processes (the parallel suite) do not count.

setFlagsFromString("--expose-gc")

const collect = runInNewContext("gc") as unknown

if (typeof collect !== "function") throw new Error("no gc: memory budgets cannot be measured")

const gc = collect as () => void

function used(): number {
	const usage = process.memoryUsage()

	return usage.heapUsed + usage.arrayBuffers
}

// From inside running work (no turn to give): twice, since buffers whose last reference one collection found are only
// released by the next.
export function liveHeapNow(): number {
	gc()
	gc()

	return used()
}

// Between pieces of work: a collection, a turn for the backing stores freed off the thread, another collection.
export async function liveHeap(): Promise<number> {
	gc()
	await new Promise(resolve => setImmediate(resolve))
	gc()

	return used()
}
