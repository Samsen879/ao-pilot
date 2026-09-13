# Original AO browser Dashboard

This workspace contains the complete original Next.js browser application,
its API routes, terminal servers and required core/plugins. SOURCE_IMPORT.json
records the original commit and file hashes. Application pages, components and
CSS are not redesigned. Run `node scripts/verify-browser-source.js` from the
ao-pilot repository root to verify visual source preservation.

Install and build independently of the retired checkout:

```
cd browser
npm ci
npm run build:deps
NODE_ENV=production npm run build
```

Start with the original configuration path to preserve its hashed session
namespace. Moving the configuration file changes that identity and is NOT a
session migration:

```
AO_CONFIG_PATH=/home/samsen/agent-orchestrator.yaml \
AO_DASHBOARD_READ_ONLY=1 AO_DASHBOARD_AUTOMATION=0 \
npm run start:all --workspace @composio/ao-web
```

Next.js and both terminal servers bind 127.0.0.1. During validation API writes
are held. Lifecycle reactions and backlog dispatch require explicit
AO_DASHBOARD_AUTOMATION=1; page loading does not dispatch workers by default.
This compatibility backend reads existing flat-file session metadata; it is
not proof of native database/conversation migration or live session recovery.

After committing the candidate, `node scripts/deploy-original-dashboard.js
--deploy` from the repository root builds a fresh SHA-named installation,
records commit/tree/lock/build provenance, then backs up and replaces only the
Dashboard user service. It refuses to overwrite an existing installation and
does not switch services if the install or build fails.
