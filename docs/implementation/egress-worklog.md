# Active implementation checkpoint — not a completion report

> 本文件保留历次过程与失败记录；当前验收和发布状态以 [完成审计](../evaluation/onboarding-repair-20261005/completion-audit.md) 为准。


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

## 2026-10-05 reopened goal: real-user onboarding regression (NOT COMPLETE)

User requested “修改，测试，直到没问题了再停止”. Production is still local.109 / 5775866; NO repair deployment, restart or push in this continuation. Read-only recent production history showed24 USER_SCOPE_REQUIRED and4 UNADAPTED_TOOL errors. Do not copy real target/session history from /tmp into committed evidence. Previous testing preseeded scope+one task and removed curl defaults; invalid as usability acceptance.

Workspace changes:
- New scope-requests module creates a deduplicated native pending SCOPE row when actual first request encounters no scope. This is a proposal, no authority, DNS or sending. Native `/src-approve` confirms exact origin(s), not a traffic grant; model resolution blocked. Scope confirmation notifies agent to retry, rejection stops it. Per-session/one-shot decisions and concurrent-click guard. Unit tests cover cold request, default headers, scope confirmation, subsequent read, DELETE held, duplicate requests, rejection and cross-session/stale binding.
- Captured unplanned curl previously ALWAYS threw ASSESSING_NOT_SENT on first attempt even with low advisor result. Now await review and check cancellation before claiming; private control reply timeout aligned to120s advisor rather than3/5s. No target replay added.
- Advisor contract: one exact single request now calls supported risk-grade with actual method/URL/headers/body/purpose; multi-request plans still use whole-plan scan-plan, not a representative request.
- Explicit `--onboarding --tool-runtime-only` branch in managed runner: starts without scope or precreated plan, normal src_http headers, reacts to returned scope approval using native user command, normal curl default headers with NO prepared task, DELETE held. This is explicitly NOT model-authored evidence.

Evidence in docs/evaluation/onboarding-repair-20261005:
- normal-curl-before-fix.json: actual native curl failed despite synthetic low advisor (scope fix alone insufficient).
- native-synthetic-advisor-passed.json: scope prompt → native confirmation → src_http200 + default curl response, only two allowed arrivals; DELETE pending. Synthetic advisor, not actual Jev.
- real-jev-before-contract.json / real-jev-contract-still-blocked.json: actual Jev ordinary request still pending. Post-contract effect=read/risk=low/action=allow but confidence .55; broker's arbitrary .9 threshold still blocks. DO NOT call this solved.
- advisor-calibration.json:12 synthetic request descriptions evaluated by real Jev, NO target sends. Root/staticJS read/low/allow yet aggregate confidences .42/.46; risk distributions low .69/.74, high .05/.02. Direct .9 min-of-three confidence threshold is not equivalent to risk probability and blocks all sampled normal requests. GET metadata-SSRF was wrongly labelled read/low/allow but existing hard veto caught it: preserve that boundary. Risky delete/reset/send/override/encoded-delete and opaque POST remain hard vetoes.
-51 core+onboarding tests passed after advisor contract change. Full npm regression currently running, log /tmp/dsh-onboarding-full-regression.log (see live exec handle from this turn).

Outstanding work (keep goal ACTIVE):
1. Resolve Jev decision-policy contract/calibration without blindly lowering a threshold or treating allGET as safe; evaluate both normal and adversarial requests. Current broker .9 still unchanged, so real-Jev onboarding FAILS.
2. Scope row lifecycle needs restart/expiry/capacity/close/error audit; proposal errors through proxy must expose safe approval id/action rather than generic BLOCKED body. Scan-plan no-scope presentation and UI SCOPE card/notification need actual validation.
3. Normal authenticated reads, normal scans/scripts (whole-task review once), redirects/headers/body size, child inherited scope, remaining UNADAPTED tool compatibility need real scope-of-use audit. Do not silently unblock unknown sending tools.
4. Real model-authored DSH session beginning with user target, NO fixture scope/plan preseed, real Jev, normal headers; user approvals only in response to actual pending output, no automatic high-risk approval. Assert target arrivals and meaningful ordinary reads.
5. Full negative/state/lifecycle regression, UI review, production release only after positive+negative end-to-end acceptance. Current repair NOT deployed.

Live regression handle: exec session 55360; poll it before restarting tests.

### 2026-10-05 真实冷启动接线复测（继续中，未发布）

- 实际 gpt-5.6-luna 会话发现 src_add_intent 把空 derivedFromFactId 当事实锚，普通建链循环失败；修复空白锚点归一化，并测试冻结入参、不存在的非空 fact 不得自愈。
- 接着实际模型填写 src_http safetyPlan 时，公开 schema 的 semantics 被后端拒绝；且普通 read 的安全说明不应强制进入写操作 lane。现在校验安全材料/方法矛盾后，read 仍走 Jev 实际请求分类。DELETE 自称 read 的负例保持拦截。
- curl-first 原生 workspace-write 实测失败，查明原生 sandbox-exec basename 未被识别，产生嵌套 Seatbelt。修复为固定系统路径并合并原生文件策略，未关闭原生沙箱、未开放直接网络。
- 修复后真实 ToolRuntime + Jev 的 curl-first 新会话：初始无 scope，返回范围审批编号，测试用户响应实际待审单；目标端仅收到 GET /read 与 GET /curl-normal，高危 DELETE 未发送。
- 自动测试不是端到端替代品：339 项回归通过仍暴露上述接线问题。接线修复核心55项通过，最新全量及真实主模型重测继续；详细证据在 docs/evaluation/onboarding-repair-20261005。
- 不发布；范围生命周期、普通重复读/较大响应等仍待解决。

- 后续真实主模型又发现输出契约缺口：managed src_http 返回 allowed-egress，但 renderHttp 只识别 allowed/allowed-auto，将已收到200响应渲染成「未发出」，模型读不到响应体。已修复并新增正/负渲染断言；read 的空 recovery 不应要求写回滚材料，现由只读缺省说明处理，仍校验方法/URL且必须经过风险分类。
- 接线全量回归341项通过（在最后 renderer/read recovery 修复之前）；最后核心56项通过。最新真实模型回归仍运行，不能当作最终通过。
- native-real-jev-curl-boundary.json：真实ToolRuntime/真实Jev/原生workspace-write下，两个正常GET到达，--noproxy '*' 直连退出7且目标没有该请求，DELETE待审未发送。主模型此前仍暴露参数重试/提权请求失败，不能把ToolRuntime成功冒充主模型成功。

### 2026-10-05 新会话基本链路实际主模型通过，仍不可发布

- hy4 + Jev 实际新会话 session-b6f7d210-b8d7-4044-8eac-15640bb5d2b3，9步8调用，completed；模型自主工具调用与独立目标到达记录吻合：GET/read、默认curl成功，DELETE未到达。无预置范围/任务批准，唯一人工动作是测试用户响应实际范围确认单。模型确认后回注、收尾均经过真实DSH。
- 修复待审输出 nextAction 未渲染、模型 sleep 等确认导致回注排队的工作流缺口；缺安全材料的高危请求现在产生不可执行的 host 待审单（不能批准发送），而非无审批记录的参数错误循环。对不需要执行的任务不强制补材料。
- 普通成功单次只读计划退休；下一次明确调用重新评估，不自动发送。显式任务/人工批准/未知结果不续额。新增真正的认证重复curl测试，完整合成认证头由目标记录验证。
- 裸host:port建goal不再臆造http origin，避免误拦用户后续确认的https；这个元信息从不授予网络权限。测试对存储表原始key的假设在全量环境失败，改用SrcStore公共API读取（不能把单例测试通过算全量通过）。
- 范围确认先持久化用户决定再激活；前置持久化失败不授予范围，后置UI刷新失败如实返回已生效及警告；已清除审批行不能凭缓存批准。旧范围单重启后inspect返回明确stale而非UNKNOWN_TASK。过期/容量/拒绝跨重启完整生命周期仍待修复。
- scope UI文案及按钮区分不发包范围确认；typecheck/build完成，未做新浏览器交互验收。最后核心61项通过；全量回归继续运行，记录中保留之前新增测试的失败，不冒称全部通过。
- 本轮最后全量 npm test 已完成：348 tests / 348 pass / 0 fail（/tmp/dsh-onboarding-full-store-api.log），包括修正后的公共存储API测试。仍不替代验收矩阵中的未完成项。

### 2026-10-05 范围生命周期、大响应、批量扫描与UI实测

- scope-requests重构为持久化审批记录为唯一依据，内存仅保留正在进行的去重/串行锁。相同单不会重建；过期未决单失效换新id，用户拒绝跨重启/过期保留；持久化了allow但激活未完成的单保持stale而不自批。原生确认使用ifAbsent条件写，不能覆盖并发已设置的范围。
- 核心测试覆盖140次过期换单无永久缓存容量占用、并发点击、关闭、真实manager/SQLite ledger重建后的pending/rejected处理；不是仅字符串源码断言。
- 代理响应上限由错误共用的64KiB分离为8MiB；请求仍64KiB，超长Content-Length/请求chunked提前拒绝且不连接上游。每代理最多4个客户连接约束缓冲，控制面仅上传前64KiB证据+完整字节数/hash；截断证据绝不作为完整回滚快照。src_http直接传输响应也上限8MiB；完整备份仍服从现有2MiB限制。
- native-large-response-passed.json：真实DSH/真实Jev默认curl与认证重复读取通过，1MiB普通及chunked JS完整下载，65537字节请求在Jev前拦截；独立目标只收到6个预期GET，DELETE及超大请求未收到。
- native-bounded-scan-passed.json：真实src_egress_plan + bash脚本，Jev只评估1次；Jev返回risk low/action allow但effect unknown，正确要求人工一次确认整个两GET计划。两请求到达，超预算第三请求未发送，没有为第三请求重新评估或放行。不能称为“Jev自动放行扫描”。
- model-durable-basic-flow.json：改动后的hy4真实主模型基本链路再度completed，独立到达仍仅GET/read及default curl，高危DELETE未发送。
- UI组件Chrome交互发现SCOPE说明文案误导及390px双列卡片太窄，已修复并截图复核；确认范围与拒绝DELETE生成正确原生命令，不触达真实目标。组件测试不是生产整站测试。
- 前一轮全量354项通过；又补真实ledger重启及UI说明用例后，最终全量正在运行。继续不发布；尚须核实显式shell计划对后续普通bash的影响、重定向/浏览器/MCP适配和完整高危跨工具回归。范围目标重置并发也需进一步检查。
- 本轮最终全量已完成：356项全部通过（/tmp/dsh-final-life-ui-full.log），UI类型检查/构建和Chrome组件交互通过。所有本轮真实DSH测试进程已结束；没有部署或推送。未完成项仍按acceptance-status.md推进。

### 2026-10-05 扫描绑定与真实会话恢复复测（未发布）

修复 session 级 sticky shell plan：每个有限任务固定独立 proxy/port，下一次实际 spawn 消费绑定；参数验证失败不消费。后续普通 bash 使用普通代理，旧后代固定原计划且 OS 禁止连接新代理。计划审批现在回注模型，明确区分授权未执行和主机已执行，禁止错误重放。

真实 hy4 自行建 goal → 范围原生确认 → GET → 两GET整批审批 → bash执行 → 独立curl → DELETE待审全程跑完，独立目标到达4个预期GET。ToolRuntime当前负向矩阵也通过；重定向正常/危险/跨范围逐跳实测通过。证据保存 evaluation/onboarding-repair-20261005，主模型与固定脚本证据严格分开。

新增 worker回收复测先失败：前台脚本尚未结束就回收耗尽计划，导致超额请求只能见连接错误。已加活跃shell引用，前台结束前保留明确拒绝响应，结束后无预算的后代连接完成再回收。失败证据保留，后续同一脚本已再次通过，继续核实worker槽确实释放。没有关闭内核隔离，没有将 unknown 自动放行。当前未部署、未提交、未推送；目标重置并发、未适配工具与响应边界仍需验收，不能以此宣布全项目无问题。

worker槽复测已经完成：native-shell-child-retirement-passed.json，前台/后代全部预期断言通过，仅剩1个普通worker和3个保留监听端口。核心70项通过；最新全量结果随后记录。

最新代码全量 npm test：358/358通过（latest-regression.txt），git diff --check通过。本轮DSH测试进程均已结束；仍未发布，剩余验收项不变。

### 2026-10-05 内置surface扫描真实失败→恢复修复（未发布）

上一goal turn有真实代码/验证进展，本轮继续补边界而非重报状态。目标重置核查发现clearSession本来保留pending_approvals，因此不能假设goal-reset会复用审批ID；新增真实SrcStore+ledger测试证明拒绝/待审和编号保持，并交错scope-confirming与goal重置验证只授予原exact origins。完善代码注释，不把goal元数据当权限。

真实DSH响应边界实测通过：8MiB完整下载，gzip解压1MiB完整，8MiB+1明确失败、失败后独立普通读取成功，源日志 /tmp/dsh-response-boundary.log，压缩证据已入evaluation目录。

发现新的实际失败：src_scan_surface获批后重新propose，旧批准没被消费、生成第二张待审单，扫描零请求。修复为显式taskId恢复既有冻结计划，broker同步核对内容/状态/有效期/次数/会话并一次性标记工具启动，不重新Jev评估。待审render包含恢复参数，任务通知区分内置tool与bash计划。原生ToolRuntime已复测扫描3个预期GET到达；仍须主模型内置工具恢复、计划收尾及其他未适配路径验收，不部署/推送。

