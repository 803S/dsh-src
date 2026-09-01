// dsh-src SRC runtime mutable state.
// Keep this module dependency-free: tool modules may consume it, but it must not
// import schemas, storage, projections, or other tool groups.

/** Per-intent child recovery attempts, bounded by the caller. */
export const recoveryAttempts = new Map();

/** Monotonic step used only for the live session projection append order. */
let submissionProjectionEvent = 0;

export function nextSubmissionProjectionStep() {
	submissionProjectionEvent += 1;
	return submissionProjectionEvent;
}

/** Test/process reset hook; does not affect durable storage. */
export function resetRuntimeState() {
	recoveryAttempts.clear();
	submissionProjectionEvent = 0;
}
