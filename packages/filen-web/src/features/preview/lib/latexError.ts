import type { TFunction } from "i18next"
import type { LatexError } from "@filen/office/core/docx/edit"

// Why LaTeX could not be read (an equation being typed, a formula in a markdown file).
export function latexErrorMessage(t: TFunction<"preview">, error: LatexError): string {
	const values = { token: error.token ?? "", position: error.offset + 1 }

	switch (error.code) {
		case "tooLong":
			return t("previewDocxEquationErrorTooLong")
		case "tooDeep":
			return t("previewDocxEquationErrorTooDeep", values)
		case "unknownCommand":
			return t("previewDocxEquationErrorUnknownCommand", values)
		case "missingArgument":
			return t("previewDocxEquationErrorMissingArgument", values)
		case "unbalanced":
			return t("previewDocxEquationErrorUnbalanced", values)
		case "unexpected":
		case "empty":
			return t("previewDocxEquationErrorUnexpected", values)
	}
}