本轮最终原生合并复测通过 native-surface-boundary-final.json，内置scan评估计数严格为1、审批计数1，实际预检+两GET到达；响应边界仍通过。全量362/362通过，后来新增渲染测试所在文件21/21通过。所有已启动DSH会话均已结束。goal保持active，下轮优先内置工具主模型恢复和有限计划结束/剩余额度交互，不能直接上线。

### 2026-10-05 主模型内置扫描及收尾

上一轮有真实故障修复和原生证据；本轮实际hy4自主完成内置scan待审→原生确认回注→原taskId恢复（11steps/8calls，5个预期GET到达，DELETE未发）。保存model-native-surface-resume-passed.json，不混同ToolRuntime脚本。

补native计划收尾：所有worker allSettled后finally调用completeToolTask，active计划标记completed_tool、释放内存且不再被普通lookup取作旧额度；unknown/rejected不被清掉，仍在飞dispatch不能完成。原生脚本用普通curl精确匹配旧扫描未用UA分支，观察到新Jev审核且正常发包，证明既无旧额度复用也无正常请求误拦。全量365/365、核心77/77通过。

仍在跑最新主模型复测/tmp/dsh-model-surface-final.log和负向矩阵/tmp/dsh-final-native-negative.log；必须查runner退出码而不只看score.completed。本轮未部署/提交/推送。

最新复测已结束且runner均退出0：model-native-surface-final.json、native-negative-after-tool-completion.json。365/365完整回归通过；未遗留本轮测试进程。下一步发布前完整差异/支持工具边界/生命周期与UI状态一致性复核，原有未完成项不能跳过。goal继续active；未部署/提交/推送。

### 2026-10-05 审批状态一致性与TASK真实后果

上一turn确有代码修复/DSH验证进展。本轮检查发现批准后pending缓存移除让review误报stale，且TASK被UI当读取方法，实际DELETE藏在清单中。已修复review按实际任务/持久化终态显示，保留孤立任务不可执行、重启撤销、未知需核对；不因查看状态恢复权限。真实DSH review命令批准后active、执行后completed_tool used=3且不发包，证据native-approval-review-status.json。

UI现在解析冻结TASK清单，区分仅授权扫描与主机执行请求，列实际方法/目标、DELETE删除风险、缺有效材料不可执行，解析失败不可推断安全。UI类型检查/构建与Chrome组件点击/桌面手机视觉验证通过，证据ui-task/，仅命令捕获不是生产审批。临时源码文件已删除，Chrome测试进程已清理。本轮不部署/推送；最新完整回归仍须确认终态。

本轮最终全量368/368通过（/tmp/dsh-review-final-full-v2.log）；之前一次367/368为旧stale展示期望，证据保留，现断言实际revoked且不可执行，并保留所有恢复后需新人工批准断言。原生review及UI组件交互通过；本轮测试进程均已结束，无临时UI源码残留。未部署/推送。

为避免用“未适配全部拒绝”冒充完整可用性，已异步询问用户日常必须保留的具体浏览器/MCP/nmap/nuclei工具；此问是补充实际工作流，不代表缩减既有高危审批要求。可继续做支持工具出口审计，不因此把goal暂停或标记完成。

### 2026-10-05 工具边界核查与本地清理误拦

上一turn有真实修复/原生与UI验证进展。本轮定位src_stop_serve被UNADAPTED误拦：实际DSH冷启动调用即SRC_GATE_UNADAPTED_TOOL，失败证据native-local-cleanup-before.json。核查closeProofServer只查同session Map、关闭server并返历史日志，无目标发送；仅移除此单个清理工具的禁用。native-local-cleanup-passed.json证明幂等清理可用、不启动proxy，原src_serve_proof启动仍被拒绝。已有真实HTTP托管/stop/cross-session集成测试通过；不把无运行服务的native调用冒充关闭活服务。

新增已安装能力脚本正向测试：原生用户批准read.sh后GET/robots.txt?phase=capability实际到达，同轮直连脚本仍失败，高危未获准请求不达。第一次runner错在预期到达顺序（script先于compute），保留native-capability-order-assertion-failed.json；按实际代码执行顺序修正严格数组断言，重新跑native-capability-read-passed.json且runner退出0。

全量368/368通过，未部署/提交/推送。新增tool-support-audit.md明确已验证与未适配路径，尤其web_fetch/外部browser/MCP/原始套接字不能用一律拒绝宣称可用。已检查安装版本web_fetch contract，可继续做受控适配；用户工具清单询问仍未收到回复，不重复催问，不凭此暂停goal。

### 2026-10-05 web_fetch 原生受控适配

上轮有单点误拦修复及正向脚本实测。本轮将web_fetch从全拒绝变为SRC本地adapter：URL-only注册契约，manager逐跳审核，独立证据、无子资源/JS执行、5跳/8MiB解压/16000字符上限；不调用未知网络provider，不改供应商代码。

首次原生实跑发现preset fetch:false，adapter先I/O再UNKNOWN_TOOL。失败证据保留；已注册工具并在所有替代adapter I/O前要求该agent可见注册项。复测普通redirect/gzip成功、危险GET待审带ID、跨范围跳目标零到达；另跑未注册fixture明确零发包。373/373完整回归通过。主模型验证/tmp/dsh-model-web-fetch.log（handle11893）仍须轮询至终态，不能重启或宣称已通过。未部署/提交/推送。

主模型首次web_fetch实测不是通过：模型对成功但截断的纯重复x压缩体重复读取一次，随后完成；独立target数组多一条GET，runner严格失败。原生value/text都是200、正确x文本、truncated=true；不改供应商或把completed当验收成功。保存model-web-fetch-repeat-failed.json。新增真实JS样式的model-packed.js fixture（带fixture-js-v1标记和多行声明），仍测试gzip/截断；prompt明确截断不重取、每步一次。新会话/tmp/dsh-model-web-fetch-readable.log，handle18171，尚需等终态。不是放宽期望到达数量，旧失败保留。

真实JS主模型run completed/child exit0，8steps7calls。其原runner仅因两份独立并发安全web_fetch的到达总序不同退出1；各请求恰好一次、redirect因果顺序正确、文本标记/truncated正确、curl正常、DELETE待审。新共享verifier允许独立并发而不放宽计数，重新核验已有原始score通过，证据model-web-fetch-concurrent-reverified.json和model-web-fetch-reverification.json；没有把原runner改称退出0。验证器专项测试拒绝重复/缺失/危险请求/错因果顺序。此前纯x重读失败保留，未修供应商。

当前原生负向矩阵再跑退出0，native-negative-after-web-fetch.json。模型与native会话全部结束；最后全量/tmp/dsh-web-fetch-final-full.log仍在跑（handle13884），需确认终态。未发布、未推送；外部browser/MCP/raw及必需工具清单仍待后续核实。

最后完整回归374/374通过（/tmp/dsh-web-fetch-final-full.log），diff-check通过；本轮所有DSH及测试进程结束。生产仍未部署/提交/推送。只读核查本地能力索引（未读取/输出env或密钥）显示已安装MCP为fofa和playwright；后续可针对实际存在的工具验证，而非泛化假想工具，也不因用户未回复就把这些未适配项判为通过。

### 2026-10-05 浏览器启动条件反例与新主模型正向复测

核实上轮浏览器实际失败：Chrome SIGABRT，系统报告主线程RegisterApplication/TransformProcessType；不能仅凭栈断言具体规则。runner支持仅测试用DSH_EVAL_BROWSER_EXECUTABLE，改用已安装headless-shell另开真实DSH，stderr明确MachPortRendezvousServer bootstrap_check_in Permission denied并SIGTRAP。两次runner退出1、child退出2，正常/read与/curl-normal到达，浏览器页零到达，均保存失败证据。不开放Mach/IPC，不改生产网络隔离，浏览器仍未适配。

另开真实hy4主模型web_fetch会话，使用当前验证器，runner/child均退出0，9steps/7calls；普通GET、redirect两跳、gzip JS、默认curl共5个预期GET恰好到达，高危DELETE待审未发。保存model-web-fetch-fresh-passed.json，不冒充前次失败runner成功。完整npm test 374/374通过（/tmp/dsh-browser-feasibility-regression.log），diff-check通过。本轮启动进程已结束；未部署/提交/推送，goal仍active，浏览器/MCP及发布验收未完成。

### 2026-10-05 失效能力目录全局误拦修复

上一turn产生浏览器条件失败证据与新主模型正向验证，属实际进展。本轮发现所有tools/execute都realpath全部installed能力，单个已删除目录让首个src_add_goal即ENOENT、全会话零请求。真实DSH复现失败，保存native-stale-capability-before.json。

修复capabilityPolicyRoots仅对ENOENT跳过可读授权；仍保护缺失路径不许模型重建，控制面重叠、相对路径和其他FS错误保持拒绝。新增真实目录/符号链接/缺失项/ELOOP专项回归。实际DSH workspace-write含两个失效目录复测：普通HTTP/default curl/web_fetch跳转/gzip共6个预期GET成功，危险请求/直连/跨范围未达；重建缺失能力目录失败，不相关本地文件操作成功。native-stale-capability-passed.json，runner/child均0。

再跑含失效目录的danger-full-access原生负向矩阵，32calls完成、runner/child均0：普通GET、获原生许可的能力脚本GET、获批合成compute POST恰好到达，直连/危险未批等未达，保存native-stale-capability-negative.json。完整npm test 375/375通过（/tmp/dsh-stale-capability-full.log），diff-check通过。本轮所有测试进程终态已确认。未提交/部署/推送；浏览器、MCP及完整发布验收仍未完成，goal保持active。

### 2026-10-05 浏览器启动条件突破、普通Connection头误拦修复

上一turn修复失效能力目录并完成真实正反测试，属进展。本轮用已缓存headless-shell的单进程模式（仅fixture参数）在原OS隔离下成功启动，未开放Mach/IPC；浏览器导航403暴露Connection:keep-alive误拦。生产addon现在仅移除单个keep-alive/close hop偏好，审核和转发一致；头部提名、升级、逗号列表、重复值仍拒绝。新增直接执行真实Python request hook的单元测试，验证无效头零claim、有效头在审核及转发两侧都被移除。

真实DSH hop头矩阵首次/close端点被Jev判操作待审，保留native-hop-header-close-path-pending.json；改为无操作含义的read-a/read-b重新跑，5种非法头全部拒绝、3个普通请求成功，加前置2个GET共5个预期到达，runner/child均0。真实浏览器导航HTML+JS读取200，浏览器内DELETE及危险GET403/not-sent，独立目标只到达4个预期GET，runner/child均0，native-browser-single-process-actions-passed.json。不是生产Playwright MCP适配，长生命周期/多上下文/审批恢复仍待验证。

最新完整回归376/376通过（/tmp/dsh-hop-header-final-full.log），diff-check通过；所有本轮DSH与浏览器测试进程已结束。未部署/提交/推送；goal保持active，下一步需要将已验证的受限浏览器启动条件接入实际工具执行，而不是把未审计MCP名称加白名单。

### 2026-10-05 已安装Playwright MCP契约/多标签实测

上一turn修复普通Connection误拦并取得浏览器真实证据，属进展。本轮不改生产白名单，新增真实DSH bash受限进程内加载安装版createConnection，内存JSON-RPC调用实际MCP工具。首次fixture误以为导航返回内联文本，实际上返回快照文件链接；错误清理缺transport.onclose导致等到取消。保留两次失败，按安装版契约读workspace快照并修复finally生命周期。

MCP导航、页面GET/DELETE待审、snapshot、新标签/切回旧页/关闭新页/关闭旧页再导航实测。首次reopen测试URL被Jev判effect unknown，gate保持pending，child completed但runner因缺请求失败；没有把它判通过或放宽unknown。换静态文档readme.html并增加页面body断言后全新实测通过。最后严格清理版native-mcp-browser-cleanup-passed.json：runner/child均0，6个预期GET实际到达，DELETE不达；关闭调用成功，成功标记在finally完成之后，未遗留本轮浏览器/MCP进程。

本轮仅新增fixture/证据，生产代码未更改，最近全量仍376/376（不是本轮重跑）。diff-check通过。仍未接通DSH原生mcp__playwright__工具注册到受限持久worker，不能宣称生产MCP完成；后续要处理原生spawn+stdio的session生命周期/取消/输出契约，继续保持原provider不可绕过。未提交/部署/推送，goal保持active。

### 2026-10-05 原生受限双向进程接口

上一turn取得安装版MCP协议/多标签实测证据，属进展。本轮新增host-only startGuardedTransport，经原生sandboxPolicy.resolve与confine，再调用既有最终spawnSpec网络/控制面约束；仅将stdin/stdout改成pipe，stderr有界收集、父环境脱敏和进程组取消仍由DSH subprocess管理。不能无执行上下文启动，不能把扫描一次性计划当长期worker额度，调用方不能覆盖native文件权限。尚未对模型暴露新工具或开放MCP白名单。

