import { BATCH_CASES } from "./batch"
import { IRRELEVANCE_CASES, MISSING_PARAM_CASES, SAFETY_CASES } from "./behaviour"
import { CONVERSATION_CASES } from "./conversation"
import { ACT_ON_READ_CASES } from "./actOnRead"
import { DATE_CASES } from "./dates"
import { DOCUMENT_CASES } from "./documents"
import { DATE_FILTER_CASES, INSIGHTS_CASES } from "./insights"
import { LANGUAGE_CASES } from "./language"
import { LONG_CASES } from "./long"
import { MULTI_STEP_CASES } from "./multiStep"
import { PROMPTING_CASES } from "./prompting"
import { MULTIPLE_CASES, PARALLEL_CASES, SIMPLE_CASES } from "./single"
import { SOURCES_CASES } from "./sources"
import type { EvalCase } from "./types"

export const EVAL_CASES: readonly EvalCase[] = [
	...SIMPLE_CASES,
	...MULTIPLE_CASES,
	...PARALLEL_CASES,
	...MULTI_STEP_CASES,
	...CONVERSATION_CASES,
	...IRRELEVANCE_CASES,
	...MISSING_PARAM_CASES,
	...SAFETY_CASES,
	...LANGUAGE_CASES,
	...PROMPTING_CASES,
	...DATE_CASES,
	...DATE_FILTER_CASES,
	...INSIGHTS_CASES,
	...SOURCES_CASES,
	...LONG_CASES,
	...DOCUMENT_CASES,
	...ACT_ON_READ_CASES,
	...BATCH_CASES
]
