import { HyperFormula } from "hyperformula"

// A finite range a formula reads that the engine already holds as a range of its graph: HyperFormula joins each of its
// cells to it again for every formula reading it (edges it has), which makes n formulas over one n-row table n²
// work to build. A range in the graph keeps its inputs as joined (the engine moves them with inserted and removed rows
// and drops the range only once nothing reads it), so the formula is joined to the range alone.

interface Range {
	readonly start?: unknown
	readonly end?: unknown
	readonly isFinite?: () => boolean
}

interface GraphInternals {
	getRange(start: unknown, end: unknown): object | undefined
	readonly graph: {
		hasNode(node: object): boolean
		addEdge(from: object, to: number): void
	}
}

type ProcessDependencies = (this: GraphInternals, dependencies: readonly unknown[], end: { readonly idInGraph?: number }) => void

let installed = false

// Wraps the engine's dependency processing once, over what wholeRanges.ts installed before it.
export function installSharedRanges(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildEmpty({ licenseKey })

	try {
		const prototype = Object.getPrototypeOf(probe.dependencyGraph) as { processCellDependencies: ProcessDependencies }
		const process = prototype.processCellDependencies

		prototype.processCellDependencies = function (dependencies, endVertex) {
			const id = endVertex.idInGraph

			if (id === undefined) {
				process.call(this, dependencies, endVertex)

				return
			}

			let rest: unknown[] | null = null

			for (let index = 0; index < dependencies.length; index++) {
				const dependency = dependencies[index]
				const range = dependency as Range
				const held =
					typeof range.isFinite === "function" && range.start !== undefined && range.end !== undefined && range.isFinite()
						? this.getRange(range.start, range.end)
						: undefined

				if (held !== undefined && this.graph.hasNode(held)) {
					this.graph.addEdge(held, id)
					rest ??= dependencies.slice(0, index)

					continue
				}

				rest?.push(dependency)
			}

			if (rest === null) process.call(this, dependencies, endVertex)
			else if (rest.length > 0) process.call(this, rest, endVertex)
		}
	} finally {
		probe.destroy()
	}
}