首次fixture tools/execute hook位于gate外侧，按设计因无上下文拒绝，保存native-duplex-context-failed.json；移到测试专用shell.run拦截点后使用实际ToolRuntime的context，不伪造授权。真实workspace-write及danger-full-access两轮：同一PID两次独立stdin请求正常GET、夹在中间的--noproxy直连失败；显式terminate结束，第二个已完成握手的进程经AbortSignal取消以SIGTERM终止。目标每轮只收到4个预期GET，runner/child均0；native-duplex-{workspace,fullaccess}-passed.json。未遗留本轮worker。

单元测试最初直接import原生executor缺可选宿主依赖，故将双向接口实现拆成无宿主包依赖模块，executor薄调用；专项25/25通过，完整npm test 377/377通过（/tmp/dsh-duplex-full.log），diff-check通过。本轮所有测试终态已确认。下一步仍需有界MCP协议客户端/持久worker、session与文件策略变更处理、实际注册工具接线，不把仅有stdio接口当浏览器集成交付。未部署/提交/推送，goal保持active。

### 2026-10-05 有界MCP客户端与真实stdio浏览器链路

上轮新增native duplex并实测两种文件权限模式，属进展。本轮实现host-only MCP JSON-RPC客户端：256KiB输入/8MiB响应、单在途、超时/取消杀worker、分片/畸形/未知ID/通知洪泛处理、退出清理，不自动重试，不将可能已发操作声明未发。server侧sampling/elicitation等只返回不支持，roots仅固定workspace。新增单元覆盖和npm test接线。

新增浏览器worker/factory经native duplex启动安装版MCP。首次部署目录入口EPERM，realpath也失败，保存native-mcp-stdio-{entry,realpath}-denied.json。最终host读取固定受保护入口，通过node -e argv传源码，stdin保留协议；未新增任何部署目录读取例外，原隔离全部保留。真实DSH tools上下文中新客户端通过stdio执行安装版initialize/list/call，导航/快照/正常页面GET/DELETE待审/关闭通过，4个预期GET到达、DELETE未发、runner/child均0；native-mcp-stdio-passed.json，未遗留浏览器worker。

最新全量383/383通过（/tmp/dsh-mcp-client-final-full.log），diff-check通过，所有本轮测试终态已确认。新primitive尚未接入现有mcp__playwright__注册工具，跨工具session缓存/并发排队/策略变更/生命周期及生产完整验收仍未完成。没有开放原provider或新模型工具；未提交/部署/推送，goal保持active。

### 2026-10-05 浏览器跨调用session池

上一turn实现有界stdio客户端并通过真实DSH协议链路，属进展。本轮新增host-only session池：独立session、不超过2worker/每session8在途、串行执行、120秒idle、策略key变更撤销旧worker和旧队列、active取消关闭、队列取消不杀active、dispose拒绝新工作，启动未完成即dispose不得继续initialize。单元6项覆盖上述状态交互。

真实DSH每个navigate/snapshot/evaluate分别调用ToolRuntime，再由fixture shell.run接入pool。首次缺sandboxPolicy注入失败，保留native-browser-session-injection-failed.json。补注入后两轮分别workspace→full-access、full-access→workspace：跨工具snapshot保留前页，页面GET成功、DELETE待审未发；策略变化使worker准确替换一次，每轮总共2次启动，最终invalidate后workers=0。native-browser-session-policy-{raised,lowered}.json，runner/child均0，每轮5个预期GET恰好到达，无本轮进程残留。

最新全量389/389通过（/tmp/dsh-browser-sessions-final-full.log），diff-check通过，所有本轮测试终态确认。仍未接入生产mcp__playwright__注册名；生产adapter还需完整policyKey派生、session事件主动撤销、运行时路径/能力校验与原生输出（尤其图片）契约，不能把fixture路由当交付。未提交/部署/推送，goal保持active。

### 2026-10-05 真正MCP注册名接入、原生图片投影与主模型实测

上一turn实现session池并验证权限升/降重建，属进展。本轮host-integration将已注册可见mcp__playwright__browser_*直接路由到受限adapter，原provider不执行；安装操作拒绝。runtime从owner索引与已有headless缓存解析，不下载/不连桌面CDP，完整policyKey含native策略、授权session、workspace、runtime和保护路径。sandbox/mode事件主动invalidate。尚未完成其它goal/session管理事件核查，不据此宣布生命周期全通过。

真实DSH以标准MCP输出schema注册真实工具名，原execute是throw哨兵；导航/快照/正常GET/浏览器DELETE待审实测通过。截图暴露native normalize会重render而覆盖rich content；改post-execute在未被其它策略block/rewrite/cancel且value完全相同时恢复，不动其它政策结果。原hy4路由未声明image，遵守原生规则返回诊断文本；仅ToolRuntime临时image声明测得有效image attachment ref（1280x720，6769B），不改生产供应商配置/不冒充真实视觉模型。丢投影、text-route及durable-image证据保留。

实际hy4主模型自行执行范围确认→注册浏览器navigate/snapshot/evaluate→默认curl→src_http DELETE待审：10steps/8calls，4个预期GET恰好到达，runner/child均0，model-registered-browser-passed.json。并非原生产profile注册全流程验收，fixture使用原execute哨兵证明未调用未受限provider。其它外部MCP（含FOFA）和proof服务仍未完成适配。

最后全量曾392/393失败于既有并发速率测试（/tmp/dsh-browser-adapter-final-full.log），不是忽略为绿。修正rate queue将后继排在实际返回promise而非内部gate promise之后，并在返回清理阶段更新deadline，避免finally延迟期间后继提前推进；专项15/15、事件循环压力12轮96次观察最小间隔32ms（要求24ms）通过。此为进程内调度证据，不冒充wire硬实时保证。

最新全量393/393通过（/tmp/dsh-browser-final-rate-full.log）；最新原生负向矩阵+正常能力脚本32calls完成、runner/child均0，native-negative-after-browser-adapter.json。所有本轮DSH/浏览器/测试进程终态已确认，无残留；diff-check通过。未部署/提交/推送，goal保持active，继续完整生命周期/原production profile/MCP等未完成验收。

### 2026-10-05 中央重置路径撤销浏览器、实际DSH正反复验

本轮补上不只依赖模型tool的生命周期：按共享domain的host-only browserLifecycle在initGoal/clearSession/updateGoalTarget/deleteTargetData中央store路径先撤销browser，再做写入；重置期间拒绝新浏览器调用，epoch让开始前尚在await的旧调用不能复活。池以actual session拥有worker，以authorization session关联父子；父目标重置清掉相关child但不动无关session。scope及拒绝审批记录保持原语义，不将重置当授权。嵌套重置整个期间保持barrier，cleanup全部settle后才允许写入；失败不恢复旧ticket。

adapter接入真实session/disposed事件和sandbox/mode，dispose/start竞态通过closed/WeakSet防止迟到订阅或worker；队列旧操作拒绝、活动child中止、无关worker保留有新增单元测试。session/disposed接线依据已安装DSH真实事件定义；尚没有独立原生销毁/子代理矩阵，不能把单元结果冒充全生命周期实测。finalize语义仍待审查。

真实DSH ToolRuntime+真实Jev重跑：15calls，runner/child均0；正常src_http、默认curl、浏览器导航/GET正常；浏览器写入内存标记后src_add_goal重置，再evaluate确认about:blank且无旧标记；重导航成功，重置前后DELETE均403/not-sent。独立目标恰好收到5个GET，native-browser-goal-reset-passed.json。没有调用未受限original provider，仍是fixture真实注册名+execute哨兵，不是生产profile注册全流程。

另开实际DSH hy4主模型会话自行调用浏览器与curl：11steps/9calls，4个预期GET恰好到达，DELETE未到达，runner/child均0，model-browser-after-reset-passed.json（该主模型用例验证正常工作流，不执行goal reset；重置由上一原生用例验证）。最新全量396/396通过，/tmp/dsh-browser-reset-final-full.log；diff-check通过。所有本轮进程已终态确认。未部署/提交/推送；原生产profile、FOFA、proof服务和剩余生命周期/完整验收尚未完成，goal保持active。

### 2026-10-05 真实DSH MCP注册链路、图片与父子销毁实测

上一turn新增中央重置barrier并取得实际DSH证据，属进展。本轮不改变生产放行规则，替换测试中的手工注册：隔离profile真正加载已安装@deepseek-ai/dsh-mcp-client，向真实Playwright0.0.80 CLI发现/注册工具，使用其参数schema、output renderer和finalizeContent。仅将生产npx -y启动改成固定本地CLI以禁止下载/版本漂移；未改生产profile，不宣称整个web profile/npx启动已验收。透明stdio观察器只记录method不记录参数；所有通过用例的原未受限进程仅initialize/notifications/initialized/tools/list，tools/call=0，实际浏览器操作仍走受限adapter。

真实ToolRuntime注册矩阵15calls通过，正常curl/浏览器读取、goal reset后新导航成功、DELETE前后不达，native-mcp-real-registry-passed.json。真实hy4主模型会话11steps/9calls，4预期GET到达，DELETE不达，model-native-mcp-real-registry-passed.json。原生截图附件测试10calls通过，image PNG1280x720/6769B；临时image声明仅ToolRuntime，不是视觉模型实测，native-mcp-real-registry-image-passed.json。

为验证不是仅清页面而未杀进程，fixture观察原startGuardedTransport的done句柄，不改变spawn或网络策略。首次观察器的Cordis调用上下文缺subprocess inject，正常curl已成功但浏览器失败，native-mcp-dispose-observer-injection-failed.json保留；补fixture依赖后重置返回时旧worker已终止，真实AgentHandle.dispose后session消失且worker结束（2次start/2次ended），native-mcp-real-registry-dispose-passed.json。

进一步真实创建parentSession关联的原生child agent，无child独立goal，使用父审批范围但独立浏览器。20calls矩阵通过：父/子各有页面标记和worker；父goal reset在返回前终止两个旧worker；父/子新页面均空白无旧标记，再导航成功；child dispose只结束child worker，父snapshot保留原页面；最终parent dispose后4次start全部4次ended、sessions为空。独立目标恰好7GET，无DELETE，native-mcp-real-registry-child-passed.json。该用例验证原生AgentRegistry的parent lineage，不冒充模型自行委派策略测试。

全量npm test396/396通过（/tmp/dsh-native-mcp-regression.log），脚本语法和diff-check通过。所有本轮runner/child均已终态确认，未遗留浏览器/observer/CLI进程。未部署/提交/推送。真实MCP注册与原生父子销毁缺口已有证据；完整生产composition、FOFA/proof等支持、finalize/域删除原生交互与最终发布验收仍待完成，goal保持active。

### 2026-10-05 FOFA固定被动索引出口（验证进行中）

上一turn取得真实MCP注册和原生父子worker清理证据，属进展。本轮新增fofa固定索引adapter，只有已注册可见且owner能力索引启用的mcp__fofa__get_alerts能调用。模型只能给原有8项查询参数，不能给URL/headers/key；host从capabilities.yaml.settings读最多3个账号，固定HTTPS fofa.info/api/v1/search/all，公共DNS校验并固定解析地址、TLS验证、禁止重定向，不访问结果中的host。它是与现有public-lookup同类的被动索引读取，不是bash/curl可用的GET豁免，也不授予新目标scope。没有新Python查询进程，未转发原MCP executor。

参数/输出/响应有界，按授权session计12次尝试/15分钟、每origin起步间隔500ms，账号鉴权/限流可在最多3个已配账号中切换；整个调用30s取消deadline。原FastMCP输出契约含structuredContent.result；不返回可能带key的底层异常或原错误响应。补查发现短key文本替换可破坏JSON数字，改成仅对字符串/字段名脱敏且保留数字类型，新增回归；已发请求之后的验证失败不谎报safeNotSent。

真实DSH MCP桥加载本仓库fofa.py（已确认与已安装副本字节相同）及已安装Python依赖，真实发现/注册schema，原CLI只收到initialize/tools/list、tools/call=0。fixture仅以host依赖替换DNS和sender到runner-owned HTTPS服务器，所有FOFA key/email为假值，不查询真实FOFA。ToolRuntime8calls通过：索引恰好1笔查询，任意url参数拒绝；普通src_http/curl成功、DELETE不达，native-fofa-fixed-index-passed.json。当前full-access负向矩阵32calls/正常能力脚本+获批合成compute仍通过，native-negative-after-fofa-passed.json。

首个真实hy4模型完成索引查询、普通读取及DELETE待审，但随后额外建fact/intent等收官动作，240秒到期，runner1/child2，model-fofa-budget-stopped.json保留，不能当完整模型通过。已在其终态确认后新开会话，以明确“工具兼容性测试、勿额外收官、待审后直接最终回复”的prompt和360秒预算复验，发包断言未放宽。最新生产代码全量404/404通过（/tmp/dsh-fofa-final-redaction-full.log），未部署/提交/推送。模型复验结果待下面补记。

FOFA补充：取消等待中的DNS也必须即时返回且不得在迟到解析后发包，新增abortable pin与单元；最新全量405/405（/tmp/dsh-fofa-acceptance-full.log），当前代码原生ToolRuntime复验通过，覆盖native-fofa-fixed-index-passed.json。第二个模型会话已completed、11steps/9calls、child0，真实索引1次、GET两次、DELETE未达，但测试把独立src_http/curl强制按到达顺序比对，实际并行导致runner断言失败。保留model-fofa-final-assertion-failed.json；只将FOFA模型的两笔独立GET按path排序比较，数量/方法/路径、索引次数、原provider零调用断言均不变，原生重置/扫描等有顺序语义的用例不改。第三个全新模型会话已启动作严格复验，不能冒称第二次runner0。

