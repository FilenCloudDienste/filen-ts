import { HyperFormula, type FunctionPluginDefinition } from "hyperformula"
import { AggregateFunctions } from "./aggregate"
import { installExcelArguments } from "./arguments"
import { ArrayFunctions } from "./arrays"
import { BondFunctions } from "./bonds"
import { ARRAY_RESULTS } from "../../refs/formulaRefs"
import { installBlankTails } from "./blankTails"
import { ConvertFunctions } from "./convert"
import { CriteriaFunctions } from "./criteria"
import { DateFunctions } from "./date"
import { GroupFunctions } from "./groupby"
import { IndirectFunctions } from "./indirect"
import { LambdaFunctions } from "./lambda"
import { LogicalFunctions } from "./logical"
import { installWildcardMatch, LookupFunctions } from "./lookup"
import { MathFunctions } from "./math"
import { MatrixFunctions } from "./matrix"
import { MiscFunctions } from "./misc"
import { ReferenceFunctions } from "./reference"
import { SpillFunctions } from "./spill"
import { RegexFunctions } from "./regex"
import { ShapeFunctions } from "./shape"
import { StatisticalFunctions } from "./statistical"
import { Statistics2Functions } from "./statistics2"
import { TextFunctions } from "./text"
import { Text2Functions } from "./text2"

// The app's own functions, registered with the engine once, before the first engine is built. A function the engine
// has of its own is replaced where it calculates differently from Excel (TEXT, SUBTOTAL, COUNTBLANK, the rounding
// functions, DATEDIF), and arguments Excel truncates are truncated (arguments.ts); the others are
// functions it lacks, and the engine-only functions its formula text calls (functions/engineNames.ts).
const PLUGINS: readonly FunctionPluginDefinition[] = [
	TextFunctions,
	AggregateFunctions,
	CriteriaFunctions,
	DateFunctions,
	ReferenceFunctions,
	LookupFunctions,
	StatisticalFunctions,
	ArrayFunctions,
	LambdaFunctions,
	GroupFunctions,
	IndirectFunctions,
	SpillFunctions,
	LogicalFunctions,
	BondFunctions,
	Statistics2Functions,
	MatrixFunctions,
	ShapeFunctions,
	Text2Functions,
	ConvertFunctions,
	MiscFunctions,
	RegexFunctions,
	MathFunctions
]

let registered = false

// Registers the functions (once). Names in the engine's language table are its own; a new name is added under itself.
export function registerSheetFunctions(): void {
	if (registered) return

	registered = true

	const known = new Set(HyperFormula.getRegisteredFunctionNames("enGB"))

	for (const plugin of PLUGINS) {
		const added = Object.keys(plugin.implementedFunctions).filter(name => !known.has(name))

		HyperFormula.registerFunctionPlugin(
			plugin,
			added.length === 0 ? undefined : { enGB: Object.fromEntries(added.map(name => [name, name])) }
		)
	}

	installExcelArguments()
	installWildcardMatch()
	installBlankTails(ARRAY_RESULTS)
}

// The functions the app adds to the engine (not those it replaces), upper case.
export function pluginFunctionNames(): readonly string[] {
	return PLUGINS.flatMap(plugin => Object.keys(plugin.implementedFunctions))
}
