// Application-level mutation boundary for direct writes that bypass normal tool execution.
// A mutation owns the durable write and all synthetic projection events as one operation.

/**
 * Run one durable mutation, then append its declared projection events in order.
 * `write` must return `{ value, events }`; no command adapter may append those events itself.
 */
export function appendSyntheticEvents(parent, events, appendEvent) {
	for (const event of events) {
		if (event === null || typeof event !== "object" || typeof event.name !== "string") throw new TypeError("synthetic mutation events require { name, args }");
		appendEvent(parent, event.name, event.args ?? {});
	}
}

export async function commitSyntheticMutation(parent, write, appendEvent) {
	if (typeof write !== "function") throw new TypeError("commitSyntheticMutation requires a write function");
	const result = await write();
	const events = Array.isArray(result?.events) ? result.events : [];
	appendSyntheticEvents(parent, events, appendEvent);
	return result?.value;
}

export function syntheticEvent(name, args) {
	return Object.freeze({ name, args });
}
