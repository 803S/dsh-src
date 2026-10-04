# Component UI verification

Actual `EgressControls.tsx` bundled with React/ReactDOM; command transport is a local capture stub. Chrome uses a temporary clean profile. This verifies the component, not a running production DSH application.

Checks: empty scope disabled; multiline origins serialized as exact JSON; status/review commands; invalid/short reconciliation evidence disabled; evidence + approval id produce expected reconcile command. Desktop and 390px viewport screenshots visually checked: labels, wrapped explanations, inputs, buttons and result region readable without horizontal overflow.

Reproduce: copy `entry.tsx` as `src/dsh-client-ui-src/.egress-qa.tsx` and `tsdown.config.ts` as `.egress-qa.config.ts`; build from that directory using `node node_modules/tsdown/dist/run.mjs -c .egress-qa.config.ts`. Copy `index.html` and `run.mjs` to `/private/tmp/src-egress-ui-qa/`, then run `node /private/tmp/src-egress-ui-qa/run.mjs`. Remove the two temporary source/config files afterwards. Local fixture sets process.env shim; production UI uses its existing bakeNodeEnv build plugin.
