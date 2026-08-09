# AO / OR effect-boundary migration

Issue #22 freezes the production boundary as:

```text
AO judgment (`release_ready`) -> OR exact-live preflight -> OR merge effect
-> authoritative GitHub post-effect observation -> completion evidence
```

`ao.or-merge-preflight.v1` is deterministic and fail closed. It composes the
durable OR authorization grant with the AO judgment and a fresh GitHub
snapshot. Repository, task, PR, base, head, independent PASS, unresolved
threads, and every required check must bind exactly. Its authorization is for
OR only and its record explicitly claims neither dispatch nor merge.

`ao.github-merge-observation.v1` is the post-effect authority. A merge outcome
is confirmed only when GitHub reports `MERGED`, the observed PR head equals the
governed head, and a merge commit, merge time, PR URL, and immutable evidence
reference are present. A command receipt, successful dispatch, review PASS,
missing readback, or mismatched head produces a blocked unknown outcome.
Unknown effects must not be replayed automatically.

The unused AO `auto_merge_ready_pr` executor has been removed. Its legacy
vocabulary is retained only for immutable history and deprecation findings;
the action model marks it `legacy_auto_merge_executor_removed_or_effect_only`
and exposes no remote-effect executor. This is intentionally not a migration
of merge execution into AO.
