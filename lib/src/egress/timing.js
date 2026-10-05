// The transparent TCP relay cannot see HTTP review progress. Its idle deadline
// must cover the addon's bounded response-slot queue AND one control exchange,
// plus time to return a rejection. It is not an authorization or retry budget.
export const RESPONSE_SLOT_WAIT_MS=125000;
export const CONTROL_TIMEOUT_MS=125000;
export const RELAY_IDLE_TIMEOUT_MS=RESPONSE_SLOT_WAIT_MS+CONTROL_TIMEOUT_MS+25000;
