import type { LayoutContext, LayoutNode } from "../interp"
import { compositeLayout } from "./composite"
import { connLayout } from "./conn"
import { cycleLayout } from "./cycle"
import { hierChildLayout, hierRootLayout } from "./hier"
import { linLayout } from "./lin"
import { pyraLayout } from "./pyra"
import { snakeLayout } from "./snake"
import { spLayout } from "./sp"
import { txLayout } from "./tx"

// The layout algorithms (ECMA-376 §21.4.2.1 alg, ST_AlgorithmType §21.4.7.1): the interpreter places a layout
// node's children through the node's algorithm. An unknown algorithm places like sp (children at their constraint
// sizes at the node's origin), as nothing else is defined for it.
export function layoutAlgorithm(node: LayoutNode, context: LayoutContext): void {
	switch (node.alg.type) {
		case "composite":
			compositeLayout(node, context)
			break
		case "conn":
			connLayout(node, context)
			break
		case "cycle":
			cycleLayout(node, context)
			break
		case "hierChild":
			hierChildLayout(node, context)
			break
		case "hierRoot":
			hierRootLayout(node, context)
			break
		case "lin":
			linLayout(node, context)
			break
		case "pyra":
			pyraLayout(node, context)
			break
		case "snake":
			snakeLayout(node, context)
			break
		case "tx":
			txLayout(node, context)
			break
		case "sp":
		case "unknown":
			spLayout(node, context)
	}
}
