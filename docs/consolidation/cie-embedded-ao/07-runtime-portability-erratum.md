# Runtime Portability Erratum

This clarification supersedes any reading of the canonical consolidation
reports that treats package/source consolidation as a proof of operational
runtime portability.

The consolidation result remains valid for its audited scope: `ao-pilot`
became the canonical generic control-plane package boundary and the downstream
embedded generic core was removed. The consolidation explicitly left live AO
sessions, startup, runtime state, publication and remote runtime binding outside
its migration surface.

The later P0 incident established that `ao-pilot@0.2.0` did not provide a
deterministic external runtime lock or bootstrap, did not expose
`ao-pilot start`, and still allowed `scripts/ao/start-clean.sh` to select an
unverified PATH `ao`. Consequently:

- package installation and public API verification remain accepted;
- operational runtime portability is not established;
- fresh-workstation self-hosting is not established;
- no AO Upgrade implementation child after P0-R01 is admitted merely because
  the consolidation package gate passed;
- only P0-R08, executed by a newly bootstrapped AO on a new workstation, can
  close the self-hosting claim.

The authoritative incident inventory and claim ledger are in
[`P0-R01_INCIDENT_BASELINE.md`](../../runtime-portability/P0-R01_INCIDENT_BASELINE.md)
and its linked machine-readable artifacts. This erratum preserves the original
reports and their exact historical evidence rather than editing history into a
claim they did not prove.
