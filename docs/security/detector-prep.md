# Detector false positives: what was flagged, what the preparation changes, and whether a block mode could be safe

Measured by `promptfoo/redteam/replay/detector-prep.ts` (numbers in `detector-prep.json`). Llama Prompt Guard 2 86M, threshold 0.5, alone (no keyword rules), on every benign text and every attack set we have. The attack texts are quoted nowhere: the public datasets are read from `.local/`.

## Why the five real READMEs were flagged

`chunkProse` (`packages/detector/src/chunk.ts`) cuts the document into paragraph-aligned windows of at most 1,600 characters (at most 48 windows, evenly spread), strips Markdown syntax with `plainText` and sends each window to the classifier. The window text that scored above 0.5, per document:

| Document (real README) | Score | What the flagged window contained |
|---|---|---|
| Java design patterns, pt | 0.966 | the title, then a row of five badges left as `![License MIT ]( ![Lines of Code ]( ![Coverage ]( ...` (the badge address has a space or bracket, so `plainText` cut the link in the middle), then plain prose |
| Java design patterns, es | 0.993 | the same badge debris, then plain prose |
| `mouredev/roadmap-retos-programacion`, es | 0.858 | a row of images left as `![Lógica 1 ]( ![Lógica 2 ](` and the sentence "Haz un FORK del proyecto y trabaja con Git" (imperative) |
| Jest, en | 0.888 | the Babel instructions ("Then add ... to the list of presets"), a code sample with `+ '@babel/preset-typescript'`, and six badge fragments |
| Clean Code JavaScript, es | 0.977 and 0.781 | "Mal hecho / Bien hecho" code samples (`try { ... } catch`, `.then(...)`), titles in the imperative ("No les ignores a los errores pillados", "NO DISCUTAS sobre formatear") |

Cause in one line: **markup debris** (four of the five documents) and, for the fifth, **code full of imperative words**. A classifier trained to say "does this look like an instruction aimed at a model" reacts to both. Removing the debris alone clears four documents (document-level ablation below).

## What was tried (detector input only: the keyword rules and the output rails always read the raw document)

| Variant | Real pt/es READMEs (64) | Real English READMEs (34) | Benign dataset rows (301) | Fixtures (12) | Templates (4) | **All benign (415)** |
|---|---:|---:|---:|---:|---:|---:|
| Before (as in production) | 4 | 1 | 0 | 0 | 0 | **5** |
| Badges only, no clean-up of cut links | 2 | 0 | 0 | 0 | 0 | 2 |
| **After (shipped): status badges dropped + clean-up of cut image and link fragments** | 1 | 0 | 0 | 0 | 0 | **1** |
| Plus: code removed | 0 | 0 | 0 | 0 | 0 | 0 (rejected, below) |
| Plus: code reduced to its comments and sentences | 3 | 2 | 0 | 0 | 0 | 5 (rejected: no better than before) |

Attack recall of Prompt Guard 2 alone (share of the attack texts scored at 0.5 or above), same variants:

| Attack set | Texts | Before | After (shipped) | Code removed | Code reduced |
|---|---:|---:|---:|---:|---:|
| deepset, English | 132 | 27.3% | 27.3% | 27.3% | 27.3% |
| deepset, German | 57 | 10.5% | 10.5% | 10.5% | 10.5% |
| yanismiraoui, pt | 117 | 20.5% | 20.5% | 20.5% | 20.5% |
| yanismiraoui, es | 118 | 11.0% | 11.0% | 11.0% | 11.0% |
| PrevenIA, es | 244 | 13.5% | 13.5% | 13.5% | 13.5% |
| zn, pt | 227 | 9.3% | 9.3% | 9.3% | 9.3% |
| zn, es | 227 | 8.8% | 8.8% | 8.8% | 8.8% |
| 640 nightly attacks of 2026-10-15, embedded as the harness does (`embedAttack`) | 640 | 50.9% | 50.9% | 50.9% | 50.9% |
| the same 640 hidden inside a fenced code block | 640 | 50.8% | 50.8% | **0.0%** | 50.8% |
| planted `evals/fixtures/injection*.md` | 3 | 100% | 100% | 100% | 100% |

* The shipped preparation loses **no recall on any set** (0.0 points).
* Removing code clears the last false positive but loses every attack hidden in a code block (50.8% to 0%): rejected. The detector comment always said code must stay, and now there is a number for it.
* Keeping only the comments and sentences of a code block keeps the recall but not the false-positive gain (5 flagged), so it is rejected too.
* The shipped change is `prepareForDetector` (status badges, recognised by their address: shields.io, badge services, coverage and CI services) plus a clean-up of cut `![` and `](` fragments in `plainText`. Every other image keeps its alt text, a link keeps its text and title, code stays.

### Known false positive that is left

| Document | Score | Why it stays |
|---|---:|---|
| `andersontr15/clean-code-javascript-es` (Spanish translation of a code-style guide) | 0.977 | the document is code samples plus imperative advice; removing the code would remove the recall on attacks hidden in code, and the model itself reads the Spanish imperative titles as instructions |

### The wide benign base (722 real READMEs: 470 English, 139 Portuguese, 113 Spanish)

Same measurement on a much larger set of real READMEs (kept outside the repository), documents processed one at a time. "Before" and "after" are the detector as in production and as shipped here.

