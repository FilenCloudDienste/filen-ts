import { CellError, ErrorType, FunctionArgumentType, type ImplementedFunctions } from "hyperformula"
import { NULL_FUNCTION, OFFSET_FUNCTION, RANGE_FUNCTION } from "../../functions/engineNames"
import {
	GENERIC_ERRORS,
	genericErrorText,
	naError,
	nullError,
	SheetFunctionPlugin,
	valueError,
	type PluginAst,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"

// ERROR.TYPE and AREAS as support.microsoft.com defines them.

// ERROR.TYPE's number for each error the engine has a type for ("ERROR.TYPE function"; #SPILL! 9 is Excel's number
// for the dynamic-array error, which the page's table predates). The others: GENERIC_ERRORS.
const ERROR_NUMBERS: Readonly<Partial<Record<ErrorType, number>>> = {
	[ErrorType.DIV_BY_ZERO]: 2,
	[ErrorType.VALUE]: 3,
	[ErrorType.REF]: 4,
	[ErrorType.NAME]: 5,
	[ErrorType.NUM]: 6,
	[ErrorType.NA]: 7,
	[ErrorType.SPILL]: 9
}

// Functions that give a reference (each one area here).
const REFERENCE_FUNCTIONS: ReadonlySet<string> = new Set(["INDEX", "OFFSET", "INDIRECT", OFFSET_FUNCTION, RANGE_FUNCTION])

function unwrap(ast: PluginAst): PluginAst {
	let node = ast

	while (node.type === ("PARENTHESES" as PluginAst["type"]) && "expression" in node) node = node.expression

	return node
}

export class MiscFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		"ERROR.TYPE": { method: "errorType", parameters: [{ argumentType: FunctionArgumentType.SCALAR }] },
		AREAS: { method: "areas", parameters: [{ argumentType: FunctionArgumentType.ANY }] },
		[NULL_FUNCTION]: { method: "nullValue", parameters: [] }
	}

	// ERROR.TYPE(error_val): the error's number; anything but an error is #N/A.
	errorType(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("ERROR.TYPE"), (value: PluginScalar) => {
			if (!(value instanceof CellError)) return naError()
			const generic = genericErrorText(value)

			if (generic !== undefined) return GENERIC_ERRORS.get(generic) ?? naError()

			return ERROR_NUMBERS[value.type] ?? naError()
		})
	}

	// #NULL!, which the engine has no type for (NULL_FUNCTION).
	nullValue(): CellError {
		return nullError()
	}

	// AREAS(reference): how many areas the reference has. A union of literal references ((A1:B2,C3)) is counted where
	// the formula is read (refs/formulaRefs.ts), so every reference here is one area; a value that is no reference is
	// #VALUE!.
	areas(ast: PluginCall, state: PluginState): unknown {
		const [arg, ...rest] = ast.args

		if (arg === undefined || rest.length > 0) return valueError()

		const node = unwrap(arg)

		switch (node.type) {
			case "CELL_REFERENCE":
			case "CELL_RANGE":
			case "COLUMN_RANGE":
			case "ROW_RANGE":
				return 1
			case "NAMED_EXPRESSION":
			case "FUNCTION_CALL": {
				if (node.type === "FUNCTION_CALL" && !REFERENCE_FUNCTIONS.has(node.procedureName.toUpperCase())) return valueError()

				const value = this.evaluateAst(node, state)

				if (value instanceof CellError) return value

				return node.type === "FUNCTION_CALL" || (typeof value === "object" && "range" in value && value.range !== undefined)
					? 1
					: valueError()
			}
			case "ERROR":
				return this.evaluateAst(node, state)
			default:
				return valueError()
		}
	}
}
