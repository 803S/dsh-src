/**
 * Package-owned invariant companion for `@howmp/dsh-src`.
 * @module @howmp/dsh-src/invariant
 */
const PACKAGE_NAME = '@howmp/dsh-src';
/** Cordis companion plugin name. */
export const name = 'src-bundle-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: a patch-layer-only bundle whose rows own their
 * runtime checks — the src plugin's referential invariant, the storage
 * facilities' own invariants, and the surface plugins' HMR-proven slot
 * disposals. The bundle adds no event, service, or cross-plugin state of its
 * own.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map