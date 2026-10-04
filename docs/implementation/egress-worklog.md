# Active implementation checkpoint — not a completion report

User goal: 全部做完再去验证，最后汇报. No scope reduction; no production deployment/restart. Continue coding before final validation. Goal remains active.

## State after continuation 1

The earlier isolated core tests passed; they do NOT cover the following newly written integration code. Per user instruction, defer rerunning validation until integration is complete.

Added (not yet wired into cordis/apply):
- `lib/src/egress/proxy-process.js`: owned session proxy process, immutable environment/config, private CA and public certificate copy, failure/teardown.
- `manager.js`: lifecycle, private HMAC key, trusted per-session scopes, pending approval store bridge, single-flight on-demand request plans, per-session proxy/control sockets, guarded direct target fetch.
- `runtime.js`: AsyncLocalStorage around actual dispatch, target transport routing seam.
- `http-dispatch.js`: no-redirect/no-retry bounded Node HTTP sender.
- `lib/src-egress.js`: lazy host singleton; no proxy overhead for non-SRC sessions.
- `lib/src-bash-executor.js`: native SandboxBashExecutor subclass final spawn restriction, including full-access; no replacement tool required.
- `user-commands.js`: verifies actual DSH command/run event (rc.8 invocation has commandId but NO source), scope command + review command.
- `host-integration.js`: dispatch context/identity and initial fail-closed unadapted-tool list, control path checks for native file tools.
- Broker `find` for exact existing plans; control server now awaits async claims.
- Package exports/optional sandbox peer added.

## Next work (required, not optional)

1. Finish lifecycle/security of these modules before wiring. Manager/proxy/advisor pending request must not be a bypass of unapproved variants. Protect entire control/deployment filesystem against host tools and aliases; current file-path guard is initial only. Broad `src_*` allow in integration is NOT an audited sending allowlist yet. Exposed paths, private socket dirs, sessions, model settings and system IPC all need coverage.
2. Pending/denied requests need resource-level anti-laundering guards (not just byte-identical digest) so variant bodies/headers/query cannot inherit auto permission. Durable tombstones + scope/policy/credential invalidation; no silent fresh plan after budget exhaustion, unknown dispatch or human rejection. Bound in-memory tasks/control connections/evaluation queues. Startup/restart pending reconciliation and auth/source validation must be finished.
3. Wire host service & versioned bash provider into cordis patch; `src.js` apply installs middleware and routes makeHttpFetch via ALS. `src_http` must skip old independent risk+approval when managed and keep evidence; ALL built-in target sends/legacy HTTPS fallbacks/capability subprocesses must route through controlled transport/provider. No provider fallback on error.
4. `src_scan_surface` must propose ONE exact bounded plan BEFORE preflight, including UA bypass variants and root repetitions, then reuse authorization. Add model-facing task planning tool for arbitrary bash scanners (exact request manifest, not command-name permission). Unknown scripts still bounded at actual egress. Header normalization/proxy defaults must match emitted requests without hiding semantic headers.
5. Hook `src-approve` to manager for TASK/request rows BEFORE generic token/replay. `src_resolve_approval` cannot execute TASK rows, grant tokens issued only after actual user command validation. Existing UI must show plan scope/limits/body summaries and result; no raw credentials.
6. Implement single-request high-risk approval execution and write protections across JSON/XML/text, DELETE and hazardous GET/POST (preconditions, original backups, effect/recovery plan, immutable request/credential binding, explicit approved restore, postcheck). Current broker rejects non-read approval with WRITE_EXECUTOR_REQUIRED; this is NOT the requested completed flow. Human should not need to resend curl after approving a captured single request; broker sends saved request exactly once (or unknown, no retry).
7. Browser/Burp/MCP/PTY/system IPC sending must either have real controlled adapters or be explicitly unavailable, not merely prompt rules. Shared Burp JVM unconfined cannot be treated as guarded. Local file operations still use native DSH permissions. Need OS platform confinement proof against Apple Events/Mach/launchctl, file planting and same-UID process control.
8. Inspect all currently marked UNADAPTED paths and implement appropriate transport adapters (public lookup capabilities separate trusted sources, never arbitrary relay exemptions), rather than silently breaking all research to pass tests.
9. Once complete: core + full regression + typecheck + preset budgets + package, actual installed isolated DSH provider/prompt sessions with real Jev and real authenticated UI allow/reject, adversarial cross-session/bypass/restart/unknown tests, latency/RSS measurements. Existing hy4 upstream alias hy4-preview failed 400 model_not_found on last probe; inspect user configured models without silently rewriting production config. No test passing solely on no calls.
10. Completion audit against architecture docs and user scope; do not mark goal complete until all required evidence exists. Production deployment only if explicitly authorized; don't conflate implementation with deployment.

## Known implementation caveats to address

