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