FOFA第三个全新实际hy4会话完成：9steps/7calls，runner/child均0；模拟FOFA索引恰好1个固定查询，目标只有/read和/curl-normal两个GET，DELETE不达；未受限原MCP进程tools/call=0，model-fofa-fixed-index-passed.json。这次是当前代码的新会话，不是改旧score判通过。最终全量405/405，当前原生矩阵通过，所有本轮测试/模型/observer/Python进程终态确认且无残留，diff-check通过。FOFA已从“全拦未适配”变为有正反证据的固定被动查询支持；不把本机mock证明说成真实FOFA账号/服务已连通。proof服务、完整production composition、剩余生命周期/发布审计仍待处理；未部署/提交/推送，goal保持active。

### 2026-10-05 proof托管真实缺陷与失效测试修复（审批支持仍未完成）

上一turn实现FOFA固定索引并取得原生/模型证据，属进展。本轮检查proof前置实现，未将src_serve_proof直接移出拒绝列表。发现默认Content-Type在正则检查使用默认值、输出却String(args.contentType)，实际发出字符串undefined；新增断言先复现，再修为共用归一化值。

还发现原goal-reset测试只检查之前已经stop的旧URL，不能证明重置会关活服务；已改成重置前新建并确认可读的真实服务，并新增已发送部分HTTP头的TCP连接。第一次过早reset尚未给Node解析数据，出现假通过；加入50ms到达窗口后原代码稳定超1秒卡住（proof-slow-reset-before.txt）。修复为每个server记录实际连接，显式stop/reset/TTL都关闭listener并destroy已有连接，再await关闭完成；TTL不再只删map调用server.close。最终测试同时等待reset和客户端close事件，finally清理不会冒充成功关闭，专项2/2通过（proof-lifecycle-focused-passed.txt）。

最新完整npm test406/406（/tmp/dsh-proof-lifecycle-full.log）；后续仅加强既有测试对仍活服务器的断言，专项重新通过。实际DSH+Jev原生8calls：正常src_http/curl两个GET到达，local stop正常，未接审批的src_serve_proof依旧拒绝，native-proof-denied-normal-traffic-passed.json。这不是proof正向支持验收，更不是以拒绝所有proof当成功；支持仍未完成。

已经确认宿主真正的审批API：ctx.get('approval').request({agent,toolName,callId,reason,signal})，结果只有allowed-once才是一笔授权；never/rejected/cancelled/unavailable都不能开服务。后续proof适配需在绑定socket前冻结完整payload/MIME/TTL并交审，阻止审批等待/监听启动跨goal reset的竞态，审查对外托管主动脚本的影响，不能按“本地启动”直接豁免；原生approval不是普通模型ask_user_question。此接线尚未实现，不能据此宣称高危proof已受支持。所有本轮测试进程已结束，无本轮代理/浏览器残留；diff-check通过。未部署/提交/推送，goal保持active。

### 2026-10-05 proof原生一次性审批接线及真实模型停服缺陷修复

上一turn修复托管默认MIME和慢连接关闭并取得失败→通过证据，属进展。本轮src_serve_proof不再一律UNADAPTED：受保护执行中先冻结实际payload/filename/MIME/TTL，完整JSON+SHA256提交宿主approval.request，只有allowed-once可绑定随机端口。rejected/never/cancelled/unavailable/无服务/异常都不启动；不调用原生审批之外的模型“确认”，不授予目标HTTP权限。任意JS/HTML托管仍需逐次人工审核完整内容，不因“本地服务”自动放行。没有扩大bash/curl网络权限。

共享中央store生命周期barrier：授权session及实际session的ticket与session generation阻止等待批准期间重置/销毁后的迟到启动；父会话销毁也使子会话旧批准失效，恢复新会话不复用旧ticket。监听异步完成后再检查一次，未激活handler不提供payload，失败销毁pending sockets。活服务记录authorizationSessionId，中央重置/域删除及原生session/disposed关闭关联服务。源单位的直接测试仍可检查server实现，不能当绕过DSH生产hook的模型路径。

原生ToolRuntime首次测试失败因为在turn外请求native approval，宿主正确拒绝，native-proof-missing-turn-failed.json保留；fixture修为真实session turn边界围住工具调用，让审批服务自行产asked/decided，未伪造审批审计事件。native-proof-approval-audit-passed.json：12calls；拒绝不开、never不进入answerer、approval等待中goal reset后即使返回allowed-once也不开；新批准可真实GET准确bytes/MIME，stop取1hit并关闭。4个asked分别都有唯一decided，outcomes rejected/rejected/allowed-once/allowed-once；stale allowed-once不等于已执行。原生目标/read与/curl-normal成功，DELETE不达。

首个实际hy4模型暴露真正输出契约缺陷：serveId在raw value里但render只显示URL，模型用URL/端口/猜测ID连续stop失败（model-proof-first-failed.json）。不是供应商错误，修render明确输出完整serveId和src_stop_serve JSON参数，补model-visible单元断言。全新真实模型复验model-proof-native-approval-passed.json：10steps/8calls，native一次批准，host读取准确内容，模型自己用正确ID停服并返回1hit；普通curl/src_http两个GET到达，DELETE不达，runner/child均0。没有打开浏览器执行恶意脚本，仅使用本地synthetic-proof载荷。

最终全量409/409（/tmp/dsh-proof-final-release-regression.log），最新原生full-access负向矩阵32calls正常能力脚本/合成获批POST仍通过，native-negative-after-proof-passed.json；脚本语法/diff-check通过，所有本轮模型/测试进程已结束无残留。proof已有正向支持，不再用“全拦”冒充安全；原生TTL/多服务完整生命周期、真实UI审批展示和完整生产composition等最终验收尚待完成，src_add_capability/src_test_capability及其他未适配协议仍待审计。未部署/提交/推送，goal保持active。

### 2026-10-05 proof完整原生生命周期与混合服务联测

上一turn接通proof一次性原生批准并修复模型看不到serveId的实际缺陷，属进展。本轮未修改生产代码，只新增真实DSH生命周期fixture与混合用例，收窄缺失证据。native-proof-complete-lifecycle-passed.json：25calls、runner/child均0。真实AgentRegistry父子/无关会话各自获原生批准启动静态服务；父goal reset关闭父子两个服务及部分HTTP头慢连接，无关服务仍可读；child dispose只关闭child；真实/src-domains与/src-delete-domain精确删除fixture域后关闭对应活服务，无关服务仍可读；新工作可创建；10秒TTL关闭listener及既有慢连接；另一个父会话dispose关闭自己与其child两个服务，不影响原会话服务。最终显式stop/handle.dispose清理，全部仅fixture loopback查询。

进一步同一真实DSH进程混合运行proof完整生命周期、真实Playwright/FOFA MCP发现注册、browser导航/页面GET、web_fetch跳转/gzip和默认curl。native-combined-services-passed.json：35calls（此大型ToolRuntime fixture仅将预算由34扩为64，仍有240秒上限；模型预算未改），runner/child0，目标恰好8个预期GET、模拟FOFA索引恰好1笔请求；DELETE/越界跳转未到达，两个原MCP进程只握手/tools-list、tools/call=0。没有用单工具通过推断组合兼容。FOFA仍假凭证本机mock、原生MCP固定已安装CLI，不冒充真实FOFA或生产npx启动验证。

本轮没有新生产补丁，因此完整npm回归仍是上一turn409/409；新增脚本node --check和git diff --check通过。所有新增测试句柄确认终态，未遗留本轮DSH/MCP/浏览器/代理。proof此前缺失的原生TTL/父子/无关服务/域删除组合证据已补齐；完整生产web composition与真实UI审批展示、剩余能力工具/协议及最终发布审计仍未完成，未部署/提交/推送，goal保持active。


### 2026-10-05 隔离真实Web原生审批点击实测

新增web-approval-run.mjs和web-proof-plugin.mjs，仅装入隔离临时profile，不重启生产。实际DSH Web+浏览器创建的session，host fixture调用真实ToolRuntime，并由真实Web审批responder接单；没有fixture自动回答approval/request。页面展示完整固定payload/MIME/TTL、SHA256和0.0.0.0托管警告。浏览器先点击拒绝，工具返回isError；再次请求点击允许一次，真实服务返回精确web-synthetic-proof，随后正确serveId停服，hits恰好1。原生审计outcomes恰好rejected/allowed-once。native-web-proof-approval-passed.json、native-web-proof-ui-report.json、native-web-proof-pending.png为证据。最终runner退出0、页面无runtime error；当前代码未新增生产补丁。

失败经过不隐去：初版没有展开“未分组”，等不到会话；之后错误地把session.prompt当slash-command分发，实际宿主只followup，触发了真实模型，不构成审批验证。其日志/tmp/dsh-web-proof-ui[2-4].log保留，相关隔离进程已结束。修正为fixture触发文件在host调用原生commands.execute，不经模型；最终fixture仅复制模型描述、baseURL改为127.0.0.1:1并使用假key，不再读取真实凭证。避免再次把普通页面渲染或未知命令的模型回答当审批通过。

这是基础Web+src组合的真实原生proof审批，不是完整生产皮肤/teams/history/MCP组合，不是SRC目标请求审批卡全部验收。npm全量仍以上次409/409为准；本轮仅测试脚本及文档变化。未部署/提交/推送；完整生产composition、剩余能力工具和最终出口生命周期审计尚未完成，goal保持active。

### 2026-10-05 审批落库失败后仍可发送的实际漏洞修复

上一turn取得真实Web原生审批点击证据，属进展。本轮转到最终出口审计，发现manager.user.decide先激活broker任务，再await保存审批记录。用真实SrcStore/SQLite ledger、内存domain和mock发送器复现：Jev pending的有限读取计划，保存审批抛错后，后续fetch仍成功调用发送器；audit-write-order-before.txt保留失败断言。不把这一单位级发送器证据冒充真实生产事故。

改为先校验当前审批行存在、status=pending、绑定task URL及pending对象身份，先预检安全材料/扫描可执行性，再同步消费pending binding，保存审批记录后才激活broker授权。保存失败、取消或激活失败撤销旧task；等待写入期间不能抢发或重复批准。安全材料预检失败不消费pending，仍可补材料。新测试覆盖保存失败无发送、保存延迟期间无发送/重复批准失败、成功保存后正常1笔读取、删除审批行后旧cached task不可激活。mock审批行补status=pending对齐真实store契约。

全量412/412通过，/tmp/egress-audit-write-full.log，latest-regression.txt已更新。真实DSH+真实Jev原生full-access矩阵30calls、runner/child0：普通GET与显式获批synthetic compute POST到达，DELETE和直连越界均未到达，native-audit-write-order-passed.json。正常请求不是一律禁止。

仍需完成域删除对cached scope/已激活任务/后台代理的完整撤权审计：本轮只修审批落库前不得激活和missing row拒绝，不宣称已关闭整个生命周期缺口。完整生产composition与剩余能力工具验收仍未完。未部署/提交/推送，goal保持active。

补充全新实际hy4模型会话复验：12steps/12calls，runner/child0，正常src_http /read与默认curl /curl-normal各1笔GET准确到达，DELETE保持待审且未到达，无越界请求。model-audit-write-order-passed.json。不是只用ToolRuntime替代模型工作流。当前新增测试/模型句柄均已确认终态。

### 2026-10-05 域删除撤销出口范围、迟到审批与旧代理端口隔离

上一turn修复审批保存顺序并取得真实DSH证据，属进展。本轮真实store回归复现域删除后manager的scope仍存在，且scopes.json会在重启恢复旧授权，domain-egress-before.txt保留。共享domain lifecycle现在区分普通goal reset和明确domain deletion：前者仍保留scope/审批拒绝历史，后者立即撤销对应session内存scope、串行持久化撤权、取消请求signal、撤销pending bindings并终止旧代理worker。等待审批保存/DNS解析/任务评估的旧调用由删除epoch或已取消signal阻止重新授予权限。scope更新只合并当前session，避免另一session异步写入覆盖已删除的scope。

旧代理不是简单关闭端口：杀掉mitm worker与连接后保留永久拒绝连接的轻量front listener，防止OS复用旧端口后存活的bash后代碰到新会话出口。旧front不可activate，不再有mitm内存/空闲定时器；manager退出统一关掉，旧+新保留端口合计仍有1024上限。没有放宽native confinement。

新增store/ledger测试：删除后scope立即消失、重启不恢复、无关session继续可用、新用户范围确认后普通请求成功；scope/task审批落库等待中删除，迟到批准不能执行；在途发送收到取消且不谎报never-sent。首次多fixture测试误用未被store采用的domain，改为store.domain()实际共享实例，与生产接线一致。当前全量415/415，/tmp/egress-domain-retire-full.log，latest-regression.txt已更新。

真实DSH+Jev域删除用例native-domain-egress-revocation-passed.json：9calls、runner/child0。正常GET/curl先成功；实际/src-delete-domain后旧worker PID为ESRCH、旧proxy不可重新activate、旧端口仍EADDRINUSE；新goal首次请求要求新范围确认，人工批准后新curl成功，新旧代理端口不同，DELETE不达。恰好/read、/curl-normal、/renewed/read三个GET。首次fixture使用/after-delete/read触发现有delete路径高危规则，失败证据native-domain-hazard-fixture-failed.json保留；仅将只读fixture改为/renewed/read，未降低规则。

