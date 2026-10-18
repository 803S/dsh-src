/* [local.143] 出口闸“用途说明”的来源区分。
 *
 * 现场问题：模型用 bash+curl 发请求时不会申报用途，出口闸为了满足 plan.purpose 必填，
 * 会填一句系统默认串；卡片却把它标成“用途说明（模型自述，非归属证据）”。
 * 于是：①用户看到一句“需审核实际语义”的自我指涉废话，以为模型说了什么；
 *      ②判定服务也把这句话当成模型自述的 justification 收下，等于喂了假线索，
 *        它手上只剩一个空 body 的方法名，只能判 effect=unknown。
 * 所以：系统默认串必须可识别——既能被卡片正确标注“模型未申报用途”，
 * 也不得被当作模型自述送进判定服务。
 */

/** 出口闸在没有模型申报用途时使用的系统默认说明。常量在此单点定义，
 *  authorize()/卡片必须直接引用，避免文案漂移后归属判断失效。 */
export const PURPOSE_SINGLE_CAPTURED = '单笔目标请求，完整内容由出口捕获；需审核实际语义';
export const PURPOSE_PRECONDITION_REVIEW = '单笔请求与前置条件/验证的人工审批';
export const PURPOSE_NO_SAFETY_MATERIAL = '高危请求缺少有效安全材料，待补充后人工审核';
/** 出口闸在没有模型申报用途时使用的系统默认说明（与 authorize() 的兜底一一对应）。 */
export const SYSTEM_DEFAULT_PURPOSES = new Set([
	PURPOSE_SINGLE_CAPTURED,
	PURPOSE_PRECONDITION_REVIEW,
	PURPOSE_NO_SAFETY_MATERIAL,
	'Burp MCP'
]);

/** Burp 原生发送的系统说明带传输事实（工具名/摘要），按前缀识别，不整段入集合。 */
const SYSTEM_DEFAULT_PURPOSE_PREFIXES = ['Burp 原生单次发送'];

/** True when this purpose text is a system default rather than a model-declared purpose. */
export function isSystemDefaultPurpose(text) {
	const value = String(text ?? '').trim();
	if (!value) return true;
	if (SYSTEM_DEFAULT_PURPOSES.has(value)) return true;
	return SYSTEM_DEFAULT_PURPOSE_PREFIXES.some(prefix => value.startsWith(prefix));
}

/** 卡片与回执上的诚实归属文案。 */
export function purposeAttribution(text) {
	return isSystemDefaultPurpose(text)
		? '系统默认说明（模型未申报用途，不是模型自述）'
		: '模型自述（申报文本，非归属证据）';
}

/** 送判定服务的 justification：系统默认串一律不送，避免用假线索替代真实申报。 */
export function declaredPurpose(text) {
	return isSystemDefaultPurpose(text) ? '' : String(text ?? '').trim().slice(0, 2000);
}