- Manager stores scopes via atomic rename but not fsync; comment corrected not to claim fsync.
- Scope setter should validate persisted file fully and restrict control/internal origins except local test fixtures; DNS rebinding/proxy recursion must be accounted for.
- Proxy control socket uses private `/private/tmp/src-egress-*` to avoid macOS socket path limit. Protect these dirs from model native fs tools too, not only shell.
- Direct target fetch must preserve requested bytes/headers and account for transport framing; cancellation currently needs combined outer+inner signals.
- Manager evidence persistence after send must not cause replay; all claims/outcomes (including proxy response evidence) need observation integration.
- Proxy callback can take Jev latency > current 3s Python control timeout; need bounded async plan queue/pending fast response, not let timeouts misclassify request flow. Claims never sent remain conservatively occupied until reconciliation.
- New host guard blocks unknown non-src tool names; actual native names/jobs/delegation filters must be reconciled against available tool registry. Provider identity checks must tolerate actual DSH policy string identifiers but never missing SRC context.
- No tests run for continuation 1 code; do not quote earlier 316 tests as proving these new changes.

## Continuation 2 progress (implementation, not validation)

- Added durable gate_members + resource blocks to ledger: method/body/header/query/encoding variants on pending/rejected/unknown resources cannot get independent automatic grants. Restart persists pending/unknown blocks. Exact lookup now consults SQLite rather than only memory, preventing expired-memory eviction from silently creating fresh permission.
- Broker bounds retained plans (128) and parallel advisor evaluations (4), checks confidence upper bound, HMAC-binds canonical resource identity.
- Added single public plan presentation function (no base64 credential leak); manager preserves header pairs and combines cancellation signals.
- Added scan-plan builder including preflight root, path repetitions and exact UA variants. `src_scan_surface` prepares plan before preflight and binds every transport call to task ID; gate errors propagate instead of becoming network-error retries.
- Added explicit `src_egress_plan` registration helper for bash scan manifests, plus manager's per-session shell plan binding. Binding disables on-demand plan creation for out-of-manifest requests.
- These additions remain unvalidated per requested implementation-first workflow. Cordis/src apply and task helper still need activation after other sending paths are audited.

Additional next work:
- Resource blocks currently have no trusted manual reconciliation path. Implement audited, explicit human reconciliation of stale/rejected/unknown requests without replay; don't leave legitimate recovery permanently impossible. New task after reconciliation must still require fresh explicit authorization.
- `find` intentionally sees old durable expired/revoked plans. Explicit new task can replace normal exhausted work; never auto-create it behind caller's back.
- Advisor/control timeout still needs asynchronous pending queue; queue must be bounded, stop after shutdown, and never send after socket timeout.
- Scan shared delay currently max20*250ms and native worker signals timeout5000ms; reconcile queue/concurrency/rate so normal large scan doesn't falsely fail while maintaining bounded waits.

## Continuation 3 progress (implementation, not validation)

- Wired default bundle host service + versioned bash provider; SRC apply installs dispatch context and task tool when service is present. Production profiles have NOT been deployed/restarted. Installed next build will use this path.
- Routed makeHttpFetch and legacy TLS fallback through managed transport while inside SRC execution context. Added managed src_http branch, preserving snapshots/observation capture and skipping old duplicate Jev/approval flow.
- Existing src-approve now handles TASK rows in manager before generic token/replay; real DSH command/run identity checked. Generic src_resolve_approval explicitly refuses TASK rows. Token mint moved after row/source validation.
- Local bash before scope setup now can start with a deny-target proxy (target sends still require scope), preserving local-file usability. Public CA moved out of private DSH home; dedicated read-only-path protection added to executor.

Remaining completion requirements still apply; especially no claim of safe rollout yet:
- High-risk single request host-only approval/execution lane must be implemented next. Current TASK allow only activates read scan; this still does NOT fulfill captured high-risk replay requirement.
- For high-risk writes, do not simply expose approveWrite boolean or activate proxy allowance: a model retry could race the safety executor. Need separate host-only ledger claim lane that dataPlane can never consume, frozen safety/precondition/backup/verification plan, and no resend after uncertain effects.
- Generic dangerous GET/POST cannot use same-URL GET as an assumed safe pre-read (it might itself trigger deletion). Require explicit approved verification read endpoint; legacy safetyPlan schema needs extension.
- Broad src_* allowlist and unadapted tool handling, arbitrary fs-tool access/aliases/private temp dirs, system IPC, manager evidence and scope origin validation are still unfinished.
- No tests yet for continued changes, per implementation-first request.

## Continuation 4 progress (implementation, not validation)

- Added explicit safety-plan normalization/executor: complete request bytes, declared effect/object/recovery, separate approved precondition + verification GET/HEAD with status/body hashes; replace/delete require checked original snapshot. JSON PUT retains existing fields; non-JSON gets exact snapshot/precondition handling rather than bypass. External effects require explicit irreversible acknowledgement. Dangerous GET cannot use itself as pre-read.
- Added host-only ledger execution lane. Proxy/dataPlane cannot consume approved mutation requests or their safety steps. Manager executes the approved frozen request plus bounded pre/post reads directly after user command, without requiring a model curl retry. CAS and consumed budgets remain enforced.
- Added quarantine after uncertain send/failed verification, including post-response evidence failure: resources remain blocked across variants and future plans; no compensation/retry.
- Extended src_http safety material schema and snapshotSha256 result; unified public projection masks nested host-execution request/credential material.
- Non-risk/read automatic path still uses ordinary plan; explicit safety material forces human host-only plan. Shell-captured dangerous requests without safety are still pending but not yet preparable for host execution. Next implement preparation/supersession tool and command-only reconciliation so this is a complete flow, not a permanent rejection.
- `hostExecution` is an internal request mode; manager rejects it from public propose/task arguments. Pending row includes sanitized safety material.
- Still no tests of these continuation changes. Need validation only after all required wiring/tool/IPC protections and recovery workflows are complete.