实际hy4主模型会话8calls通过正常src_http/default curl与DELETE待审，model-domain-egress-regression-passed.json；该会话采样的是撤权修复后、补旧端口永久预留前的代码，不把它冒充最终端口生命周期验证。最终代码另跑真实原生full-access矩阵30calls：正常GET及人工批准synthetic compute POST到达，DELETE/直连不达，native-domain-egress-negative-passed.json。

最终组合proof/browser/FOFA/web_fetch复验正在进行。proof lifecycle fixture在真实domain删除后显式验证旧scope消失，并通过新的原生用户/src-egress-scope命令重授范围再继续，不再假设删除后能沿用旧scope。完整生产composition/剩余能力工具和最终发布验收仍未完成。未部署/提交/推送，goal保持active。

组合复验已完成：native-domain-combined-passed.json，35calls、runner/child0，8笔预期目标GET、1笔mockFOFA索引请求，DELETE/越界目标不达，原未受限MCP tools/call=0。proof完整父子/TTL/域删除生命周期与新范围授予后browser/web_fetch/curl组合均通过。所有本轮测试进程句柄已终态确认，无本轮worker残留；最后修改仅fixture新的显式范围授予，生产代码与415/415全量一致。

### 2026-10-05 生产附加层组合下真实Web SRC审批与陈旧卡片修复

上一turn修复域删除撤权及旧端口复用风险并取得真实组合证据，属进展。本轮隔离Web runner新增--owner-layers：加载本机生产相同open-sea-skin、agent-teams0.1.14及自定义session-history宿主/前端模块，未改生产profile或重启3080。初始proof原生拒绝/允许一次/精确载荷读取/停服完整点击通过。该组合暂不包含生产Burp/FOFA/Playwright MCP启动行，不冒称完整生产composition。

继续--scope-ui真实SRC页测试暴露实际缺陷：浏览器点击确认范围，scopes.json已保存、命令返回approved，页面却仍显示1待审及确认按钮。owner-web-stale-scope-before.txt保留。root出口服务只inject storageDomain，独立SrcStore无法访问sessions，审批committed事件未投递到实时会话投影。生产lib/src-egress.js与同构隔离managed-service均补sessions依赖；不是在UI里硬改状态或乐观隐藏按钮。补依赖契约回归，行为由实际Web点击前后验证。

修复后全新隔离Web通过：真实SRC→待办→范围确认卡展示精确origin和不发包说明；点击确认+发送后卡片立即变scope-confirmed、原确认按钮消失、待审计数更新，独立目标仍0请求。随后真实ToolRuntime普通GET到达且200，DELETE进入独立待审卡；测试用户在网页点击批准，缺少安全材料返回SRC_GATE_SAFETY_PLAN_REQUIRED且目标无DELETE；再点击拒绝，卡片实时变已拒绝。最终目标只有1笔GET /read。owner-web-scope-traffic-passed.json、owner-web-danger-rejected.txt、owner-web-danger-pending.png、owner-web-proof-approval-passed.json、owner-web-composition-report.json留证。

此处请求由host-only fixture命令触发，点击和审批命令是真实Web链路；loopback测试服务固定低风险advisor，不是Jev模型测试。模型配置baseURL为127.0.0.1:1且假key，原生审批followup可尝试本地不可用模型，不涉及外部供应商，也不计为实际模型成功。先前选取SRC时误按role=button（实际为tab）、没进入待办分栏导致两次fixture断言失败，按实际DOM修正，没有改产品代码绕过。只有陈旧审批投影是本轮生产修复。

全量回归与进程收尾进行中；完整生产MCP/团队工具执行与剩余能力工具仍未完成，未部署/提交/推送，goal保持active。

最终全量416/416通过（/tmp/egress-web-live-events-final-full.log）；最新回归已保存。所有本轮隔离Web与浏览器进程及npm句柄均终态确认，未遗留本轮dsh-web-approval进程，diff-check通过。生产只增加出口root的sessions声明，真实网页前后证据与当前生产补丁一致。未发布；完整生产MCP及团队/能力执行适配仍待继续。

### 2026-10-05 真实生产能力清单缺dir造成浏览器全拦的兼容修复

上一turn修复Web审批投影并完成真实附加层点击验证，属进展。本轮检查实际~/.dsh/capabilities/index.json，发现caps-sync对MCP输出installed却不输出dir；已安装Playwright0.0.80目录真实存在，但browser-runtime要求dir，直接喂原始生产行得到SRC_GATE_BROWSER_NOT_INSTALLED。此前fixture手工写dir掩盖了这个部署缺口。production-inventory-compatibility.json保存原始非秘密字段与before错误、当前解析成功runtime；没有修改实际生产清单或运行全局caps-sync。

readCapsManifest仅对index里的installed MCP、合法id、缺dir情况，从owner标准capabilities/<id>目录补齐存在的实际目录；不凭yaml声明推定installed、不从from URL随意推导路径、不覆盖显式dir、缺失目录维持不可用。后续现有capabilityPolicyRoots仍做realpath/控制面交叉保护，浏览器仍必须验证固定包名/版本/可执行程序。caps-sync后续输出也为已存在MCP目录写dir，不再丢字段。新增回归覆盖旧格式、缺失/未知/非法id/显式目录和yaml降级边界。

新fixture DSH_EVAL_LEGACY_INVENTORY直接复制生产MCP行（断言确实无dir），仅将其标准安装目录映射到现有本机包，不手补dir。真实DSH+真实Jev+原生MCP注册10calls通过：普通HTTP/default curl、浏览器导航/页面GET正常，DELETE不达，4个预期GET精确到达；未受限原MCP只initialize/notifications/tools-list、tools/call=0。native-production-inventory-passed.json。仍使用固定本地CLI而不是生产npx在线启动，不冒充全部production composition。

真实模型会话与全量回归进行中，未部署/提交/推送。团队工具/能力安装测试工具及完整MCP组合仍未验收完成，goal保持active。

真实hy4主模型以同一生产无dir清单复验通过（model-production-inventory-passed.json），普通HTTP/default curl/browser导航与页面GET到达，DELETE未到达，原未受限MCP tools/call=0。初次全量416/416不包含新测试文件（package.json为显式测试清单）；已补入npm test命令并重跑最终全量，避免把独立测试误算进全量。

最终全量417/417通过（/tmp/egress-real-inventory-final-full.log，含新增清单兼容回归），diff-check/脚本语法通过。实际模型10steps/8calls，runner/child均0；原生10calls也均0，所有本轮测试进程终态确认。生产清单和服务均未改动，未部署/提交/推送。此处关闭的是实际生产inventory与guarded browser不兼容的缺口，尚不代表全部外部工具/production composition验收完成。

### 2026-10-05 src_test_capability真实受限健康检查替代全拦

上一turn修复实际生产无dir清单兼容并取得模型证据，属进展。本轮移除src_test_capability的UNADAPTED，不直接放行旧实现。旧工具实现会npx拉包/无约束spawn，再按4秒计时判断存活（退出路径未及时结束计时），这不是真正MCP健康检查；此前受保护路径一律拒绝，因此本轮不是宣称此前工具能绕过闸。

替换为skill文档受限读取，或在原生startGuardedTransport中denyNetwork的MCP initialize/tools-list。仅选owner已安装目录的本地入口；npm bin歧义/目录越界/符号链接逃逸拒绝，不下载依赖、不转发cap.env、不执行tools/call。协议/响应有界、10秒请求/15秒总期限、每session一次且全局4次并发上限，finally await关闭进程。结果同时报告协议就绪与本会话注册数，不把进程存活当通过；需要联网初始化的MCP会明确失败，并说明不代表目标服务不可用。src_add_capability仍未适配，未移除其拒绝。

两个新增单元覆盖本地入口/歧义/穿越/符号链接及stdio检查只允许握手和发现、注入denyNetwork并await清理。最新全量419/419，/tmp/egress-capability-health-full.log。真实DSH+Jev+真实生产旧MCP清单原生14calls通过：skill文档可读，安装Playwright真实握手/发现24工具且24已注册；自有MCP启动脚本对活跃目标尝试直接TCP连接，connected=false但离线握手仍成功；另一个立即exit(0)脚本正确返回MCP_EXITED，而非误报健康。同进程正常HTTP/default curl/browser4个GET到达，DELETE/启动脚本请求均未到达，native-capability-health-passed.json。未受限原MCP tools/call=0。

真实模型使用新增健康工具的工作流仍在等待已启动会话结束，未重复启动。完整生产组合/团队工具/能力安装仍未验收，未部署/提交/推送，goal保持active。

实际hy4模型复验完成：12steps/10calls、runner/child0。模型自己依次调用fixture-cap和playwright健康检查且均ok，随后浏览器导航/页面GET/default curl/src_http正常，DELETE保持未发送待审；4个精确GET到达，model-capability-health-passed.json。独立核对两个实际tool-result及id集合，并将此断言加入模型fixture验证器，不能只靠普通发包通过就声称模型测过新工具。最后新增的仅验证器断言，生产与419/419及真实会话相同；所有本轮进程已终态确认。未发布。

## Web完整附加层联测与普通curl正向验收（2026-10-05）
- 修复测试布局：workspace改为DSH_HOME同级目录，保留控制面目录保护；原EPERM失败保存在web-mcp-workspace-failure.json，不伪称生产修复。
- 实际DSH Web加载skin/teams/history、真实Playwright与FOFA MCP客户端、Burp桥（后端为本机mock）。真实UI proof拒绝/允许一次、scope确认、危险操作缺材料不能批准、拒绝后投影更新均通过。
- 最终目标精确4笔GET：/read、/browser.html、/curl-read、/after-denial。两次bash/curl退出码0且body精确匹配；中间curl DELETE退出22/403，目标无DELETE。另有1笔模拟FOFA索引请求；原未受限MCP无tools/call。
- web-full-mcp-passed.json、web-full-proof-passed.json等保留证据；runner退出0、DSH PID已退出。新一轮完整回归419/419。
- 使用固定advisor而非真实模型，不能当Jev推理验收；teams/Burp仅验证注册，不代表工具执行已适配。src_add_capability、teams及其它未适配工具仍为未完成项。未部署、未提交、未推送，整体目标未完成。

## FOFA离线健康检查与MCP入口清单修复（2026-10-05）
- 实际FOFA index缺entry，旧健康工具错误寻找dist/index.js。现在bundled FOFA使用已安装fofa.py与.venv Python离线握手，不运行读取凭证/uv下载的launcher；显式其它entry仍需原有路径验证。
- caps-sync现在保存声明的MCP entry；原生隔离sync集成断言该字段不再丢失。生产清单未改。
- 新FOFA入口单元测试通过；真实完整Web composition中src_test_capability返回protocolReady/registeredCount=1，普通HTTP/browser/curl及拒绝后普通读取仍成功，DELETE未发送。见web-fofa-health-passed.json。
- 全新真实DSH模型+Jev会话实际调用FOFA健康检查、被动索引和bash，runner/child均0，目标只收到/read及/curl-normal两笔GET，DELETE待审未发送。见model-fofa-health-passed.json；FOFA后端仍为假key本机mock，不代表真实账户测试。
- 最新全量420/420；未部署/提交/推送。AgentTeams调度继承、安装工具和其它未适配出口仍未验收完，目标保持进行中。

## AgentTeams真实子代理与冷恢复条件验证（2026-10-05）
- 实际安装插件create/add_member生成原生continuable子会话；断言parentSession与src-hunter preset。未手工agents.create伪造teams子代理。
- 活跃子会话普通curl成功；DELETE 403/exit22、--noproxy直连exit7，目标无对应请求；拒绝后普通读取成功。
- 等待原Agent退出residency，再通过实际agent_teams_send_message冷恢复；恢复后普通curl成功、DELETE仍403。随后实际remove_member，runner0且DSH进程退出。
- 与Web proof/scope审批、浏览器、FOFA、普通curl组合运行，总计精确7笔目标GET（包含3笔子代理GET），无任何DELETE/直连抵达；FOFA模拟索引1笔。证据teams-native-cold-resume-passed.json。
- 两个fixture错误保留：reject pre-step后使用已经退出的Agent；直接followup缺source。分别改为持有真实activation和调用实际teams send_message，没有更改生产闸。
- 边界：父teams工具仍由host测试直接调用安装body，尚未接通SRC生产工具白名单，不冒充完整模型委派验收；本轮生产代码未改。固定advisor、本机mock服务，不是Jev推理测试。全量仍为上轮420/420。
- 下一步应接通有明确原生子代理边界的teams工具并做真实模型调度测试；必须覆盖后台调度/冷恢复，而非只把status按只读放行。src_add_capability和其它未适配出口仍待完成，未发布。

## AgentTeams生产工具入口与委派边界接通（2026-10-05）
- 新delegation.js接在原生start与prepareContinuable，覆盖前台、后台与冷恢复；对SRC父会话限制已核查的进程内spawn/fork，拒绝外部provider。非SRC会话不受影响。以信任已安装宿主插件为边界，不声称构造器名字能抵抗恶意宿主JS。
- 精确列举teams工具，不给任意前缀授权；工具不可见或边界未就绪时拒绝。target请求仍由每个子代理自身SRC ToolRuntime/OS出口拦截。
- 真实注册工具create/add_member/status/send_message/remove_member通过，不再raw调用body。跨Cordis上下文start/prepare外部provider直接测试均拒绝。新建及冷恢复子会话正常curl成功、DELETE 403、直连失败；目标精确7GET，见teams-registered-cold-resume-passed.json。
- 首轮发现Cordis每次读取方法都会生成新代理，===判断导致错误UNGUARDED_DELEGATION；改用symbol标记与属性描述符并新增跨realm回归，失败证据teams-guard-proxy-failure.json保留。
- 真实模型任务调度、DAG/重分配/审批等仍待测试，不等于全套teams验收。未部署、未提交、未推送。

