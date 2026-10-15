# Third-party notices

## Built with Llama

QuizForge's optional semantic prompt-injection detector uses **Llama Prompt Guard 2 86M**, a model from Meta.

**Built with Llama.**

| | |
| --- | --- |
| Model | Llama Prompt Guard 2 86M (multilingual: English, French, German, Hindi, Italian, Portuguese, Spanish, Thai) |
| Model card | <https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M> |
| Copy we run | `gravitee-io/Llama-Prompt-Guard-2-86M-onnx` (an ONNX conversion of the same weights, fp32), <https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-86M-onnx>, pinned to revision `45a05fbd5337a864edc608f994911f009c37ca57` |
| Licence | Llama 4 Community License Agreement. Llama 4 is licensed under the Llama 4 Community License, Copyright (c) Meta Platforms, Inc. All Rights Reserved. |
| Licence text | <https://www.llama.com/llama4/license/> (a copy, and the NOTICE file, are placed next to the weights inside the worker image, in `/models/prompt-guard-2/`) |

The weights are **not stored in this repository**. They are downloaded while the `runtime-detector` image is built
(`apps/worker/Dockerfile`), from the pinned revision above, and the build fails if the sha256 of any file differs. The model is used
as downloaded: it is not modified, fine-tuned or renamed. Use of the model is subject to the licence above and to Meta's Acceptable
Use Policy (<https://www.llama.com/llama4/use-policy/>). Anyone who builds or redistributes the `runtime-detector` image accepts those
terms for the model files it contains.

Where the detector is described to people (documentation, security report), it carries the "Built with Llama" attribution.

## Test documents (`evals/fixtures`)

The golden set of the LLM evaluation (`evals/src/golden.ts`) contains pinned, **unmodified snapshots** of the README files of five open-source
projects (some of them translations), so the hand-written reference questions stay valid when upstream changes.
The snapshots are test data only: they are not part of the application and are never shipped in a runtime image. Each one is kept under the
licence of its project; the licence texts are in the linked `LICENSE` files.

| Fixture (`evals/fixtures/`) | Language | Origin | Licence | Snapshot taken |
| --- | --- | --- | --- | --- |
| `pipecat.md` | en | <https://github.com/pipecat-ai/pipecat/blob/main/README.md> | BSD 2-Clause, Copyright (c) 2024-2026, Daily | 2026-10-08 |
| `mastra.md` | en | <https://github.com/mastra-ai/mastra/blob/main/README.md> | Apache-2.0 (the project's `LICENSE.md` reserves only its `ee/` directories for an enterprise licence; the README is outside them) | 2026-10-08 |
| `wails-pt.md` | pt | `README.pt-br.md` of <https://github.com/wailsapp/wails> at commit `6b767b48336dc3f0737957d8206958abf5f77492` ([LICENSE](https://github.com/wailsapp/wails/blob/6b767b48336dc3f0737957d8206958abf5f77492/LICENSE)) | MIT, Copyright (c) 2018-Present Lea Anthony | 2026-10-14 |
| `wails-es.md` | es | `README.es.md` of the same repository and commit | MIT, Copyright (c) 2018-Present Lea Anthony | 2026-10-14 |
| `brazilian-utils-pt.md` | pt | `README.pt-br.md` of <https://github.com/brazilian-utils/javascript> at commit `0f0f9a1539d7263a08e245e9b03f8f7dffc7cd9e` ([LICENSE](https://github.com/brazilian-utils/javascript/blob/0f0f9a1539d7263a08e245e9b03f8f7dffc7cd9e/LICENSE)); native Portuguese README | MIT, Copyright (c) 2018 Hyan Mandian | 2026-10-14 |
| `supabase-es.md` | es | `i18n/README.es.md` of <https://github.com/supabase/supabase> at commit `f20277377bc7626da5fccbe125b8db33d92109cc` ([LICENSE](https://github.com/supabase/supabase/blob/f20277377bc7626da5fccbe125b8db33d92109cc/LICENSE)) | Apache-2.0 | 2026-10-14 |

The other documents in `evals/fixtures` (`short-doc.md`, `portuguese.md`, `spanish.md`, `injection.md`, `injection-pt.md`, `injection-es.md`,
`code-heavy.md`, `minimal.md`, `multi-answer.md`) were written for this repository; the products they describe (Zephyr Cache, Biblioteca Aurora,
Brisa Notebook, Orbit Scheduler) are invented. The `origin` field of every real README in `golden.ts` records the same information as this table,
and the reference questions in `evals/references/` are original work.
