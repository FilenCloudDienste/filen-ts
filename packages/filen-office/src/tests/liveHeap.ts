import { setFlagsFromString } from "node:v8"
import { runInNewContext, runInThisContext } from "node:vm"

// The live heap of this process (heap and array buffers after full collections), for memory budgets: garbage the
// collector has not reached yet is not what the code holds, and other processes (the parallel suite) do not count.
//
// A function the code under test made hot is optimized on a background thread, and until the main thread installs
// the result the compile job holds that function's closure as a root: the state of its last call (decoded markup, the
// maps a pass built) survives every collection. On a loaded machine the job is still pending when the work returns,
// so before collecting, the pending jobs are finished and installed (V8's %FinalizeOptimization, the test hook for
// exactly this): a reading then holds what the code keeps, not what the optimizer has yet to let go of.

setFlagsFromString("--expose-gc")

const collect = runInNewContext("gc") as unknown

if (typeof collect !== "function") throw new Error("no gc: memory budgets cannot be measured")

const gc = collect as () => void

// Natives syntax only while the one-line script is compiled (each time: a function's body is compiled when it first
// runs, or again once its bytecode was flushed, so a function compiled with the flag on would not stay valid): no
// other code is parsed with it.
function finishOptimization(): void {
	setFlagsFromString("--allow-natives-syntax")

	try {
		runInThisContext("%FinalizeOptimization()")
	} finally {
		setFlagsFromString("--no-allow-natives-syntax")
	}
}

function used(): number {
	const usage = process.memoryUsage()

	return usage.heapUsed + usage.arrayBuffers
}

// From inside running work (no turn to give): twice, since buffers whose last reference one collection found are only
// released by the next.
export function liveHeapNow(): number {
	finishOptimization()
	gc()
	gc()

	return used()
}

// Between pieces of work: a collection, a turn for the backing stores freed off the thread, another collection.
export async function liveHeap(): Promise<number> {
	finishOptimization()
	gc()
	await new Promise(resolve => setImmediate(resolve))
	finishOptimization()
	gc()

	return used()
}