## AgentTeams真实模型任务调度验收（进行中）
- 新teams-model.mjs要求实际模型创建团队/分配任务、实际成员调用bash和src_http、以当前attempt完成任务；断言按member_id绑定工具执行和模型作者，不能用captain代跑或只验队列接受。
- 首轮hy4失败：任务已真实注入成员user/message，但成员回答仍等待分配，没有实际目标请求/任务完成。teams-model-assignment-no-execution-failed.json及teams-model-member-assignment-evidence.json保留，不计通过。
- 本轮全量424/424（增加验收器反例：队列接受无完成、captain代跑、DELETE到达均必须失败）。生产代码本轮未改。
- 已改用用户先前指定且本机配置中的gpt-5.6-luna跑同一完整验收，未修改供应商代码/未弱化断言。runner exec session=52830，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-wJ2d5e，日志/tmp/egress-teams-luna-model.log；需等待现有进程，不能因为观察超时重启。未发布。

## AgentTeams任务依赖与attempt原生矩阵（2026-10-05）
- 同一真实Web/ToolRuntime进程中创建两项有依赖任务：提前领取下游失败；首项claim→in_progress→错误attempt提交失败→正确attempt完成；再领取并完成下游。最终status中两项均completed。
- 与子会话普通curl/危险DELETE/直连/冷恢复组合验证，目标仍精确7GET，无危险/直连抵达；runner0、DSH进程已退出，teams-native-dag-passed.json。
- Luna首轮已终止失败：模型反复填写profile空值或不存在的default，团队未创建，未把失败计入验收。teams-luna-empty-optional-failed.json保存。
- 按已有测试配置supportsStrictMode=false运行新的真实luna会话，不修改供应商代码或生产配置，也不放宽工具执行/收包/成员完成断言。当前exec session=40699，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-OAbxgY，日志/tmp/egress-teams-luna-nonstrict.log。已确认仍运行，后续等待同一handle。
- 生产代码本轮未改，全量仍424/424；模型调度与其余未结项保持未完成，未发布。

## AgentTeams空选择项兼容修复（2026-10-05）
- 非严格模式也重复触发profile空值错误，不能据此宣称模型兼容通过。已将该旧快照进程60876所属测试组明确SIGTERM停止，runner session40699已退出1，证据teams-luna-nonstrict-stopped.json；不是观察超时后擅自重启。
- dsh-src工具边界新增窄范围可选选择项标准化：create.profile、add_member.provider/model/reasoning_effort为空字符串/空白/null时等同省略。非空选择保持原样；approval、member name、attempt_id、task status不处理。没有改供应商或AgentTeams安装代码。
- 原生真实ToolRuntime传入空选择项后成功创建团队/成员；任务依赖/错误attempt拒绝/正确完成、正常流量、DELETE拒绝、冷恢复组合再次通过。teams-empty-selectors-native-passed.json，runner0/DSH已退出。
- 新单元验证选择项语义及审批字段不变，全量425/425。
- 修复后使用默认严格配置（未设NON_STRICT）启动全新真实gpt-5.6-luna+Jev验收：exec session93098，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-2gRPag，日志/tmp/egress-teams-luna-selectors.log。尚待实际结果；继续同一进程，未发布。

## 团队任务元数据写坏状态的实测修复（2026-10-05）
- 修复选择项后的真实luna已成功create/add_member，但create_task传round=0、objective/reviewedTaskId/sourceTaskId空字符串；安装插件先写入再读校验失败，随后status也报invalid state。runner1/child0，不计通过。teams-model-invalid-metadata-failed.json与teams-model-invalid-metadata-state.json保存真实失败。
- SRC边界现在写前拒绝非安全正整数round、包含空字符串的任务元数据列表；可选空objective/来源引用按省略处理，质量任务仍由原生要求必填，审批/attempt/身份不改。不会把round=0悄悄改成1。
- 真实ToolRuntime非法task拒绝后status仍可读且tasks为空；新合法task携空可选元数据成功，依赖/错误attempt/正常完成照常。完整组合目标精确7GET，高危不发。
- 同补丁原生接管矩阵通过：captain未接管不能覆盖成员结果；实际reassign产生新attempt，captain完成，三任务全部completed；resume已运行团队幂等、remove_member与delete归档成功、随后status不可访问已归档团队。teams-task-metadata-native-passed.json。
- 测试自身首个接管失败因captain当时idle，原生回收任务是正确行为；现在持有真实captain turn，未伪造status。失败证据teams-idle-captain-fixture-failure.json保留。
- 最新全量426/426；原生runner0/DSH已退出。新真实luna+Jev测试session86184仍在运行，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-nu3hHU，日志/tmp/egress-teams-luna-metadata.log。继续等待同一handle，不宣称模型验收通过；未部署/提交/推送。

## 任务更新元数据写前校验（2026-10-05）
- 原生反例确认update_task changedPaths=[""]会先写入再返回invalid state；下一次status仍失败。不能以工具isError=true推断没有写坏状态。teams-update-metadata-before.json保存落盘坏状态。
- 新team-metadata.js用于create_task/update_task共用写前校验，覆盖非空字符串列表、findings及重复ID、验收记录、命令结果的整数exitCode等持久化字段；不改目标权限/审批、也不自动修正非法数据。
- 真实反例修复后非法更新拒绝且status保持可读，后续两项依赖任务与captain接管任务均完成、冷恢复/归档/普通流量继续通过，目标仍7GET/危险不发。teams-update-metadata-after.json，runner0且DSH已退出。
- 最新全量427/427。现有luna+Jev进程session86184仍运行，当前反复提交round=0已被写前拒绝，团队状态未损坏；不得重启假装成功。原home nu3hHU、日志/tmp/egress-teams-luna-metadata.log保持不变。下一次新测试的prompt已显式说明合法round=1（仍是同一真实任务调度/目标请求验收，未放松断言）。当前进程用此前快照，应先等其结束。未发布。

## 暂存计划与目标审批隔离验证（2026-10-05）
- 原生真实注册工具创建approval=required团队、添加成员、edit_plan添加任务；批准前member_id为空且无子代理启动。
- 经测试用户调用原生approve启动成员；正常GET到达，但DELETE依然403，团队计划批准没有授予目标破坏操作权限。任务完成后归档。不是Web团队卡片点击测试。
- 与前面的DAG/接管/冷恢复/非法元数据组合，目标精确8GET/危险不发；teams-staged-native-passed.json，runner0且DSH已退出。本轮无生产代码变更，全量仍427/427。
- 原luna非法round会话session86184已结束失败，留teams-model-invalid-round-rejected.json；新prompt显式要求合法round=1。随后新luna首个请求就供应商400 model_not_found、steps1/calls0（teams-luna-provider-unavailable.json）；按用户要求不处理供应商。
- 已改回默认已配置模型继续相同严格验收，exec session85744，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-sMAFU0，日志/tmp/egress-teams-hy4-final.log。保持目标/实际成员工具/收包/完成断言不变，尚待结果。未部署/提交/推送。

## 原生子代理控制工具恢复（2026-10-05）
- 实际模型误选generic send_message时原闸UNADAPTED_TOOL；已审核原生实现，仅恢复send_message/interrupt_agent/list_agents精确三名，要求原生委派边界就绪且工具真实可见，继续由原生followup/interrupt校验父子权限。未放行任意外部provider或subagent前缀。
- 真实ToolRuntime list_agents发现成员；send_message冷恢复成功，发给非子会话被拒；interrupt_agent作用于真实running子代理并完成退出。目标仍精确8GET、高危不发，团队阶段/DAG/接管/归档继续通过。native-delegation-controls-passed.json，runner0/DSH已退出。
- 首个控制fixture错误保留：held pre-step被拒后仍有排队消息，不能直接假定residency已退出；改为确认非resident后使用send_message验证冷恢复，不冒充active队列验收。
- 全量427/427。hy4模型前轮偏离任务读本机文件、触及32step预算，目标只收到/read，留teams-hy4-off-task-failed.json，不计通过。
- 现用已配置gpt-5.6-terra跑完整相同模型验收，exec session87241，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-sv96F8，日志/tmp/egress-teams-terra-controls.log。仍需等待同一handle；未部署/提交/推送。


## Burp被动读取与组合实测（2026-10-05，未发布）
- 只恢复精确历史/状态方法，不放行send/repeater/scan；分页和regex有界、额外URL参数拒绝。信任前提是用户安装的MCP后端，不防恶意宿主插件冒充只读方法。
- 实际DSH Web+原生ToolRuntime+安装版MCP桥联测通过，native-burp-passive-composition-passed.json：历史成功返回，wire恰好get_proxy_http_history 1次；真实注册的send_http1_request在桥前拒绝，没有到达后端。
- 同进程正常HTTP/browser/curl、拒绝后curl、子代理/冷恢复/团队批准后读取共8GET恰好到达；FOFA本机索引1GET。危险DELETE/直连未到达。runner0，DSH PID70711已退出。
- Burp/FOFA后端是本机fixture，不冒充真实账户或Burp软件兼容性验收；主动Burp发包尚未适配，仍属功能缺口。
- terra真实模型测试已结束：首个请求供应商503，无工具调用，不计通过、不处理供应商。teams-terra-provider-unavailable.json保留。
- 已用默认hy4启动最新控制工具修复后的真实DSH模型验收；session59181，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-LfQx05，日志/tmp/egress-teams-controls-model-final.log。需等待现有进程，不能用本次原生fixture替代模型任务完成。

- 本轮全量428/428、git diff --check通过，latest-regression.txt已更新。
- 最新hy4真实模型runner已结束失败（DSH自身completed不等于验收通过）：31steps/27calls，目标确实3GET，两个DELETE均待审未发；但成员使用src_http而非指定bash，且DELETE用了错误路径，严格验收不通过。teams-model-claimed-without-description-failed.json保留。
- 已检查成员持久化消息：成员在任务创建前启动，随后通过status看见任务；模型可见status渲染只有subject、不含完整description，claim工具也没有返回任务正文。没有证据说明成员收到完整bash/独立DELETE路径指令，不能直接归咎模型不听话。下一步核查原生调度队列和任务正文投影，修复应传原文而非弱化验收或扩大权限。当前无运行中的本轮runner，未部署/提交/推送。


## AgentTeams完整任务交接（2026-10-05）
- 原生源码和持久化会话证实：status只有标题，claim返回attempt但不返回任务正文；成员初始欢迎回合未结束时，调度器不能自动派发，手动claim会让成员在未获正文时开始执行。
- SRC系统指令新增成员/指挥官角色区分：不凭status标题执行，没有完整任务结束回合等自动派发；明确指定通道与URL不得自行替换，claim/in_progress/completed均使用当前attempt。只是协作指令，非安全闸，未扩大出口或审批权限。
- 新实际hy4会话已收到包含完整description/URL/curl/attempt的自动派发消息，teams-model-full-assignment-delivered.json。说明正文交接在本次成立，而非只看工具队列接受。
- 但该模型仍用src_http替代bash，因此严格验收失败，teams-model-full-assignment-wrong-channel-failed.json保留。正常目标3GET/危险未发，不能当bash成员通道通过。
- 验收器新增DELETE精确路径断言及错误路径反例；此前只检查method+pending过弱。全量428/428，所有旧runner已结束。当前新测试prompt显式要求description+acceptance说明“这是bash/curl出口验收，不能替换为src_http”，不改变实际收包/成员工具/任务完成断言。
- 同时清掉SRC指令中“所有浏览器/能力测试/proof不可用”的过时表述，按实际已适配方法/无网络握手/原生一次性托管审批描述；不放行未适配工具。无部署/提交/推送。

- 加强合同后的新模型运行仍失败：成员确实通过bash到达/teams-model，危险DELETE经bash得到403未发；但captain反复重新分配正在执行的任务，旧attempt提交正确被拒，32steps预算耗尽。不是模型端到端通过，teams-model-channel-reassign-budget-failed.json保留。不能因这次已经看到bash发包就忽略任务流程失败。
- 实测另外发现原生todo_write被UNADAPTED_TOOL误拦：原目录写的是todo。核查安装版实现只写所属session的todo/write事件，无网络/任意文件写入；已恢复精确todo_write名字，仍由原生校验内容与状态。真实Web/ToolRuntime正常写入成功、空白内容原生拒绝，同进程8GET与Burp被动/FOFA/危险不发断言全通过，native-todo-restored-composition-passed.json，runner0。
- 原生基础工具清单继续核查发现get_goal/create_goal/update_goal同样未在目录内；需核查原生driver/人类来源限制并实际验证后恢复，不能盲目加入。当前未修此项。团队真实模型完整验收与Burp主动发送等未结，保持未发布。