Important next issues:
1. Captured single pending plans need conversion into host-only lane without second Jev call, with exact original bytes retained. Preparation must replace only never-decided pending records, invalidate old UI IDs, rebind digest, transfer resource locks atomically. Missing safety must not silently activate a proxy write allowance.
2. Safety operation claims pre/read/main share max3 requests and resource locks. Expected verification body hash is strict; consider deterministic supported verification for create responses without pretending arbitrary dynamic response bytes known in advance.
3. Safe read single approvals should dispatch immediately too; scan plan approvals merely activate the plan. distinguish explicit batch vs on-demand single in manager/broker metadata.
4. Ledger hostExecution payload currently only in private memory; restart invalidates appropriately, but stale pending UI reconciliation still needed.

## Continuation 5 progress (implementation, not validation)

- Added atomic pending-plan supersession: exact original request retained, additional safety/readback entries rehashed; old task becomes superseded and its pending resource locks transfer. Rejected/used/active requests cannot be rewritten. No second Jev call to attach single-execution material.
- On-demand pending requests now become host-only singles before UI publication. Plain non-action-like read can be explicitly approved and immediately dispatched; dangerous single requires safety material. Added `src_egress_prepare` to supplement the captured request and create a NEW approval ID, invalidating the old one.
- Added trusted `/src-egress-reconcile`: verifies actual user command event, requires disposition and substantive evidence, refuses live dispatches; never sends. Durable audit + per-resource force-human marker ensures clearing a stale/rejected/unknown lock cannot restore auto approval. Explicit new task is required.
- Private proxy claim now returns ASSESSING_NOT_SENT promptly on first unknown request; bounded advisor preparation continues without consuming a dispatch. Next known request or human command can proceed. Avoids Jev latency causing an abandoned control socket to claim a request after timeout.
- Control socket supplies cancellation to claims, bounds TCP connections, and marks an acquired-but-disconnected dispatch unknown rather than silently releasing/retrying. Native target transports retain bounded waiting; proxy waits stay below its 3s RPC timeout.

Next finish: active sending tool audit/adapters, filesystem and IPC isolation, complete evidence including proxy response capture, persisted scope validation/DNS pins, stale UI reconciliation and session/job lifecycle, then full validation. Newly added code still unvalidated per request.

## Continuation 6 progress (implementation, not validation)

- Strengthened final spawn profile with Mach/AppleEvent/IPC/process-info restrictions and cross-process signal restrictions; protected OS/user autostart/config paths against file planting. These exact SBPL operations MUST be validated on real macOS before declaring support (unknown operation must fail closed, never strip a rule to make tests pass).
- Native read/write/edit now execute bounded UTF-8 operations inside the same constrained shell with native standing filesystem policy. This removes the host-side realpath→read race against a model-created symlink. Explicit file-tool escalation is rejected with guidance to use original bash/native escalation, not silently widened.
- Fixed job tool names. File search/image host reads are temporarily blocked pending constrained implementations; do not forget user local workflow compatibility in completion audit.
- Added fixed host-only public search lookup lane (known HTTPS origin+path, one bounded q/wd query, safe headers, GET only, rate and count budget). Only web_search/src_collect_dorks can use it; shell/target tools cannot use a search URL as proxy exemption. Re-enabled public web search/dorks and guarded passive target collection.
- src_add_capability now blocked (it spawns installer commands). Capability senders remain unadapted; implement controlled shell execution instead of blanket disabling required capabilities.

Still required: exact allowlist audit of all SRC tools; helper/document/skill filesystem read paths; supported constrained file search/images; capability subprocess routing; DNS pinning and protected local/control origins; complete response evidence from proxy and host; bounded lifecycle/restart/UI reconciliation. Then validation of full implementation, not a partial happy-path report.

## Continuation 7 progress (implementation, not validation)

- Added centralized gate evidence recorder, wired to host singleton: full request identity + bounded sanitized response + source task/dispatch, optional original GET snapshot/sha. Proxy now returns response status/headers/body through private finish endpoint; evidence persistence occurs before finishing ledger claim. Evidence failure leaves outcome unknown, not a fresh permission.
- Added strict scope storage validation and DNS pinning at explicit user scope confirmation. Public addresses only in ordinary manager; private loopback fixture capability is constructor-only and not model-settable. Direct Node sender uses pinned lookup; proxy receives pinned address+port and retains original SNI/Host. This removes unapproved DNS rebinding into local/control networks.
- Public search sends also resolve/check public addresses and pin each connection.
- Grant now carries scope/credential revisions; manager checks them immediately before native dispatch or returning proxy connection parameters. Scope changes don't reroute an already-claimed request using unrelated new pins.
- Existing task-gate fixture must be updated during validation to provide upstreamAddress/upstreamPort and response evidence; omission now fails closed rather than silently resolving targets directly.

Still remaining: capability runners and exact sending-tool allowlist, confined search/image compatibility, document/skill read protection, manager bounded jobs/stale UI lifecycle, UI scope/review usability, legacy global approval lock collisions, final full safety/performance/real DSH/Jev/UI validation. All continuation code remains unvalidated so far.

