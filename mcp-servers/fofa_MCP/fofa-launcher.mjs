#!/usr/bin/env node
/* dsh local FOFA launcher: one config source ($DSH_HOME/capabilities.yaml), no .env. */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(homedir(), ".dsh");
const configPath = path.join(dshHome, "capabilities.yaml");
const toolDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(toolDir, "fofa.py");

function value(text, key) {
  const re = new RegExp(`^  ${key}:\\s*(.*)$`, "m");
  const m = text.match(re);
  if (!m) return "";
  const raw = m[1].trim();
  return /^['"].*['"]$/.test(raw) ? raw.slice(1, -1) : raw;
}

if (!existsSync(configPath)) {
  console.error(`[fofa-local] missing unified config: ${configPath}`);
  process.exit(1);
}
if (!existsSync(script)) {
  console.error(`[fofa-local] missing server: ${script}`);
  process.exit(1);
}
const text = await readFile(configPath, "utf8");
const env = { ...process.env };
for (const [configKey, envKey] of [
  ["fofaEmail", "FOFA_EMAIL"],
  ["fofaKey", "FOFA_KEY"],
  ["fofaEmailBackup", "FOFA_EMAIL_BACKUP"],
  ["fofaKeyBackup", "FOFA_KEY_BACKUP"],
  ["fofaEmailBackup2", "FOFA_EMAIL_BACKUP2"],
  ["fofaKeyBackup2", "FOFA_KEY_BACKUP2"],
]) {
  const v = value(text, configKey);
  if (v !== "") env[envKey] = v;
}
const uv = value(text, "fofaUv") || process.env.UV || "uv";
const child = spawn(uv, ["run", "--directory", toolDir, "python", script], { stdio: "inherit", env, cwd: toolDir });
child.on("error", (e) => { console.error(`[fofa-local] failed to start python: ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