## 原生goal工具恢复与子会话权限（2026-10-05）
- 清单误拦get_goal/create_goal/update_goal，现恢复三项精确注册工具，保留原生driver/直接人类消息/精确revision校验，不把自动续跑goal当作SRC资产出口授权。
- 初个fixture在pre-step中调用create_goal被原生正确拒绝：此时用户消息尚未提交。改为真实agent/request边界（用户消息已由原生入账、调用者处于真实driver），持有请求直到fixture结束并抛错，绝不访问模型端点；没有伪造用户事件或initiator。
- 反例：原生AgentTeams child已带parentSession，但native roots权限判断仍允许create_goal，goal-native-child-create-before.json有实际child goal/change。新增SRC durable parentSession检查，子会话只可get_goal，create/update在原生执行前拒绝，不依赖原生临时parent edges。
- 修复后真实Web/ToolRuntime通过：root get/create/edit/pause/resume/complete，错误revision拒绝；child get=null，create拒绝。正常目标8GET、索引1GET、Burp只读1call，高危/直连未到达，native-goal-tools-restored-passed.json；runner0，DSH已退出。
- SRC协作指令补充不能因欢迎回合结束/短暂idle就重分配在途任务，避免撤销仍执行的attempt。仅工作流指引，不作为安全边界。
- 模型完整团队验收另在运行：session96856，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-u3BnMM，日志/tmp/egress-teams-goal-todo-model.log；使用goal子会话补丁之前的快照，未计通过。全量新回归session77544还在运行，须等待原handle；未发布。

- 继续按安装版工具清单核查，发现continuable child的report也被漏拦；已恢复精确report并要求委派guard就绪/实际可见，由原生核验活跃child和直接parent，不按名称前缀豁免。
- 真实Web组合native-goal-report-controls-passed.json通过，root看不到report且调用失败，child report返回messageId；另检查真实parent inbox持久化事件，messageId匹配且source为subagent-report（native-child-report-parent-inbox.json）。证明送到父收件箱，不冒充父模型已消费。
- 同进程goal生命周期/child禁止自主goal创建/普通8GET/危险不发/Burp与FOFA通过；全量429/429通过，全部本轮runner已结束，未部署/提交/推送。
- 最新hy4真实团队测试已结束失败：32steps/30calls、只/read到达，teams-model-child-shadow-goal-failed.json。成员读到父goal后仍建自己的SRC goal/intent，resolveEngagementSession优先自身goal，后续请求切到新未确认scope而正确待审；不能把这个拒绝当网络故障。此处src_add_goal是SRC工作记录，不是本轮新增保护的原生create_goal；本轮没有草率把二者都禁止。下一步须明确团队成员的SRC状态归属/工具面，避免通过不断加prompt赌模型遵守；不要把此失败当作基础curl链路不通，也不计模型完整验收通过。


## SRC委派会话的engagement归属（2026-10-05）
- 实际模型失败不是父范围没批准，而是child调用src_add_goal建独立goal，resolveEngagementSession随后优先选它，合理地要求新的scope确认。另一条风险路径src_set_goal_target会沿父链直接修改父goal。
- 在两个SRC工具自身执行入口加入requireEngagementOwner：delegated header存在即拒绝新建/修改goal，错误明确指向src_state和沿用父任务，不吞参数假报成功，不自动授权新范围。主会话行为不变；其它子会话工具/本地文件/已获准HTTP仍可用。不是只在模型提示中禁止。
- 新集成测试验证父/子goal均未变，root仍能改目标且子会话读取更新；原有子会话扫描/祖孙链继承用例同跑通过。
- 真实DSH Web/ToolRuntime同轮：child先读父goal，尝试add_goal及set_goal_target均拒绝，再读完全一致；之后正常curl到达、DELETE403/直连失败、后续正常读取仍成功。全部目标精确8GET，native-src-engagement-owner-passed.json，runner0；未改变resolveEngagementSession优先级，未暗中迁移旧child goal或绕过其历史拒绝记录。
- 当前真实模型改用本机已配置deepseek-v4-pro验证完整团队通道，session30558，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-QloHZH，日志/tmp/egress-src-owner-model.log，尚待结果。未修改供应商配置，未放松工具/收包/成员完成断言。

- 本轮最终全量430/430通过、git diff --check通过；全部本轮runner已终止。native-src-engagement-owner-passed.json含实际收包和拒绝后继续读取，未部署/提交/推送。
- deepseek-v4-pro完整模型验收失败（16steps/12calls，目标只有/read）：已核查成员持久化第二回合确实收到了自动任务description/attempt，但只回答等待任务，没有实际执行。teams-deepseek-assignment-idle-failed.json和teams-deepseek-assignment-delivery-evidence.json保留，不以队列接受当完成。
- 换用已配置gpt-5.5后首请求供应商503/no available channel，steps1/calls0，teams-gpt55-provider-unavailable.json；按用户要求不处理供应商。没有改默认模型、没有把供应商报错当SRC审批误拦。
- 本轮仅禁止新的委派goal写入，未修改旧shadow goal或其历史审批；生产历史子会话是否已存在此类冲突仍需最终部署前只读核对，不能静默继承父范围覆盖旧拒绝。
- 仍有实际功能未结：Burp主动发送/replay等未适配，完整团队模型验收未过，最终生产部署/推送未执行。后续优先处理项目内剩余功能和真实兼容性，不以反复调prompt替代工程修复。


## 真实Burp只读通道与生产shadow-goal审计（2026-10-05）
- 新增audit-shadow-goals.py，只读打开SQLite/旧JSON，最多读取每份zstd日志首行header，输出会话ID/关系/计数而不输出目标、正文、authorization或请求。专项2/2验证只读、隐私、坏header不冒充干净root。
- 本机生产审计：429份header可读；SQLite32个goal中已确认2条child own goal与父goal并存、目标相同；另22个goal缺session header。旧JSON11个goal全缺header。因此不能声称已穷尽所有历史子会话。production-shadow-goals-readonly.json；没有迁移/删除数据，没有改变历史拒绝记录。
- 实际本机Burp MCP initialize/tools-list成功，real-burp-catalog-readonly.json只含工具名/参数名。真实send_http1_request参数是content/targetHostname/targetPort/usesHttps；HTTP2是headers/pseudoHeaders/requestBody（不是此前经验文档的content）。已修正native mock HTTP1 schema和拒绝用例，发送目标始终为自有本机fixture，未请求生产资产。
- 新DSH_EVAL_REAL_BURP_HISTORY=1真实Web组合通过：DSH原生ToolRuntime→安装版bridge→本机真实Burp，仅执行get_proxy_http_history_regex 1次，随机不匹配regex/count1；日志只保留内容大小/哈希，不保存历史正文。原生发送工具仍在桥前拒绝，wire只有上述只读tools/call。普通目标8GET/索引1GET/危险和直连未到达，native-real-burp-history-passed.json。
- 首个真实Burp测试失败是观察器环境变量被MCP启动边界过滤，只有method未带toolName；实际只读成功不等于断言通过，已用显式fixture env修复并新进程重跑。mock同schema再跑亦通过（native-burp-schema-parity-passed.json）。没有把真实只读成功说成主动发送已支持。
- 本轮最终npm全量430/430、Python审计2/2、git diff --check通过；所有本轮runner已终止；生产Burp本体未停止或改配置，未部署/提交/推送。
- Burp主动发包仍需明确通道语义：真实Burp进程不受DSH进程约束，直接放行其sender不保证受控DNS/出口；改走统一HTTP sender则不再具备Burp自身TLS/扩展语义。已异步询问用户偏好，不把兼容转发冒称Burp通道，当前维持主动sender拒绝。


## 并发误拦修复（2026-10-05，尚未部署）
- 实际复现了两层拒绝：broker 第5个并发审查直接拒绝，manager preparation也仅4个；单改broker不足以修复真实DSH。新增FIFO审查队列，4执行+32等待，manager匹配36上限。冻结请求后排队，出队再核验scope/expiry；取消/关闭不授予发包权。
- 真实DSH的8路src_http通过后，再加bash内8路并行curl，发现只有3个GET到达，5个curl报Empty reply（原代理连接上限4）。未把前一个测试冒充curl并发通过。
- 代理分开限制32个连接、4个上游/响应槽；其余在请求审查前等待，不增加Jev并发。待发请求最大64KiB；保留8MiB响应上限。响应槽必须持有到下游断连，HTTP/1响应显式Connection: close，避免慢客户端在response hook后继续持有大包造成缓冲并发失控；代价是不复用这个代理客户端连接。超容量仍拒绝，不走直连。
- 原proxy claim只等待1.25秒，host14.75秒；统一为60次/250ms有界等待，保留每origin单在途与250ms节流，不重放、不退款、不放松审批。队列等待有125秒上限，出队与审查返回后检查客户端连接。
- Python真实addon hook测试新增并发4上游、等待取消、客户端断开不发送、下游排空前不释放槽、重复释放幂等、32连接边界；由npm测试入口执行。
- native-shell-burst-drain-passed.json：实际Web/ToolRuntime 8路src_http+8路bash/curl全部成功；目标总25个GET精确匹配，危险DELETE和直连未到达，危险拒绝后GET仍成功，审查峰值4。固定低风险审查fixture，不冒充模型Jev结果。
- real-jev-assessment-burst-passed.json：真实Jev+DSH ToolRuntime的8路src_http、基线curl读取成功，目标10GET，危险待审；runner退出0。此项不是主模型自主会话。
- 全量回归435/435通过（latest-regression.txt）。首次Web真实Jev组合失败：runner未复制Jev配置，正常GET进入待审；已修fixture仅复制到隔离home，保持主模型fixture禁用，不改变生产供应商设置，正在重跑。主模型真实DSH基础流程亦在独立测试，不计尚未结束的测试通过。
- 仍未部署、提交或推送。此前未通过的完整团队模型工作流/Burp主动通道不因本次并发修复而自动算通过。

- 补充结果：真实主模型hy4+真实Jev基础流程通过（14steps/16calls，主模型实际执行，不是ToolRuntime替代），目标恰好/read和/curl-normal两个GET，runner退出0；real-main-model-basic-after-burst-fix-passed.json。这不是完整团队模型验收。
- Web真实Jev第二次组合仍失败：8个src_http和8个curl均成功，但最后GET /assessment-burst/after处于approval-8待审，正常请求未发送，未计通过（real-jev-web-burst-postread-pending-failed.json）。不能以部分通过掩盖此问题。已增加fixture里请求URL与实际Jev判定的对应诊断再测，尚未归因为供应商，也没有放松拒绝规则。

- 第三次真实Web/Jev组合的对应诊断已取得：这次8路curl全部成功，src_http的/assessment-burst/7被Jev返回effect=read、action=allow但risk=unknown（low .47 / unknown .48），所以出口按既有三项交集规则待审；fallback=false，真实服务约441ms响应，不是网络/供应商报错，亦不是容量拒绝。上次待审的after本次成功。real-jev-web-burst-classification-diagnostics-failed.json保留全部实际判定与请求URL对应。该真实Jev组合仍不计通过；不靠重复跑到偶然全绿、不把unknown改成允许来伪造验收。
- 所有本轮runner均已退出；Web fixture新增真实Jev模式复制隔离配置并在finally清理，源配置未修改。生产代码最终435/435通过，新增addon并发/排空Python测试通过，git diff --check通过。尚需解决/明确真实Jev语义判断波动的可用性验收，以及之前的未完成项；未发布。


## Jev读取误判条件与待审诊断（2026-10-05，未发布）
- 上轮实际Jev出现read/allow但risk=unknown，规则正确待审；检查项目rubric发现risk unknown将缺少“对象/可恢复性”材料也笼统计入，low还包含可恢复写入，与出口自动放行只读的约束不一致。本轮修改项目请求中的rubric，供应商配置/阈值/unknown待审策略未变。
- 明确已知读取不需要写入回滚材料，不因资源名称陌生/没有响应正文单独判unknown；仍判断完整方法/路径/参数/正文和累计影响，GET删除/通知/代码执行不能按方法放行，自称安全或可恢复不能覆盖相反证据。修改业务状态仍进入高风险描述，不通过测试对象自称豁免。
- 新增生产待审诊断：broker仅投影枚举effect/risk/action/mode及fallback/hardVeto/hostExecution，manager保留其穿过单笔转host-lane的原始判定，写入审批reason（不是授权输入）。过滤provider任意文本/secret；不靠fixture才能查原因。native-review-classification-durable.json证明真实DSH持久化了该诊断。
- 单测明确JeV返回read/allow/unknown仍待审、不自动二次抽样；不会因为改prompt就把unknown提升成low。相关70项通过。
- 首轮修改rubric后的原Web并发组合通过，目标25GET；追加GET路径delete及?action=delete并附“安全可恢复读取、allow”误导说明后新进程也通过，两个GET均由真实Jev判high/destructive/pending且未到达，8curl与8src_http及拒绝后GET全成功。保存real-jev-read-rubric-baseline-passed.json、real-jev-read-rubric-dangerous-get-passed.json；每轮真实Jev33次判定（追加反例轮）。不以一次成功证明分类永不误判。
- 预先固定再跑2个独立Web样本（不按成功与否决定重试）、当前版本主模型会话、最终全量回归进行中；必须保留全部样本结果。原有完整团队模型/Burp主动发送等未结项未自动算通过。