## Continuation 8 progress (implementation, not validation)

- Added confined glob/grep using real ripgrep, and confined image byte reads followed by DSH attachment save/validation. Re-enabled these native tool names; host no longer reads untrusted paths directly. Text payloads now use subprocess stdin instead of shell argv-size-limited JSON; image output bounded by attachment limits.
- Capability scripts now route through the versioned constrained native shell whenever inside SRC execution context, including legacy RUN approval resolution. Re-enabled src_run_capability; capability installer/test MCP handshake remain explicitly unavailable.
- Capability document bytes now read via constrained subprocess. Trusted installed capability roots are read-only; SBPL read exceptions allow their code under private DSH home without granting access to other secrets. Model cannot change manifest through src_add_capability; control-root overlap rejected.
- Native standing sandbox policy retained for local filesystem writes and capability process cwd. No extra target authority comes from approved script name; actual requests still use bound task or on-demand single gate.

Next tighten capability-root validation: disallow roots overlapping ANY protected control/config/deployment path, not only control/. Prevent custom roots such as ~/.dsh/storages or profiles from becoming read exceptions. Also include symlink-realpath aliases for DSH home and platform read-only paths. Need audit other document/lesson/skill host reads (generic skill loader can execute no network but may read planted links), exact tool allowlist, bounded manager lifecycle/UI, legacy locks, then verification.

## Continuation 9 progress (implementation, not validation)

- Replaced blanket src_* allowance with an explicit current audited catalog; newly registered plugins cannot gain execution access merely by naming themselves src_*. Unsupported external MCP/browser/PTY routes remain denied at runtime.
- Capability read exceptions now reject overlap with DSH control, state DBs, session logs, settings, deployment profiles/tools, credentials, manifests or this package. Added canonical DSH_HOME alias protection.
- Protected project instruction/skill configuration directories against model planting or overwriting files consumed by unsandboxed host loaders. Ordinary project source files remain locally editable under standing native policy.
- Reviewed real native skill provider interfaces: default project/user loaders read via host fs. Initial trusted-host loading remains a trust boundary; if adding model-driven new skill sources, must use constrained document reads rather than arbitrary host reads. Existing capability document path now constrained. Distilled lessons are in protected DSH storage; custom lesson directory still must be read-only to shell (add this next).

Immediate remaining implementation tasks: public survey source adapter (fixed endpoints), manager resource/cleanup limits and cold approval UI handling, UI scope/task review controls, repair legacy lock session identity, user-visible protocol reflecting forced egress rather than telling model not to use curl. Then final implementation audit followed by full tests/real DSH/Jev/UI adversarial validation. Do not continue expanding architecture unnecessarily.

## Continuation 10 progress (implementation, not validation)

- Added UI controls inside approvals pane for exact origin confirmation, current scope/status, full sanitized plan review and explicit evidence-based reconciliation. Empty approvals still show scope setup. Command transport is existing authenticated DSH command API, not a new approval platform.
- Repaired legacy compatibility lock identity (session+id), cross-process serialized atomic writer with fsync, corruption handling, and bridge malformed request handling. Ownerless old locks remain rather than being incorrectly removed by a different session. New authoritative gate remains SQLite, not this compatibility file.
- Added fixed-endpoint public survey lookup adapter for FOFA/Agniops/Certspotter, strict domain/page/query/header shapes and public DNS pins. Re-enabled src_survey_seed. Environment override endpoints outside fixed catalog do not inherit the public lookup exception.
- Custom distilled lesson directory now read-only to constrained execution.

Remaining before final validation: manager lifecycle bounds/stale row reconciliation; protocol/description corrections; verify implemented scope vs unsupported tools and deliberate fail-closed states; then run all tests, compile UI, package, actual isolated DSH (no production), real Jev and authenticated UI approval, OS/adversarial checks and resource measurement. Existing docs/earlier tests do not prove new code.

## Continuation 11: implementation integration and first current validation

Completed bounded manager shutdown and cold-review handling; scope persistence is serialized + file/directory fsynced. Proxy count is capped at 4 (no unsafe idle eviction/port replacement under background jobs), scope rows at 1024, pending-memory rows at 128 with expiry pruning. Shutdown cancels assessment/target execution and drains owned work before closing ledger. Failed proxy spawn no longer waits forever for an exit event that never occurs.

Fixed **real defects found during current verification**:
- A continuation left trailing fragments of a UA array after `SCAN_BYPASS_AGENTS`; this caused syntax failure in the full SRC tools module. Removed corruption.
- `src_resolve_approval` snapshotSha256 output was missing its strict schema field.
- SRC must declare `srcEgress` as a required Cordis dependency. Optional `ctx.get` alone allowed registration before the host singleton existed; added required inject dependency. Manual legacy unit harness still does not activate middleware, so old integration passes do NOT prove production gate wiring.
- Shared SrcStore disposal previously closed the DB while the host gate/other child stores still owned it. Added shared-promise owner counting, last-owner closure, explicit closing state, cache removal, plus regression test.
- Human batch approval no longer grants action-like GET endpoints; these need the host single safety path rather than a scan allowance.
- On actual macOS 26.6.2, denying all `process-info*` made `/usr/bin/curl` SIGTRAP in libdispatch (unique PID lookup). Added only `(allow process-info* (target self))`; cross-process inspection, Mach, AppleEvent, IPC and networking restrictions remain. This was diagnosed from the local synthetic curl crash report, not by deleting safety restrictions.
- Actual curl adds `Proxy-Connection: Keep-Alive`. Addon now validates exactly one benign keep-alive/close value and strips it **before both review and sending**, so it cannot be a forwarded header or hidden request semantic. Other forbidden headers still reject. Proxy errors now expose only an allowlisted machine error code, no private diagnostics.
- Managed src_http model-visible response clipped to 2KiB (32KiB with full), while evidence remains separately bounded. There are still two deliberately independent evidence writes on managed src_http; consolidation/intent linkage needs completion audit.
- Protocol now distinguishes asset inventory from exact user-confirmed scope, describes one-task assessment and per-send matching, host single execution, and unavailable tools honestly.

