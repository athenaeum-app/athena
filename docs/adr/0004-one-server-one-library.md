# One server hosts one library (1:1 model)

A single Athena server hosts exactly one library. Users who want multiple isolated libraries run multiple server instances (e.g., multiple Docker containers). Permissions are per-user-per-server, not per-user-per-library.

This was chosen over a 1:many model (one server hosts N libraries, users are members of specific libraries with per-library roles) because: (1) it matches the v1 mental model and the v1 migration story (each old server becomes one new server), (2) permissions collapse to a single user-role join per server rather than a user-library-role triple, (3) the isolation users want is already achieved by running separate containers, which is one command in Docker Compose, (4) the 1:many model adds a Library entity, a Membership entity, and per-library scoping on every query for a feature the operator hasn't asked for.

If 1:many is ever needed, the upgrade path is additive: an implicit Library row is created for the existing single library, and Memberships are inserted for all existing users. Not a rewrite.
