import { FragmentFlag, FragmentKind } from "../../../core/text/index"
import type { TextPage } from "../../../core/presentation/output"
import { fixtureTextPage } from "./textPage"

// A sideways text page for the painters: "日" on the first line, flagged upright; "Ab" on the second, plain.
export function uprightPage(): TextPage {
	const text = fixtureTextPage(["日", "Ab"])

	text.page.fragmentInts[3] = FragmentKind.TEXT | FragmentFlag.UPRIGHT
	return text
}