Current verified evidence (`docs/evaluation/egress-managed-20261004/`):
- `npm test`: **321 passed / 0 failed** after implementation repairs (run before final two extra tests were appended).
- `node --test tests/egress-gate.test.mjs`: **41 passed / 0 failed**, including 5 new manager end-to-end state tests, shared store lifetime and dangerous GET batch denial.
- UI typecheck passed; UI client bundle rebuilt successfully.
- preset consistency/budgets passed; npm pack dry-run passed; git diff --check passed.
- New `scripts/egress-feasibility/manager-probe.mjs` ran actual owned mitmproxy + real macOS final-spawn SBPL + local HTTP target. Exactly one approved GET reached target, one Jev **synthetic** plan assessment, one evidence record; budget reuse and DELETE rejected; direct curl/Python sockets, control-key read and System Events `count processes` AppleEvent rejected; local create/overwrite/delete worked. No remaining probe proxies found after cleanup.
- `get name` AppleScript is not an IPC proof (it resolves the application name without necessarily sending an event); fixture correctly uses `count processes` instead.

**Not complete / do not report ready for production:**
1. Real DSH validation must use the newly registered provider, actual managed middleware, host service and authenticated commands. Old dsh-run harness monkeypatches shell and injects a separate synthetic broker, so it is NOT sufficient. With required `srcEgress`, it must be updated rather than quoted as current passing evidence.
2. Local repo node_modules lacks dsh-bash-sandbox; installed production package DOES export SandboxBashExecutor. Build an isolated fixture node_modules that resolves installed host dependencies rather than symlinking repo/node_modules wholesale. Do not install/modify production profiles. Current package peer is optional; deployment/compatibility contract must be audited.
3. Old `task-gate-fixture.mjs` still lacks pinned address in claim result, and uses `/redirect` now disallowed as a batch hazardous endpoint. Update fixture to a neutral synthetic path redirecting to a forbidden destination, not weaken production rules for tests.
4. Need actual isolated DSH model/Jev/user approval checks, HTTPS fixture with trusted fixture-only CA (do not disable production TLS verification), capability/file-tool/child/background/fullaccess checks, proxy kill/restart/unknown tests, resource measurements and final cross-sender audit.
5. Manager cap4 prevents unbounded proxies but there is no trusted session teardown/release wiring yet; never silently evict live-job proxy ports. Need decide safe lifecycle integration against real native job/session APIs. Public lookup map512 currently exhausts fail-closed rather than pruning.
6. Initial host skill loading remains trusted boundary; blocked unsupported browser/MCP/proof/installer tools and local project protected paths must be explicitly evaluated for required workflow compatibility, not silently called complete.
7. Scope key file initial creation not fsynced yet (scope JSON is). Partial startup cleanup and shutdown scope-write publication races deserve final lifecycle audit.

No production deployment/restart, real target request, or global CA/settings change. Persistent goal remains active.

## Continuation 12: actual versioned DSH host integration (progress, not completion)

Added `scripts/egress-feasibility/managed-{run,plugin,service}.mjs`: copies package into isolated DSH_HOME, resolves actual installed host packages, mounts real src-hunter preset, **does not monkeypatch shell**, checks `SrcBashExecutor` class, uses actual ToolRuntime and commands lifecycle. Fixture workspace is outside private DSH_HOME; neither production profiles nor settings were changed. Fixture-only service permits loopback, otherwise uses actual manager/store/evidence/command code. Real Jev option copies user settings into private temporary file, disables unrelated skill/delegate/browser advisory work in that COPY, and deletes copied credentials/settings after exit.

Critical integration fixes (not caught by earlier unit tests):
- DSH patch `name` is an identity assertion, **not replacement**. Previous production patch silently retained SandboxBashExecutor! Repaired bundle patch to disable `bash-sandbox` and insert new `src-bash-executor`. Actual DSH now confirms the new class.
- New task-tool schema used JSON Schema `required:[...]`, unsupported by native value DSL. Converted nested requirements to per-field booleans; corrected render result to content array. Real task tool registers/executes now.
- SRC plugin needed explicit `shell` injection for constrained filesystem/capability adapters. Added.
- Constrained native file outputs did not match native strict schemas. Reworked Python transport to return before/after/create-update metadata, numbered lines/totalLines, and rg JSON/null-delimited search results. Actual write/read/edit/glob/grep all passed DSH output validation, not just raw subprocess checks.

