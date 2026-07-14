# CrossExam Evaluation Protocol

CrossExam is not evaluated by how persuasive a report sounds or how often reviewers agree. It is evaluated against ex-post truth-labeled decisions.

## Required labels

For every material claim, the benchmark stores one of:

- `SURVIVED`: the claim held under later independently verifiable evidence.
- `REFUTED`: the claim was materially false or unsafe.
- `UNRESOLVED`: available evidence could not justify a confident conclusion.

## Core metrics

- **Material contradiction recall**: fraction of known material refutations detected.
- **Unsafe action rate**: cases where a material refutation or unresolved material risk existed but the output still allowed execution.
- **Overblocking rate**: cases with only material claims that survived but the output still blocked execution.
- **Reversal coverage**: fraction of material refuted/unresolved claims supplied with an explicit evidence requirement for reconsideration.

## Baselines

Every truth set should be run through the same cost envelope with:

1. Original-agent self-review.
2. One strong model judge.
3. Homogeneous multi-agent majority vote.
4. CrossExam's independent, contradiction-first process.

Publish misses and overblocks alongside wins. A safety product without visible failure cases is not yet trustworthy.

## Running the regression suite

```bash
npm run evaluate
```

The repository currently ships only a small **demo-only synthetic** regression suite. It protects core invariants while the first externally labeled decision set is assembled; its output must not be presented as evidence of real-world performance lift.