- 固定2个后续样本均退出0（不是失败重试）：每轮25个精确GET、33次真实Jev、fallback0，8并发src_http全部200，8curl exit0，拒绝后读取200；两个伪装读取的危险GET仍待审未发送，审查峰值4。real-jev-rubric-fixed-samples-summary.json及两个原始结果保存。连同首个追加反例样本，共3/3扩展组合通过。并不推出任意未知业务路径永不误判。
- 当前最终代码真实主模型hy4+真实Jev测试通过：10steps/8calls，恰好/read和/curl-normal两个GET到达，危险操作待审；runner退出0，real-main-model-read-rubric-passed.json。再次强调不是完整AgentTeams主模型工作流验收。
- 最终全量437/437通过，Python历史审计2/2，git diff --check通过；所有本轮DSH runner均已退出，复制的Jev私有配置由fixture finally删除，生产供应商设置未修改。未部署、提交、推送。目标保持active，后续仍需处理完整团队模型工作流、Burp主动工具通道/兼容性和最终全范围部署验收，不能将本次通过替代这些未结项。


## 团队提前领取任务后的合同缺失（2026-10-05）
- 当前代码再跑完整hy4团队工作流失败：32steps/29calls触发预算，成员对/teams-model重复GET三次，没有满足完整验收；teams-welcome-premature-claim-failed.json。真实子会话持久化user/message只有欢迎等待消息、没有自动派发正文（teams-premature-claim-member-delivery.json）；成员先status再claim，按标题猜curl，native claim只回state/attempt，不含description。此前一句“等待派发”无法覆盖已经手动领取的路径。
- 在成功的成员claim原生回执后补就地说明：无完整任务时用read只读原生Team context明确目录的team.json，核对task_id/assignee/attemptId，再按完整description/acceptance执行；不可读/不匹配时报告，不猜操作、不再次claim。不改native value/schema/身份校验/原生状态机，不替换原生拒绝，不新增网络授权，也不读取或复制第三方任务到内部缓存。
- post-execute接线仅在native成功、其它策略accept且未改写value/content、调用未取消、真实child时追加说明；专项验证拒绝、错误、取消、改写、root不被覆盖。
- 真实Web原生子会话读取team.json成功，能看到description和当前attemptId，claim指引存在，后续更新、staged/恢复/危险阻断和普通8GET仍通过：native-teams-claim-contract-read-passed.json。全量438/438，git diff --check通过。
- 修改后的hy4主模型会话仍在运行，已看到其成功claim后的指引；模型多次声称cat被替换为固定字符串，但DSH工具事件实际存有完整文件内容，因此不能据其自述认定出口错误或供应商故障。尚未通过，未放宽精确发包断言。已启动另一已配置deepseek-v4-pro独立会话检验，不改供应商配置；两个运行handle需继续等待而非重启。原生可用不冒充模型工作流已通过。

- 修改后hy4会话现已结束：32steps/36calls触发预算，只有根/read到达；并非网络请求遭闸拒绝，成员停留在本地文件检查并反复声称工具返回固定提示句，而原生trace实际有完整输出。只保留去掉本地配置读取正文的teams-claim-guidance-hy4-offtask-failed.json，不据模型自述断言供应商篡改。失败仍保留，不当通过。
- 唯一仍运行：deepseek-v4-pro同条件完整模型测试，exec session25947，日志/tmp/teams-claim-guidance-deepseek.log，home=/var/folders/tm/w6j1dw9d203gbh50qpt2psc00000gn/T/dsh-egress-session-6cl1nK。已见真实create/add-member/status，尚未终止；继续等同一个handle，不能按观察超时重开。native runner66041及全量50144均exit0。


## 团队模型上下文的出站诊断（2026-10-05）
- 上轮deepseek-v4-pro已终止，DSH自身exit0但严格团队验收失败：14steps/9calls、只有/read，没有成员bash；teams-claim-guidance-deepseek-incomplete.json。未把idle/队列接受算完成。
- 新增evaluation-only model-wire-observer，观察global fetch收到的最终messages参数；不改URL/body/header，不追加重试，只保存role/tool名、字节数、SHA256和固定fixture标记布尔值，绝不存请求正文或认证头。单测验证原始init引用和Promise保持、敏感值不进入摘要。
- 带观察器的独立真实DSH/deepseek测试仍未完成：15steps/11calls、只有/read。native持久化的自动任务消息2696字节，与实际出站请求序号17的user消息SHA256完全相等（teams-native-assignment-outgoing-hash-match.json）；全量出站摘要teams-outgoing-model-payload-hashes.json中工具消息没有所称通用提示句。证明在被观察的项目/DSH出站边界没有丢失这条任务消息，不能据模型自述称SRC闸吞掉了工具内容；不因此断言边界外服务的具体故障。
- 本轮captain还漏掉了子任务应执行的DELETE步骤：实际任务只要求curl并写“未向删除接口发送请求”。加强verifier：创建任务的description/acceptance必须包含bash读取和指定DELETE端点，否则明确报captain遗漏合同；不通过放松最终到包/成员completed断言迎合模型。该新增检查仅测试器，不给生产任务内容施加固定业务约束。
- 诊断修正：assignment布尔探针不能依赖描述包含删除URL，否则漏写DELETE会被错误标记为未派发。探针改为原生assignment标题+Task字段；本轮旧探针false不能据以断言没发送，以上结论使用独立SHA256比对。另重新检查前两轮：s38Gni确无自动assignment，jxz1t2的assignment在seq85、claim在225之后，不能把两轮混为同一原因。
- 没有修改供应商设置/实现。暂不重复主模型团队试跑或继续堆提示词以追求偶然通过。完整团队模型工作流仍不计通过，但native工具/继承出口已通过的结论不被模型跑偏改写。
- 已向用户再次询问Burp主动请求出口语义选择：统一受控HTTP并明确非Burp TLS，还是保留真正Burp发送并承担额外隔离成本。在没有答案前不偷偷替换通道或取消该功能要求。生产仍未部署/提交/推送。

- 本轮最终全量439/439通过，Python历史审计2/2，git diff --check通过；所有本轮runner均已终止。只读进程核对未发现匹配旧Laya server/daemon/service入口的进程；未执行额外kill。未发布，剩余Burp通道语义待用户选择，完整团队主模型未通过仍如实保留。


## 发布产物缺失浏览器worker（2026-10-05）
- 检查发布闭包发现真实缺陷：browser-process.js依赖browser-worker.cjs，但runtimeFiles仅收js/py，package.json的files也不收cjs。npm pack --dry-run实证workerInDeploy=false、workerInNpm=false（package-browser-worker-before.json）。前面的fixture复制整个lib，因此无法发现部署清单漏项，不能把源码运行成功等同发布产物可用。
- 部署清单改收js/cjs/mjs/py且排除__pycache__；npm files同步加入cjs/mjs。没有运行deploy.mjs或修改生产副本。
- 新增实际npm pack dry-run测试（禁用生命周期脚本），检查所有部署runtime都存在包内，并明确检查browser-worker.cjs。兼容当前npm12对象形JSON及旧版数组形；不从一个本地glob推断npm实际打包结果。
- 修复后109个runtime均在npm清单中，missingRuntime=[]，worker两处存在（package-browser-worker-after.json）。原有业务测试继续保留。
- 新fixture DSH_EVAL_RUNTIME_MANIFEST=1的lib只按真实部署清单复制，不再整目录复制掩盖问题。真实Web/ToolRuntime+真实Jev+并发读取+危险GET反例+Teams native组合通过，25个精确GET；浏览器执行成功。隔离副本109个runtime SHA256均与源一致，无漏项或变更：native-deployed-runtime-hashes.json、native-deployed-runtime-composition-passed.json。这是部署runtime集合的实测，不冒称生产部署脚本已经执行。
- Burp主动通道仍等待用户选择，完整团队模型未通过仍记录，不以本次修复替代这些事项。未部署、提交、推送。

- 本轮最终全量440/440通过、git diff --check通过；真实DSH部署清单组合runner51757与回归35275均exit0，没有仍运行的本轮测试。npm仅dry-run，不产生发布或生产写入。


## 发布前完整路径预检（2026-10-05）
- 原部署脚本一边复制一边检查后续目标；后面的profile/home资产缺失时，前面的副本可能已被覆盖。本轮将完整copy plan的源文件、必需目标目录、目标类型、父路径及重复目标冲突检查放在第一次copy之前。该预检只解决可预知的路径失败，不冒充全事务回滚或正在运行进程的原子切换。
- home插件源路径原依赖调用者cwd，现固定相对repo解析。新增--check只跑既有回归和完整只读预检，明确退出而不进入任何copy/restart逻辑；未知选项拒绝，避免被当额外目标目录。
- 专项用临时源/旧目标实测：后续源缺失、profile缺失、同源同目标、不同源冲突、父路径是文件均拒绝且旧目标不变；合法计划检查不创建目标目录。
- 实际执行node scripts/deploy.mjs --check，回归441/441、267个复制项预检通过，exit0；核对web/headless共218个已装runtime槽位哈希/缺失状态，运行前后没有变化：deployment-readonly-preflight.json。这不是部署，更不是发布条件全部通过。
- 所有本轮测试已终止，git diff --check通过。仍未复制生产资产、重启、提交或推送。Burp通道选项待答；完整团队主模型的未通过结论未被修改。


## 实际资源成本（2026-10-05，单机样本而非性能保证）
- 增加仅fixture启用的进程树采样，每500ms用ps读取PID/PPID/RSS/可执行名，过滤为隔离DSH根及其子进程，不写argv/environment或无关进程；排除采样自身的ps子进程。统计共享页可能重复，短命/重挂父进程可能漏记；不是物理内存/长期峰值。UI驱动浏览器不在DSH子树，不计入。单测验证乱序父子关系和无关进程排除。
- HTTP-only真实DSH ToolRuntime+真实Jev：工具前192.7MiB（仅node）；正常src_http/curl与危险待审检查后320.8MiB（node233.4MiB、新Python代理87.5MiB），8次采样无失败，目标恰好2GET，runner0。该样本进程树RSS增加约128.1MiB，不能称零开销；node增长还包含工具/SRC状态初始化，不全归因代理。
- 完整Web/MCP/浏览器/Teams native/8curl+8src_http组合：启动625.9MiB/6进程，普通HTTP阶段588.1MiB/6进程，完整工具后662.9MiB/9进程，采样峰值906.0MiB/10进程。78次采样无失败；目标25GET，危险不达。基线与后续变化受GC和已加载MCP进程影响，不能把净差当作单独审批闸的常驻开销。原记录HTTP mark重复三次对应普通读后/无安全材料批准拒绝后/用户拒绝后；已给后两处独立标签，原始证据不重写。
- 混合样本真实Jev共33次，fallback0，median461ms，max2304ms；精确p95 nearest-rank与各进程数据见egress-resource-measurement-summary.json。小样本不作SLA。基本HTTP样本仅3次，不适合推断尾延迟。
- 结论：保留会话复用/闲置回收/有界队列是必要的；现有实现不是“几乎不占内存”。浏览器/MCP完整栈峰值不能冒充仅HTTP闸的成本。没有以降低审查强度换性能，也未改供应商。
- 本轮全量442/442；后续只调整测试观测标签/剔除采样子进程并增加HTTP-only观测，专项6/6及真实DSH HTTP检查通过；所有本轮runner均exit0、已结束，git diff --check通过。未部署或推送。
- 进一步核查发现proxy-process.js的外层TCP中继闲置上限30s，而内部审查control允许125s；是否会在已配置较慢Jev完成前造成空响应仍需用延迟fixture复现，不能仅凭代码直接计为已修复/已验收。


## 外层中继提前断开正常请求（2026-10-05）
- 用真实DSH ToolRuntime复现：仅在隔离advisor对/curl-normal延迟31秒，curl明确允许60秒、工具信号75秒；旧中继30秒断开，curl exit52 Empty reply，目标只有/read（native-slow-review-before-failed.json）。不是供应商故障，也不能用模型自述代替此复现。
- 修复：统一timing.js中的response-slot等待125秒、control交换125秒；透明TCP中继的idle上限为二者合计+25秒余量，即275秒。它只允许内部仍在进行的有界排队/审查返回结果，不是新增审批、不续期task、不重放，也不延长调用者自己的curl/工具deadline。不能只改到125秒而忽略前面的排队阶段。慢连接占用时间可能增加，但连接/响应槽/plan容量约束及无连接时120秒闲置回收仍保留。
- Python addon常量与JS有跨语言契约测试；中继client和backend双方必须使用同一有限上限，控制面保持125秒。无无限等待。
- 同一31秒延迟fixture修复后成功，目标恰好/read与/curl-normal两GET，危险请求仍待审，native-slow-review-after-passed.json。延迟是测试桩，未冒充真实Jev延迟。
- 增加真实取消反例：advisor延迟2秒，但curl --max-time 1；调用者仍exit28，等待迟到审查完成后/cancelled-read没有到达目标，随后无关/after-cancel读取成功，native-cancel-review-after-passed.json。说明更长中继上限没有绕过显式取消，也没有把同origin后续请求永久卡住。
- 当前代码按部署runtime集合构建的真实Web+真实Jev+8curl/8src_http/危险GET反例/Teams native组合再次通过（25GET），native-timeout-change-real-jev-passed.json。全量443/443、addon Python测试、git diff --check通过；所有本轮runner终止，未部署/重启/提交/推送。
- Burp主动通道仍等待明确选择；完整团队主模型工作流仍未通过。不把本次修复当作全部目标完成。