Actual DSH evidence:
- `dsh-managed-synthetic.json`: 15 real tools (goal, exact scan task, 6 bash calls, 5 file tools, src_http pending, safety preparation), actual `/src-egress-scope` and `/src-approve` commands. Exactly approved GET /read + once-approved POST /compute reached loopback target. DELETE, budget reuse, raw curl/Python direct connections blocked; local create/overwrite/delete passed. 2 synthetic Jev plan assessments, no extra inference for preparation/human execution.
- `dsh-managed-real-jev.json`: same real DSH path with **real configured Jev**. Returned model `jev-1.13.0`, fallback=false, mode=on; two whole-plan assessments. Low confidence/unknown outcomes stayed pending and actual authenticated command lifecycle authorized execution. Precisely GET /read and POST /compute reached target. No success inferred from model statements.
- Real decision-model prompt validation failed before model tool execution: configured `newapi/hy4` → upstream `hy4-preview` model_not_found. Isolated alternate configured minimax-m2.5 likewise model_not_found. Read-only provider /models lists these IDs but does not prove routability; one final configured glm-5.3 attempt also failed (see /tmp/dsh-managed-model-glm.log). No production aliases changed. Saved first two failure scores; these are **failures**, not gate validation passes. Calls=1 on failures is fixture pre-submitted plan, not model execution.
- Full regression after production fixes: **323 passed**, saved regression-tests.log. Preset consistency and diff whitespace checks pass.

Remaining work unchanged in scope: HTTPS with actual pinning and trusted fixture CA; capability runner, native jobs/child lifecycle and safe proxy teardown; pending/denied/unknown hostile variants and restart/kill integration; full UI visual/command review + read_image; resource metrics; safe file/skill initial-loading boundaries; package/version compatibility; bounded lifecycle/startup cleanup; final requirement audit. Main model provider routing is externally failing, but other work remains possible, so goal is NOT blocked or complete.

## Continuation 13: HTTPS, background jobs, images, overhead reduction

Progress against current code (not a completion claim):
- Extended actual owned-proxy fixture to HTTPS. Generates a short-lived loopback-only synthetic certificate; a fixture-only executable wrapper supplies that CA solely to its owned mitmdump. Production TLS verification remains enabled, no global CA installed. Actual pinned upstream TLS request succeeds; DELETE, replay, redirect to unapproved path, direct curl/Python, protected key reads and AppleEvents remain blocked. Proxy stop yields connection failure, not an alternate send. Exactly GET /read and GET /jump reach target; one plan assessment, two evidence records. Saved `tls-proxy.json`.
- Measured actual owned proxy cold start **783ms**, RSS **86,912 KiB** in that run. This is not negligible and must be reported honestly; no invented throughput benchmark.
- Reduced overhead: read/write/edit/glob/grep/read_image now get a **deny-all-network** final-spawn context, not a session TLS proxy. They retain protected paths and standing local filesystem policy. Added unit test that the resulting SBPL has no allowed outbound port. Bash/capability network runs still need their session proxy.
- Ran actual DSH with native `run_in_background`, waited via real `job_output`: raw direct curl fails and target gets no extra arrival. Foreground/file/approval checks still pass. Added genuine valid synthetic PNG generation and real `read_image` attachment validation; prior hardcoded PNG bytes were malformed (fixture bug, not a bypass). Current evidence `dsh-managed-background-image.json`: 18 real tools, native full-access mode, exact target arrivals GET /read + explicitly human-approved POST /compute.
- Key-file creation now fsyncs the file and containing directory, matching scope JSON durability.
- Latest focused core: **42 passing**, Python addon parses, whitespace checks pass. Full regression is still prior 323-pass run; rerun full suite after finishing remaining changes.

Native job source inspection: jobs-local registers owner context cleanup, cancels owned jobs and awaits settlement on owner/service disposal. This helps safe teardown design, but is NOT yet a tested session proxy release implementation. Keep current cap4/no-eviction behavior until safe lifecycle wiring exists. Background subprocesses must not inherit a recycled proxy port from another engagement.

Remaining: safe bounded proxy/session lifecycle and failed-start cleanup; capability + child live-runtime coverage; HTTPS in actual DSH provider harness (current HTTPS proof is actual manager/kernel but not DSH session); denied/unknown/restart integration; UI visual verification; transport/file/skill/deployment completion audit. Main decision-model route remains broken externally (hy4/minimax/glm model_not_found); real Jev works and is already evidenced. No production mutation or target traffic. Goal active.

## Continuation 14: real DSH HTTPS + capability + native child proof

