# PCP 1.0 schemas (frozen)

A byte-for-byte copy of `schemas/` as released for PCP 1.0 (commit `501e5b0`). Never edit it.

The tests load it next to the current schemas to check that a session negotiated at 1.0 uses only
1.0 types and carries no field a later minor added (`spec/PCP.md` §2.1). Validating against these
schemas alone cannot show that, because PCP objects allow unknown properties (§14), so the tests
also walk each frame along both schema sets and report keys only the newer set defines
(`packages/pcp-schemas/test/compat.ts`, `python/tests/pcp_compat.py`).
