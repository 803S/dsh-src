// Local credential vault for SRC testing material.
// Durable SRC records keep only credentialRef; secret bytes stay under the vault directory.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const REF_RE = /^credential:\/\/([a-f0-9]{64})$/;
const FILE_RE = /^[a-f0-9]{64}\.json$/;

export function credentialVaultDir(dshHome) {
	return path.join(dshHome, "storages", "src-credentials");
}

function digest(value) {
	return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function assertCredential(value) {
	if (typeof value !== "string" || value.trim() === "") throw new Error("credential 不能为空");
	if (value.length > 20000) throw new Error("credential 过长（≤20000 字符）");
	return value;
}

function safeRelativeFile(file) {
	if (typeof file !== "string" || file.trim() === "" || path.isAbsolute(file) || file.includes("..")) throw new Error("credentialFile 必须是凭证目录内的相对路径");
	const normalized = file.replaceAll("\\", "/");
	if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === ".")) throw new Error("credentialFile 路径格式非法");
	return normalized;
}

export async function writeCredential({ dshHome, sessionId, label, credential, note = "" }) {
	const secret = assertCredential(credential);
	const fingerprint = digest(secret);
	const dir = credentialVaultDir(dshHome);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => {});
	const ref = `credential://${fingerprint}`;
	const file = path.join(dir, `${fingerprint}.json`);
	const record = { version: 1, ref, sessionId: String(sessionId ?? ""), label: String(label ?? ""), note: String(note ?? ""), fingerprint, credential: secret, updatedAt: Date.now() };
	const temp = path.join(dir, `.${fingerprint}.${process.pid}.${randomUUID()}.tmp`);
	await writeFile(temp, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
	await chmod(temp, 0o600).catch(() => {});
	await rename(temp, file);
	await chmod(file, 0o600).catch(() => {});
	return { ref, fingerprint: fingerprint.slice(0, 16), file };
}

export async function readCredential({ dshHome, ref }) {
	const match = REF_RE.exec(String(ref ?? ""));
	if (match === null) throw new Error("credentialRef 格式非法");
	const file = path.join(credentialVaultDir(dshHome), `${match[1]}.json`);
	const record = JSON.parse(await readFile(file, "utf8"));
	if (record.ref !== ref || typeof record.credential !== "string" || digest(record.credential) !== match[1]) throw new Error("credentialRef 校验失败或凭证文件已损坏");
	return record.credential;
}

export async function readCredentialFile({ dshHome, file }) {
	const relative = safeRelativeFile(file);
	const root = path.resolve(credentialVaultDir(dshHome));
	const target = path.resolve(root, relative);
	if (!target.startsWith(root + path.sep)) throw new Error("credentialFile 越出凭证目录");
	return assertCredential(await readFile(target, "utf8"));
}

export function credentialHeaders(value) {
	const text = assertCredential(value);
	const headers = {};
	for (const line of text.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const key = line.slice(0, index).trim();
		const val = line.slice(index + 1).trim();
		if (/^(cookie|authorization|proxy-authorization|x-[-\w]*auth|token)$/i.test(key)) headers[key] = val;
	}
	if (Object.keys(headers).length === 0) {
		if (/^Bearer\s+/i.test(text)) headers.Authorization = text;
		else if (/^Cookie:/i.test(text)) headers.Cookie = text.replace(/^Cookie:\s*/i, "");
		/* [local.54] user:pass 对照账号（infra.testAccount 文档格式）：无认证头行、整串无空白时整体当 Basic 凭据（头文本如 "User-Agent: x" 冒号后有空白不会误中）。 */
		else if (/^[^\s:]+:[^\s]+$/.test(text) && !/^https?:\/\//i.test(text)) headers.Authorization = `Basic ${Buffer.from(text, "utf8").toString("base64")}`;
	}
	if (Object.keys(headers).length === 0) throw new Error("凭证无法解析为认证头（支持：Cookie:/Authorization: 头文本、Bearer token、user:pass Basic；纯用户名不含密码无法注入）");
	return headers;
}

export function redactCredential(value) {
	const text = String(value ?? "");
	if (text === "") return "";
	return text.split(/\r?\n/).map((line) => {
		const index = line.indexOf(":");
		if (index > 0 && CREDENTIAL_HEADER_RE.test(line.slice(0, index).trim())) return `${line.slice(0, index + 1)} <stored>`;
		return line.replace(/(Bearer\s+|Basic\s+)[^;\s,]+/gi, "$1<stored>");
	}).join("\n");
}

/* [local.67 #17] 凭证形态头名单（共用）：stripCredentialHeaders 掩码、auto-vault 检测、
 * credentialHeaders 注入三方必须同一份正则——扩名单时漏掉 auto-vault 会让重放丢头（认证静默失效）。 */
export const CREDENTIAL_HEADER_RE = /^(cookie|authorization|proxy-authorization|token|session-token|access-token|auth-token|api-key|apikey|x-[-\w]*(?:auth|token|key|secret)|secret|password)$/i;

export function redactText(value) {
	return redactCredential(String(value ?? "")).replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, "$1<stored>");
}

export function stripCredentialHeaders(headers) {
	return Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !CREDENTIAL_HEADER_RE.test(key)));
}
