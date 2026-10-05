import path from 'node:path';
import { gateError } from './plan.js';

// Final spawn seam: works even when the native executor skips confine in full-access.
// This helper alone is NOT an installed DSH provider or an IPC containment proof.
export function constrainSpawnSpec(result, { proxyPort, denyNetwork = false, protectedPaths, readOnlyPaths = [], readablePaths = [], platform = process.platform }) {
  if (platform !== 'darwin') throw gateError('UNSUPPORTED_PLATFORM');
  if (!denyNetwork && (!Number.isSafeInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)) throw gateError('INVALID_PROXY_PORT');
  if (!Array.isArray(protectedPaths) || !protectedPaths.length || protectedPaths.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p === '/' || /[\x00-\x1f]/.test(p))) throw gateError('INVALID_PROTECTED_PATHS');
  if(!Array.isArray(readOnlyPaths)||readOnlyPaths.some(p=>typeof p!=='string'||!path.isAbsolute(p)||/[\x00-\x1f]/.test(p)))throw gateError('INVALID_PROTECTED_PATHS');
  if(!Array.isArray(readablePaths)||readablePaths.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p==='/'||/[\x00-\x1f]/.test(p)))throw gateError('INVALID_PROTECTED_PATHS');
  if (!Array.isArray(result.argv) || !result.argv.length) throw gateError('UNKNOWN_EXECUTOR');
  const argv = [...result.argv];
  const rules = ` (deny mach*) (deny appleevent-send) (deny ipc*) (deny process-info*) (allow process-info* (target self)) (deny signal) (allow signal (target self)) (deny network*)`
    + (denyNetwork?'':` (allow network-outbound (remote ip "localhost:${proxyPort}"))`)
    + protectedPaths.map(p => {
      const exceptions=readablePaths.filter(root=>root.startsWith(p+path.sep)).map(root=>` (require-not (subpath ${JSON.stringify(root)}))`).join('');
      const filter=exceptions?`(require-all (subpath ${JSON.stringify(p)})${exceptions})`:`(subpath ${JSON.stringify(p)})`;
      return ` (deny file-read-data ${filter}) (deny file-write* (subpath ${JSON.stringify(p)}))`;
    }).join('')
    + readOnlyPaths.map(p=>` (deny file-write* (subpath ${JSON.stringify(p)}))`).join('');
  if (argv[0] === '/usr/bin/sandbox-exec' || argv[0] === 'sandbox-exec') {
    if (argv[1] !== '-p' || typeof argv[2] !== 'string' || argv.length < 4) throw gateError('UNKNOWN_SANDBOX_PROFILE');
    // Native DSH uses the basename. Merge its filesystem policy rather than
    // nesting Seatbelt (macOS refuses sandbox_apply from a sandboxed process).
    argv[0] = '/usr/bin/sandbox-exec';
    argv[2] += rules;
  } else {
    if (argv.some(arg => typeof arg !== 'string')) throw gateError('UNKNOWN_EXECUTOR');
    argv.unshift('/usr/bin/sandbox-exec', '-p', '(version 1) (allow default)' + rules);
  }
  return { ...result, argv };
}
