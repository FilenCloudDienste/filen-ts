/// <reference lib="webworker" />
import * as Comlink from "comlink"
import { officeTemplateApi } from "@/features/drive/lib/officeTemplates"

// One blank office file per worker (createOfficeFile.ts spawns it for New ▸ Office and ends it after).
Comlink.expose(officeTemplateApi)
