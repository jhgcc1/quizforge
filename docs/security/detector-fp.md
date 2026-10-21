# False positives of the semantic detector (Llama Prompt Guard 2 and the previous DeBERTa)

Measured by `promptfoo/redteam/research/checks/detector-fp.ts` (result in `detector-fp.json`) on every benign text we have, with the keyword rules next to the two models. The threshold is 0.5. A "false positive" is a legitimate document that the detector flags.

| Benign set | Documents | Keyword rules | Prompt Guard 2 (in use, with the input preparation) | DeBERTa (previous, English only) |
|---|---|---|---|---|
| Real Portuguese and Spanish READMEs | 64 | 1 (see below) | 1 | 17 |
| Real English READMEs | 34 | 0 | 0 | 4 |
| Benign rows of the public dataset | 301 | 0 | 0 | 3 |
| Test documents that are not attacks (`evals/fixtures`) | 12 | 0 | 0 | 1 |
| Red-team README templates | 4 | 0 | 0 | 0 |
| **All** | **415** | **1** | **1** | **25** |

## What it says

* With the input preparation (`detector-prep.md`) Prompt Guard 2 flags **25 times fewer** legitimate documents than the model it replaced (1 against 25; it was 5 before the preparation), and it also reads Portuguese and Spanish, where DeBERTa is not meant to work.
* It is **not zero**: the one flagged document is the Spanish version of a code-style guide (0.977). The five documents flagged before the preparation (the pt and es design-patterns README, a Spanish roadmap, an English Babel guide, the code-style guide) were mostly markup debris from badge rows. On a wider base of 722 real READMEs it flags 12 (1.7%), down from 27 (3.7%).
* This is why the detector only **flags** and never blocks (`INJECTION_DETECTOR=flag`): a flag on a legitimate document changes only the strict link mode and a metric, so the cost of a false positive is small. Blocking on it would reject real documents: 1 in 60 on the 415-document set, 1.7% of 722 real READMEs.

## One finding that was not the detector: a block on a README with an embedded image

The keyword-rule column of the Portuguese and Spanish row is not a rule: it is the check for payloads hidden in base64. The README of `okfn-brasil/querido-diario` embeds an SVG logo as `data:image/svg+xml;base64,...`. An SVG is text, so decoding it looked like "a readable sentence hidden in base64", and the document was **rejected** (a block, not a flag): a legitimate README could not be turned into a quiz. The guard now removes inline images (`data:image/...;base64,...`) before decoding, leaves a marker, and still blocks an instruction hidden inside an image, or a hidden sentence in base64 outside an image. The 98 real READMEs now have 0 blocks.

## Reproduce

`DEBERTA_DIR=<local DeBERTa model dir> pnpm exec tsx promptfoo/redteam/research/checks/detector-fp.ts --out=docs/security/detector-fp.json` (the models are downloaded once into the transformers cache; the real READMEs are fetched by the scripts of `docs/security/guard-pt-es.md`).
