# @filen/assistant-node

The assistant's `AssistantModel` requests (`@filen/shared/assistant`) over [node-llama-cpp](https://github.com/withcatai/node-llama-cpp), for Node runtimes. The desktop app's native engine (`packages/filen-desktop/src/assistant`) runs it in its "Filen Assistant" utility process, and the eval harness (`packages/filen-assistant-eval`) measures it, so the eval grades the mapping the app ships.

`LlamaSlotModel` keeps one context sequence per request kind (router, main loop, extraction), so no kind pushes another's cached prompt out. It maps the loop's engine-neutral messages to node-llama-cpp's chat history (`toHistory`), opens a required call with the template's call opener, hands calls back as text when none may be made, and streams the text and each call's name as soon as they are known. Qwen3.5 runs in non-thinking mode (`qwen35ChatWrapper`); a caller may pass its own chat wrapper.

Node only: never import it from the web app or `@filen/shared`. The desktop app bundles it into its engine together with node-llama-cpp.

## Commands

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `pnpm run lint`      | eslint, then prettier                                     |
| `pnpm run typecheck` | `tsc -p tsconfig.json`                                    |
| `pnpm test`          | vitest (`src/tests`): the history mapping, with no model |
