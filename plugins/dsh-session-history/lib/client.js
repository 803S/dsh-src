window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-session-history",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region styles
		const css = ".dsh_history_pill{display:inline-flex;align-items:center;gap:4px;min-height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;border-radius:6px;padding:3px 6px;font-size:12px;line-height:18px;max-width:100%;box-sizing:border-box}.dsh_history_pill:hover{color:var(--dsw-alias-label-secondary)}.dsh_history_text{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh_history_dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}.dsh_history_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0 0 8px}.dsh_history_bar{cursor:move;user-select:none;padding:8px 10px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-separator-primary);display:flex;align-items:center;gap:6px}.dsh_history_pop{position:fixed;z-index:2147483000;min-width:360px;max-width:min(680px,calc(100vw - 24px));max-height:calc(100vh - 24px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#faf9f5);border:1px solid var(--dsw-alias-separator-primary,rgba(0,0,0,.12));border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden}.dsh_history_viewport{flex:1;overflow-y:auto;padding:6px}.dsh_history_group{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:8px 8px 4px;user-select:none}.dsh_history_row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-height:32px;padding:3px 6px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;line-height:18px;text-align:left}.dsh_history_row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.dsh_history_row.selected{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08))}.dsh_history_row_wrap{display:flex;align-items:center;gap:2px;border-radius:6px}.dsh_history_row_wrap:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.dsh_history_row_wrap:hover .dsh_history_row{background:0 0}.dsh_history_row_main{flex:1;min-width:0;display:flex;align-items:center;gap:6px}.dsh_history_row_text{flex:1;min-width:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh_history_trash{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}.dsh_history_trash:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.dsh_history_trash:disabled{opacity:.4;cursor:default}.dsh_history_restore:hover{color:var(--dsw-alias-state-success-primary)}.dsh_history_archived_badge{flex:none;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-separator-primary,rgba(0,0,0,.12));border-radius:4px;padding:0 4px}.dsh_history_footer{border-top:1px solid var(--dsw-alias-separator-primary,rgba(0,0,0,.1));padding:6px}.dsh_history_count{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:2px 8px}.dsh_history_footer_btn{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;min-height:30px;padding:4px 8px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-state-error-primary);cursor:pointer;font-size:12px;line-height:18px;text-align:left}.dsh_history_footer_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}.dsh_history_footer_btn:disabled{opacity:.4;cursor:default}.dsh_history_wrap{display:inline-flex;flex:0 0 auto;min-width:0}[class*=footerActions]{flex-wrap:wrap;gap:4px}";
		const tagId = "@deepseek-ai/dsh-session-history/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-session-history";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		/** Clock glyph: the universal "history" affordance (no clock icon ships in primitives). */
		function ClockIcon({ size = 16, className }) {
			return react.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true,
				className,
				children: [
					react.createElement("circle", { cx: 8, cy: 8, r: 6.25, stroke: "currentColor", strokeWidth: 1.4 }),
					react.createElement("path", { d: "M8 5.2v3l1.9 1.2", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" })
				]
			});
		}

		/** Colloquial relative time for a session's last update. */
		function formatRelative(ts) {
			if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "";
			const diff = Date.now() - ts;
			if (diff < 60e3) return "刚刚";
			if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
			if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
			if (diff < 2 * 86400e3) return "昨天";
			if (diff < 7 * 86400e3) return Math.floor(diff / 86400e3) + " 天前";
			const d = new Date(ts);
			const pad = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
		}

		/** Directory basename for a workspace cwd; falls back to the workspace title. */
		function workspaceLabel(cwd, title) {
			if (cwd === void 0 || cwd === null || cwd === "") return title !== void 0 && title !== "" ? title : "";
			const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
			return base !== void 0 && base !== "" ? base : (title !== void 0 ? title : "");
		}

		/**
		 * Build the history rows: every non-blank, non-subagent session across
		 * workspaces, newest first, split into the active list and the archived
		 * set (archived rows are hidden from the workspace browser but kept
		 * recoverable here). Mirrors the workspace browser's visibility rules
		 * for the active half so the two lists never disagree.
		 *
		 * Accepts both the client store shape ({ ids, byId }) and the raw API
		 * response shape ({ items }) so the plugin can refresh directly from the
		 * host on open and never depend on a stale cache.
		 */
		function deriveHistory(list, workspaces) {
			const archived = new Set(workspaces.archivedSessionIds ?? []);
			const byWorkspace = new Map();
			for (const workspace of workspaces.items ?? []) {
				for (const id of workspace.sessionIds ?? []) byWorkspace.set(id, workspace);
			}
			const ids = Array.isArray(list.ids) ? list.ids : (list.items ?? []).map((s) => s.sessionId);
			const byId = list.byId ?? Object.fromEntries((list.items ?? []).map((s) => [s.sessionId, s]));
			const sortRows = (rows) => rows.sort((a, b) => {
				if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
				return a.id < b.id ? -1 : 1;
			});
			const build = (filter) => {
				const rows = [];
				for (const id of ids) {
					const session = byId !== void 0 ? byId[id] : void 0;
					if (session === void 0) continue;
					if (session.blank === true) continue;
					if (session.origin === "subagent") continue;
					if (!filter(archived.has(id))) continue;
					const title = session.displayTitle !== void 0 && session.displayTitle !== ""
						? session.displayTitle
						: (session.projections?.values?.title ?? session.title ?? id);
					const workspace = byWorkspace.get(id);
					rows.push({
						id,
						title,
						updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : 0,
						running: session.running === true,
						workspace: workspace !== void 0 ? workspaceLabel(workspace.path, workspace.title) : workspaceLabel(session.cwd, "")
					});
				}
				return sortRows(rows);
			};
			return {
				active: build((archivedRow) => !archivedRow),
				archived: build((archivedRow) => archivedRow)
			};
		}

		/**
		 * Sidebar footer action: a "历史会话" pill that opens a popover listing
		 * every past session (recency-sorted, across workspaces), with archived
		 * sessions shown in a separate "已归档" group. Each row carries its own
		 * trash button to delete that single session (confirmed by a dialog);
		 * clicking an active row opens (resumes) it, clicking an archived row
		 * first unarchives it and then opens it. A pinned danger row deletes
		 * ALL history (current + running + archived sessions are never touched)
		 * behind the same risk-confirmation dialog.
		 */
		function HistoryEntry({ wide, sessions, workspaces, connection, openSession }) {
			const [open, setOpen] = react.useState(false);
			const [deleting, setDeleting] = react.useState(false);
			const [deleteError, setDeleteError] = react.useState(null);
			const [restoring, setRestoring] = react.useState(null);
			const [fresh, setFresh] = react.useState(null);
			const [popoverPos, setPopoverPos] = react.useState(null);
			const wrapRef = react.useRef(null);
			const list = react.useSyncExternalStore((listener) => sessions.list.subscribe(listener), () => sessions.list.getSnapshot());
			const workspaceSnapshot = react.useSyncExternalStore((listener) => workspaces.list.subscribe(listener), () => workspaces.list.getSnapshot());
			const effectiveList = fresh !== null ? fresh.list : list;
			const effectiveWorkspaces = fresh !== null ? fresh.workspaces : workspaceSnapshot;
			const { active: activeRows, archived: archivedRows } = react.useMemo(() => deriveHistory(effectiveList, effectiveWorkspaces), [effectiveList, effectiveWorkspaces, fresh]);
			const archivedIds = react.useMemo(() => new Set(workspaceSnapshot.archivedSessionIds ?? []), [workspaceSnapshot]);
			const deletable = [...activeRows, ...archivedRows].filter((row) => row.id !== list.current && !row.running);
			const archivedDeletable = archivedRows.filter((row) => row.id !== list.current && !row.running);
			const label = "历史会话";
			const confirmDeleteArchived = () => {
				setDeleteError(null);
				const ids = archivedDeletable.map((row) => row.id);
				if (ids.length === 0) return;
				const msg = "将永久删除 " + ids.length + " 个已归档会话，且无法恢复。\n\n当前会话、正在运行的会话与未归档历史不受影响。\n\n点「确定」继续，点「取消」放弃。";
				setOpen(false);
				if (window.confirm(msg)) doDelete(ids);
			};
			const confirmDeleteAll = () => {
				setDeleteError(null);
				const ids = deletable.map((row) => row.id);
				if (ids.length === 0) return;
				const msg = "将永久删除 " + ids.length + " 个历史会话（含 " + deletable.filter((row) => archivedIds.has(row.id)).length + " 个已归档），且无法恢复。\n\n当前会话与正在运行的会话不受影响。\n\n点「确定」继续，点「取消」放弃。";
				setOpen(false);
				if (window.confirm(msg)) doDelete(ids);
			};
			const confirmDeleteOne = (row) => {
				setDeleteError(null);
				const msg = "将永久删除会话「" + (row.title !== "" ? row.title : row.id) + "」，且无法恢复。\n\n当前会话与正在运行的会话不受影响。\n\n点「确定」继续，点「取消」放弃。";
				setOpen(false);
				if (window.confirm(msg)) doDelete([row.id]);
			};
			const loadFresh = () => {
				if (connection.api === void 0) return;
				Promise.all([
					connection.api.sessions.list({}),
					connection.api.workspace.list({})
				]).then(([sessionsRes, workspacesRes]) => {
					if (sessionsRes?.result?.ok === true && workspacesRes?.result?.ok === true) {
						setFresh({
							list: sessionsRes.result.value,
							workspaces: workspacesRes.result.value
						});
					}
				}).catch(() => {});
			};
			const doDelete = (ids) => {
				setDeleting(true);
				// 目录删除与归档标记清理由 host 端完成；这里不预先 unarchive，
				// 删除失败时会话保持原状态。
				connection.rpc.call("/session-history", "delete-all", { sessionIds: ids }).then((result) => {
					setDeleting(false);
					if (!result.ok) {
						setDeleteError(result.error?.message ?? "删除失败");
						return;
					}
					setOpen(false);
					// 只刷新会话列表（已删会话从列表消失）；不刷新工作区，
					// 因为删除不改变 workspace 记账，避免会话被重新归类。
					sessions.refreshList();
				}, (error) => {
					setDeleting(false);
					setDeleteError(String(error));
				});
			};
			const handleSelect = (sessionId) => {
				if (sessionId === "__delete_all__") {
					confirmDeleteAll();
					return;
				}
				setOpen(false);
				if (!archivedIds.has(sessionId)) {
					openSession(sessionId);
					return;
				}
				const target = archivedRows.find((row) => row.id === sessionId);
				setRestoring(target !== void 0 && target.title !== "" ? target.title : sessionId);
				workspaces.unarchiveSession(sessionId).then(() => {
					setRestoring(null);
					openSession(sessionId);
				}, (error) => {
					setRestoring(null);
					setDeleteError("恢复失败：" + (error?.message ?? String(error)));
				});
			};
			const closePopover = () => {
				setOpen(false);
			};
			const startDrag = (e) => {
				if (e.button !== 0 && e.type === "mousedown") return;
				const base = popoverPos !== null
					? popoverPos
					: { left: Math.max(12, Math.floor((window.innerWidth - 680) / 2)), top: Math.max(12, Math.floor((window.innerHeight - 560) / 2)) };
				const offsetX = base.left - e.clientX;
				const offsetY = base.top - e.clientY;
				const onMove = (ev) => {
					setPopoverPos({
						...base,
						left: ev.clientX + offsetX,
						top: ev.clientY + offsetY
					});
				};
				const onUp = () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					document.body.style.userSelect = "";
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				document.body.style.userSelect = "none";
				e.preventDefault();
			};
			react.useLayoutEffect(() => {
				if (!open) {
					setPopoverPos(null);
					return;
				}
				const place = () => {
					const MARGIN = 12;
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const estWidth = Math.min(680, vw - 2 * MARGIN);
					const estHeight = Math.min(560, vh - 2 * MARGIN);
					const x = Math.max(MARGIN, Math.floor((vw - estWidth) / 2));
					const y = Math.max(MARGIN, Math.floor((vh - estHeight) / 2));
					setPopoverPos({ left: x, top: y, width: estWidth, maxHeight: vh - 2 * MARGIN });
				};
				place();
				window.addEventListener("scroll", place, true);
				window.addEventListener("resize", place);
				return () => {
					window.removeEventListener("scroll", place, true);
					window.removeEventListener("resize", place);
				};
			}, [open]);
			react.useEffect(() => {
				if (!open) return;
				const onPointerDown = (e) => {
					if (wrapRef.current?.contains(e.target) === true) return;
					if (e.target instanceof Node && e.target.closest?.(".dsh_history_pop") != null) return;
					closePopover();
				};
				const onKeyDown = (e) => {
					if (e.key === "Escape") closePopover();
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			const rowContent = (row, archivedRow) => {
				const selected = row.id === list.current;
				const isCurrent = row.id === list.current;
				const main = react.createElement("div", {
					className: "dsh_history_row_main",
					children: [
						row.running ? react.createElement("span", { className: "dsh_history_dot" }) : void 0,
						react.createElement("span", {
							className: "dsh_history_row_text",
							children: row.title + (row.workspace !== "" ? " · " + row.workspace : "") + " · " + (formatRelative(row.updatedAt) !== "" ? formatRelative(row.updatedAt) : "未知时间")
						}),
						isCurrent ? react.createElement("span", { className: "dsh_history_archived_badge", children: "当前" }) : void 0,
						archivedRow ? react.createElement("span", { className: "dsh_history_archived_badge", children: "已归档" }) : void 0
					]
				});
				const trash = react.createElement("button", {
					type: "button",
					className: "dsh_history_trash",
					title: isCurrent ? "当前会话不可删除" : (archivedRow ? "删除此归档会话" : "删除此会话"),
					"aria-label": "删除会话",
					disabled: isCurrent || deleting || restoring !== null,
					onClick: (e) => {
						e.stopPropagation();
						confirmDeleteOne(row);
					},
					children: react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 })
				});
				// 归档会话提供明确的「恢复」按钮：点击取消归档并打开该会话。
				const restoreBtn = archivedRow ? react.createElement("button", {
					type: "button",
					className: "dsh_history_trash dsh_history_restore",
					title: "恢复此归档会话",
					"aria-label": "恢复会话",
					disabled: deleting || restoring !== null,
					onClick: (e) => {
						e.stopPropagation();
						setOpen(false);
						const target = archivedRows.find((r) => r.id === row.id);
						setRestoring(target !== void 0 && target.title !== "" ? target.title : row.id);
						workspaces.unarchiveSession(row.id).then(() => {
							setRestoring(null);
							openSession(row.id);
						}, (error) => {
							setRestoring(null);
							setDeleteError("恢复失败：" + (error?.message ?? String(error)));
						});
					},
					children: react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 })
				}) : null;
				return react.createElement("div", {
					className: "dsh_history_row_wrap",
					key: row.id,
					children: [
						react.createElement("button", {
							type: "button",
							role: "menuitem",
							className: "dsh_history_row" + (selected ? " selected" : ""),
							onClick: () => handleSelect(row.id),
							children: main
						}),
						restoreBtn,
						trash
					]
				});
			};
			const viewport = [];
			for (const row of activeRows) viewport.push(rowContent(row, false));
			if (archivedRows.length > 0) {
				viewport.push(react.createElement("div", { className: "dsh_history_group", key: "__archived__", children: "已归档会话（点击恢复并打开）" }));
				for (const row of archivedRows) viewport.push(rowContent(row, true));
			}
			if (viewport.length === 0) {
				viewport.push(react.createElement("div", { className: "dsh_history_group", key: "__empty__", children: "暂无历史会话" }));
			}
			const popover = open ? react.createElement("div", {
				className: "dsh_history_pop",
				style: popoverPos !== null ? { left: popoverPos.left, top: popoverPos.top, width: popoverPos.width, maxHeight: popoverPos.maxHeight } : void 0,
				children: [
					react.createElement("div", { className: "dsh_history_bar", onMouseDown: startDrag }),
					react.createElement("div", { className: "dsh_history_viewport", children: viewport }),
					react.createElement("div", { className: "dsh_history_footer", children: [
						react.createElement("div", { className: "dsh_history_count", key: "__count__", children: "共 " + activeRows.length + " 个会话，已归档 " + archivedRows.length + " 个" }),
						restoring !== null ? react.createElement("div", { className: "dsh_history_count", key: "__restoring__", children: "正在恢复「" + restoring + "」…" }) : void 0,
						deleteError !== null ? react.createElement("div", { className: "dsh_history_error", key: "__delete_error__", children: deleteError }) : void 0,
						deletable.length > 0 ? react.createElement("button", {
							type: "button",
							className: "dsh_history_footer_btn",
							key: "__delete_archived__",
							disabled: deleting || restoring !== null,
							onClick: confirmDeleteArchived,
							children: [
								react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 }),
								react.createElement("span", { children: "仅删除已归档会话（" + archivedDeletable.length + "）" })
							]
						}) : void 0,
						archivedDeletable.length > 0 ? react.createElement("button", {
							type: "button",
							className: "dsh_history_footer_btn",
							key: "__delete_all__",
							disabled: deleting || restoring !== null,
							onClick: confirmDeleteAll,
							children: [
								react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 14 }),
								react.createElement("span", { children: "删除全部历史会话（" + deletable.length + "）" })
							]
						}) : void 0
					] })
				]
			}) : null;
			return react.createElement("div", {
				ref: wrapRef,
				className: "dsh_history_wrap",
				children: [
					react.createElement("button", {
						type: "button",
						className: "dsh_history_pill",
						title: label,
						"aria-label": label,
						"aria-haspopup": "menu",
						"aria-expanded": open,
						onClick: () => {
							const next = !open;
							if (next) {
								sessions.refreshList?.();
								workspaces.refresh?.();
								loadFresh();
							}
							setOpen(next);
						},
						children: [
							react.createElement(ClockIcon, { size: 14 }),
							wide ? react.createElement("span", { className: "dsh_history_text", children: label }) : null
						]
					}),
					react.createElement("div", {
						className: "dsh_history_pop_portal",
						children: [popover]
					})
				]
			});
		}

		//#region client plugin body
		const inject = ["slots", "sessions", "workspaces", "connection"];
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "session-history",
				order: -10
			}, (props) => react.createElement(HistoryEntry, {
				wide: props.wide,
				sessions: ctx.sessions,
				workspaces: ctx.workspaces,
				connection: ctx.connection,
				openSession: (sessionId) => {
					ctx.sessions.open(sessionId);
				}
			})));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});