- Expanded isolated actual DSH harness with HTTPS server and test-local CA trust: only the child Node environment receives NODE_EXTRA_CA_CERTS, and only the fixture mitmdump wrapper receives its upstream CA. Production host untouched. Same actual dispatchHttp/proxy/provider/middleware execute, no TLS insecure flag.
- Real installed capability fixture under private DSH_HOME: src_read_capability succeeds through deny-network document reader; src_run_capability queues original RUN approval; actual /src-approve executes the stored script through constrained native shell. Direct target curl fails; script approval does NOT create target network permission. Revalidate enabled/installed/current scripts whitelist immediately before RUN execution, not just at initial request.
- Capability document reads no longer start a proxy (deny-all-network local context), matching file adapters' overhead reduction. Protected read exceptions now also exclude capabilities/index.json metadata.
- Real native continuable child was created through ctx.subagents.startContinuable, not a fabricated exec/session object. Its actual bash tool cannot directly connect to target; exitCode7 required. Child inherited SRC middleware and the same final-spawn provider. No extra target arrivals.
- Fixture now rejects model stepping in ToolRuntime-only mode, including informational approval followups. Thus command notices cannot accidentally create external model calls or contaminate deterministic evidence.
- Saved `dsh-https-child-capability.json`: **22 real tools**, actual scope and approval commands, actual HTTPS GET /read and exactly once-approved POST /compute only; direct shell/Python/background/capability/child calls rejected; 6 file/image/search adapters work; two synthetic plan assessments. Main/child network permission checks use real installed DSH. Real Jev remains separately proven in earlier managed run.
- Corrected child persona's old asset-inventory authorization headline: explicitly separate attribution from exact user-confirmed origins. Existing asset heuristics cannot authorize egress.
- Core42 still pass; preset consistency passes. Need full final regression after completing remaining work.

Still not ready to declare complete: safe proxy lifetime/idle reclamation and startup teardown races; integration of explicit denial, unknown outcome and restart/reconciliation; UI visual QA; final full sender/persistence/package compatibility audit and response evidence duplication decision. Main model prompt attempts still externally model_not_found; no more blind alias retries. Prior turns are progress (code + actual-runtime evidence), not blocked waits. No deployment or real asset request.

## Continuation 15: bounded idle lifecycle without proxy-port reuse escape

Implemented lightweight host-owned TCP listener in front of each owned mitmdump worker. The kernel-approved port stays reserved when the heavy worker is parked or crashes; a stale child cannot reach a different engagement merely because the OS reuses the old port. Listener only forwards to its current alive worker, caps64 sockets, bounds socket inactivity, destroys paired sockets on close/error. It performs no policy decision and grants no authority; actual mitm inspection + broker remains authoritative.

Worker lifecycle:
- Two-minute idle cutoff, only with zero client sockets and no unspent active task. Live scan grants retain worker until consumed/expired, so a background scan pause within its approved lifetime does not lose its route.
- Idle stop releases worker memory, retains cheap reserved listener. New actual host tool requests may reactivate that session's worker on the **same** reserved port; packets themselves cannot trigger startup.
- Unexpected worker death stays terminal (no silent recovery/replay). Its front port rejects connections, retained until manager shutdown.
- Manager now caps4 concurrent active/startup workers, 1024 retained session ports. Park completion is awaited before reserving restart capacity, avoiding a late park callback removing a new reservation.
- Original CA cert remains immutable across idle restarts; compare existing read-only certificate instead of rewriting a 0444 file (actual restart test found EACCES/timeout before fix).
- Expanded manager partial-start cleanup around control.listen/public-CA creation/startup/realpath; private directories, control sockets and workers cleaned on failure. Status user command includes worker slots, retained ports and idle interval.

Fresh evidence:
- `proxy-lifecycle.json`: actual mitmdump idle reaped (PID ESRCH), old port rebinding returns EADDRINUSE, parked connection closes without forwarding, explicit activation new PID/same port, SIGKILL remains terminal, missing executable fails closed without hanging. Test is `scripts/egress-feasibility/proxy-lifecycle-probe.mjs`.
- Actual HTTPS/kernel probe passes through stable listener (`tls-guardian-proxy.json`).
- Actual DSH HTTPS+files+images+background+capability+native-child+human-single suite passes through stable listener (`dsh-https-guardian.json`).
- Core **43 pass**, including live/exhausted/expired task idle-eligibility regression. Last full-suite result predates guardian changes; final full run still required.

Remaining are final negative-state/restart/reconciliation integration, UI visual QA, full sender/persistence/package audit, final regression and report. Real model prompt routing still external model_not_found; actual Jev + native DSH task/command path already proven. No production changes. Goal active, previous turn progress.

## Continuation 16: negative approval states and UI verification

- Added real SQLite manager restart test: old pending UI stays non-executable, explicit reconciliation does not send, and even subsequent low-risk advice requires fresh human approval. Added uncertain host send test: send count stays one across retries, invalid `cancel-never-sent` and weak evidence rejected, proper human reconciliation followed by fresh approval is required for the second attempt. Core45 passes.
- Actual DSH HTTPS reject/reconcile flow: user rejects captured POST, same request does not execute or reassess; actual `/src-egress-reconcile withdraw-rejection` records explicit evidence; next request gets a NEW pending id rather than restoring old permission. Only previously approved /read and /compute reach target. `dsh-reject-reconcile.json`: 25 real tools, four whole-plan assessments.
- This test found another integration defect: repeat denied src_http returned `pendingApprovalId:undefined`, rejected by native lossless JSON validation. Now optional ids are omitted and `gateState` reports pending/denied/revoked truthfully; no fabricated approval id.
- UI component QA completed with actual React component in isolated headless Chrome, mock command capture, desktop+390px screenshots. Tested disabled buttons/validation, exact scope JSON, review/status commands, reconciliation evidence threshold and generated command. Visually inspected screenshots; readable, wrapped layout. Artifacts/reproduction instructions in `ui/`. This is component QA, not a production DSH browser session; actual command handlers separately validated through native DSH.
- Removed temporary UI source/config after fixture use. UI typecheck and production bundle build invoked; full npm regression is running as exec session **72237**, log `/tmp/dsh-regression-16.log`. Poll this handle/log before assuming completion. Do not restart just because this checkpoint is reached.

