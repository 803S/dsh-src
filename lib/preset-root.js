import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const inject = ["agentPresets"];

/**
 * DSH rc.6 replaces configured preset roots with its bundled root while it
 * boots a profile. Register this package-owned root after that service exists
 * so an installed bundle can expose its read-only preset without copying it
 * into the user's DSH home.
 */
export function apply(ctx) {
	const root = fileURLToPath(new URL("../preset/", import.meta.url));
	const presets = ctx.get("agentPresets");
	let normalizedRoot = root;
	try { normalizedRoot = realpathSync(root); } catch { normalizedRoot = root; }
	const lists = presets.resolvedRoots ?? [];
	const already = lists.some((entry) => {
		if (!entry || typeof entry.path !== "string") return false;
		if (entry.path === root) return true;
		try { return realpathSync(entry.path) === normalizedRoot; } catch { return false; }
	});
	if (!already) lists.unshift({ path: root, trust: "system" });
}