| Real READMEs | Documents | Detector before | Detector after (shipped) | Keyword rules mark | Detector after AND a rule |
|---|---:|---:|---:|---:|---:|
| English | 470 | 26 (5.5%) | 11 (2.3%) | 27 (5.7%) | 4 |
| Portuguese | 139 | 0 | 0 | 3 (2.2%) | 0 |
| Spanish | 113 | 1 (0.9%) | 1 (0.9%) | 6 (5.3%) | 0 |
| **All** | **722** | **27 (3.7%)** | **12 (1.7%)** | **36 (5.0%)** | **4 (0.6%)** |

The preparation more than halves the detector's false positives here too (27 to 12) and never raises one: every document that was below 0.5 stays below. The recall table above is unchanged. What is left after the preparation (12): `JuliusBrussee/caveman` (0.99), `anthropics/skills` (0.996), `dylanaraps/pure-bash-bible` (0.978), `elastic/elasticsearch` (0.987), `ytdl-org/youtube-dl` (0.994), `MichaelCade/90DaysOfDevOps` (0.869), `lhartikk/ArnoldC` (0.883), `jaywcjlove/awesome-mac` (0.718), `crytic/echidna` (0.705), `yt-dlp/yt-dlp` (0.67), `ryanmcdermott/clean-code-javascript` (0.618) and the Spanish clean-code guide (0.977): documents about prompts and skills, shell and command-line tutorials, and code-style guides. These are the known false positives of the detector; the model reads imperative documentation as instruction.

**Not a detector finding, but found by this base and not fixed here:** the keyword rules mark 36 of the 722 real READMEs (34 flag only, 2 **blocked**). The two blocks are `gkd-kit/gkd` and `mastodon/mastodon`, both by the `encoded_payload` check (a base64-looking run decoded as readable text): a legitimate README rejected before the model, 0.28% of real READMEs. The flags are phrases such as "system prompt" (8), "override ... instructions" (5), "reveal ... prompt" (4), "you are now" (3), "developer mode" (3), all in documents that talk about prompts or AI tools. Marking is harmless (strict link mode and a metric); blocking is not.

So the measured false-positive rate of the detector is **1 of 415 benign documents (0.24%)**, down from 5 (1.2%), and 1 of 98 real READMEs (1.0%), down from 5 (5.1%). On the wide base: 12 of 722 (1.7%), down from 27 (3.7%). It never went up on any set.

## Would a block mode ever be safe? (measurement only, nothing changed: the default stays `flag`)

Short answer: no, not on the evidence of the wide base. On 722 real READMEs the keyword rules alone would reject 36 (5.0%), the detector alone 12 (1.7%), "both agree" 4 (0.6%), "either" 44 (6.1%). The table below is on the smaller 415-document benign set, where the rules happen to mark nothing.

Share of documents each policy would stop. Benign = the 415 benign documents (false-positive rate); attacks = the 640 nightly attack texts embedded in READMEs. `t` is the detector threshold.

| Policy | False positives on benign | Attacks stopped (640 nightly) | Same, attack hidden in a code block |
|---|---:|---:|---:|
| Keyword rules alone | 0 of 415 (0.0%) | 73.4% | 73.4% |
| Detector alone, t = 0.5 | 1 (0.2%) | 50.9% | 50.8% |
| Detector alone, t = 0.9 | 1 (0.2%) | 50.6% | 50.5% |
| Detector alone, t = 0.99 | 0 (0.0%) | 31.1% | 20.9% |
| Both agree (detector >= 0.5 AND a rule) | 0 (0.0%) | 37.7% | 37.5% |
| Both agree (detector >= 0.9 AND a rule) | 0 (0.0%) | 37.5% | 37.3% |
| Both agree (detector >= 0.99 AND a rule) | 0 (0.0%) | 23.3% | 15.2% |
| Either (detector >= 0.5 OR a rule) | 1 (0.2%) | 86.7% | 86.7% |
| Either (detector >= 0.99 OR a rule) | 0 (0.0%) | 81.3% | 79.2% |

Reading it:

* "Both agree" is **strictly worse than the rules alone** here: it stops fewer attacks (37.7% against 73.4%) for the same zero false positives, because every attack the detector flags that the rules also flag is already stopped by the rules. The second signal only helps when it is an "or".
* "Either" at t = 0.99 stops 81.3% (against 73.4% for the rules) with 0 false positives on these 415 documents. That is the only combination that adds coverage without a measured false positive. It rests on a small benign sample (415 documents), and the 722-README base shows how little that proves: there the same detector flags 1.7% and the rules mark 5.0%. 0.99 was not re-run on the wide base. Not a candidate for `block`; a candidate for a trial in `flag` mode with the metric `InjectionDetected`.
* The detector on its own misses about half of what the nightly sends (50.9%) and 73% to 91% of the public pt/es/de datasets. It adds recall on top of the rules, it is not a replacement.

## Reproduce

`pnpm exec tsx promptfoo/redteam/replay/detector-prep.ts` (needs the Prompt Guard 2 model in the transformers cache, the real README texts in `.local/` fetched as described in `guard-pt-es.md`, the datasets of `fetch-ptes-datasets.ts` and the 640 attack texts of a nightly run as `.local/s3/attacks.json`). `detector-fp.ts` re-measures the shipped detector (and the previous DeBERTa, without the preparation) on the benign sets.