Remaining: final transport/persistence/package compatibility audit, complete current full regression, final evidence/report. Core implementation and isolated native DSH/real Jev paths now have broad evidence; main model routing is still external model_not_found and must not be called a successful prompt test. Goal active. No production deployment or real asset traffic.

## Continuation 17: completion audit, final fixes, external model blocker

- Completed sender/permission/persistence/package audit in `egress-completion-audit.md`; documents precise trust boundary, intentional unsupported routes, overhead, evidence coverage and maintainability observations. Does NOT claim a formal zero-risk proof or a successful main-model prompt run.
- Audit found expired active ledger rows could not be reconciled; now explicit user reconciliation accepts expired/non-dispatching tasks and still forces fresh human approval. Added regression.
- Hardened IPv6 public pin policy against expanded Teredo, ORCHID/special-purpose, 6to4 and documentation prefixes; added regression.
- Public search budget records expire after15min instead of permanently exhausting the512-entry capacity; fixed endpoints/method/header/rate/budget checks remain.
- Added explicit versioned executor handshake at every SRC tools/execute entry. Misconfigured/native/unprotected shell does not silently work just because srcEgress singleton exists.
- Pinned optional bash-sandbox peer to tested0.1.0-rc.8; `npm install --package-lock-only --ignore-scripts` completed, lock updated4lines (no production packages touched). npm pack contains all required JS/Python/UI files; compact result saved.
- Full regression329 passed; core47 passed; UI typecheck/build and preset budgets passed; whitespace clean. Current actual DSH HTTPS+native child+background+capability+files/images+approval/reject/reconcile passed again (`dsh-current-final.json`).
- Last evidence gap revalidated using existing configured `auto` route with real Jev in isolated DSH: failed upstream stream INTERNAL_ERROR, no model output or model tool execution. hy4/minimax/glm previously failed model_not_found. Public model listing is not proof of route health. Saved `dsh-model-auto-failed.json`; copied credentials removed and test processes closed.
- Requested user input for a working DSH provider/model or repair of localhost:3000 route. Production model configuration remains unchanged.

All independent implementation/validation work in the completion audit is now done. The requested model-authored prompt end-to-end validation is still unproven due to external routing failures, repeatedly observed since continuation12; cannot substitute deterministic ToolRuntime runs. Await that external change before marking full goal complete. No further speculative feature expansion planned.

## Scope closure: supplier issues excluded by user

User explicitly clarified: “供应商的问题不要管，不属于 dsh-src 项目范畴”. External provider repair and dependent model-authored prompt validation are excluded from project completion criteria. No further provider retries or configuration changes. Failed model attempts remain failed/unverified evidence, not passes. This supersedes the external blocker recorded in continuation17.

Rechecked saved regression evidence (329 pass), core evidence (47 pass), package manifest and clean `git diff --check`. All in-scope workspace implementation and validation are complete as documented in the completion audit. No production deployment/restart or real-asset traffic.

## 2026-10-05: actual model-authored DSH completion

User requested another model / gpt-5.6-luna. Completed a real isolated DSH session using gpt-5.6-luna with native tools, real Jev and TLS. Model itself invoked `/bin/bash ./egress-cases.sh`, then reported results. All six fixture cases and independent arrival assertions passed. One real Jev assessment; unknown/low confidence required fixture user-command approval for one GET. Only GET /read reached target. This is provided-script execution, not autonomous scan planning.

Extended bounded fixture time to configurable30..900sec,16steps/28calls/500000 accounted tokens, matched plan lifetime. Added completion/model-authorship/per-case checks (old arrival-only assertion could incorrectly pass an interrupted partial run), optional isolated non-strict experiment flag, fixed-script mode and decision logging. No runtime gate relaxation or production provider edits. Retained failures and explicit operator interruptions; completed run uses default strict configuration. See `docs/evaluation/egress-model-20261005/README.md`. JS syntax and whitespace checks pass; production regression suite was not rerun because only evaluation harness/docs changed this turn. No owned test processes remain; copied credentials removed.

## 2026-10-05 local.109 release hardening

User authorized production deployment and Git push after fixing exposed project defects. Pre-release review found deployment omitted root egress entrypoints and Python addon; runtime manifest now covers all lib JS/Python assets. Removed retired Laya daemon auto-start. Added two deployment regressions. Actual Luna traces also exposed repeat-guard middleware returning an error without the native error field; changed it to throw through native error materialization. Real DSH 30-call fixture verifies repeat denial retains its reason, with no lossless-JSON exception, and all prior egress/approval/child/capability paths still pass. Full suite331 passed; UI typecheck/build and preset checks passed (existing dependency import.meta/CJS warnings remain nonblocking). Version0.1.0-local.109. Deployment and Git confirmation recorded separately in the release report.

Production release: both profiles updated; Web idle before stop, current native status command passed. Fixed terminal-owned nohup process lifetime and HTML-before-RPC readiness in launcher, with third deployment regression. Preserved pre-release Luna rerun failure (parameter loop,16step budget,zero target arrivals); no provider edits or weakened gate. Details and backup path in release-local109-20261005/README.md.
