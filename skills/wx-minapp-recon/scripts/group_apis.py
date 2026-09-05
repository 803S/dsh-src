#!/usr/bin/env python3
"""
API 分组与合并工具 (group_apis.py v1.1 — 小程序版)

用于 wx-minapp-recon Phase 3.5 的预处理和后处理:
  group  - 读取 XLSX + CSV, 按来源 JS 文件分组, 输出 JSON
  merge  - 读取 AI 填好的 JSON, 合并回 XLSX + CSV

v1.1: 分组策略从路径前缀(depth-2)改为按来源 JS 文件分组,
      更适合小程序的扁平路径结构。

依赖: 标准库 + openpyxl
"""
import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict


# ═══════════════════════════════════════════════════════════
#  路径处理工具 (与 js-recon-security 版一致)
# ═══════════════════════════════════════════════════════════

ID_PATTERNS = [
    re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I),
    re.compile(r'^\d+$'),
    re.compile(r'^\{[^}]+\}$'),
    re.compile(r'^\[[^\]]+\]$'),
    re.compile(r'^:[\w]+$'),
    re.compile(r'^\$\{'),
]

VERSION_RE = re.compile(r'^v\d+$', re.I)

SKIP_SEGMENTS = {
    'api', 'rest', 'service', 'rpc', 'gateway', 'proxy',
    'graphql', 'internal', 'open', 'public', 'private',
}


def is_dynamic_segment(seg):
    for p in ID_PATTERNS:
        if p.match(seg):
            return True
    return False


def is_version_prefix(seg):
    return bool(VERSION_RE.match(seg))


def _module_name_from_prefix(prefix):
    """从路径前缀生成可读的模块名"""
    segs = [s for s in prefix.strip('/').split('/') if s]
    meaningful = [s for s in segs if not is_version_prefix(s) and s.lower() not in SKIP_SEGMENTS]
    if meaningful:
        return meaningful[-1]
    if segs:
        return segs[-1]
    return '_other'


def _extract_prefix(segments, depth):
    """从路径段提取指定深度的前缀, 跳过版本号"""
    prefix_parts = []
    for seg in segments:
        if is_version_prefix(seg):
            continue
        prefix_parts.append(seg)
        if len(prefix_parts) >= depth:
            break
    return '/' + '/'.join(prefix_parts) if prefix_parts else ''


# ═══════════════════════════════════════════════════════════
#  分组核心算法 (v1.1: 按 JS 文件分组)
# ═══════════════════════════════════════════════════════════

def _clean_filename(name):
    """从 JS 文件名提取可读模块名: cx-wechat-order.js → order"""
    base = name
    for ext in ('.js', '.ts', '.mjs'):
        if base.endswith(ext):
            base = base[:-len(ext)]
            break
    # 去掉常见前缀: cx-wechat-, cx-, wx-
    for pfx in ('cx-wechat-', 'wechat-', 'cx-', 'wx-', 'miniprogram-'):
        if base.startswith(pfx):
            base = base[len(pfx):]
            break
    # 去掉版本号后缀: -2.0, _v2
    base = re.sub(r'[-_]v?\d+(\.\d+)*$', '', base)
    # 把 kebab-case / snake_case 转成 camelCase 可读
    return base if base else name.split('.')[0]


def group_by_js_file(path_info, max_group=30):
    """
    按来源 JS 文件分组:
      1. 每个 JS 文件 → 一个模块
      2. 超过 max_group 的文件按 depth-1 前缀拆分为子模块
      3. 无 js_file 的路径归入 _other
    """
    # ── Step 1: 按文件收集 ──
    file_buckets = defaultdict(list)
    no_file = []
    for path, info in path_info.items():
        js_file = (info.get('js_file') or '').strip()
        if js_file:
            file_buckets[js_file].append((path, info))
        else:
            no_file.append((path, info))

    # ── Step 2: 生成模块 ──
    seen = set()
    groups = {}

    def _register(key, module_name, source_file, items, prefix=''):
        if key in seen:
            key = f"{key}__{len(groups)}"
        seen.add(key)
        groups[key] = {
            'module_name': module_name,
            'source_file': source_file,
            'prefix': prefix,
            'paths': items,
        }

    # 按文件大小降序, 方便编号
    for js_file, items in sorted(file_buckets.items(), key=lambda x: -len(x[1])):
        base_name = _clean_filename(js_file)

        if len(items) <= max_group:
            _register(base_name, base_name, js_file, items)
        else:
            # ── 按 depth-1 前缀拆分 ──
            sub = defaultdict(list)
            for path, info in items:
                segs = [s for s in path.strip('/').split('/') if s]
                pfx = '/' + segs[0] if segs else '/_root'
                sub[pfx].append((path, info))

            # 子组过小的合并回一个子组
            sub_items = sorted(sub.items(), key=lambda x: -len(x[1]))
            for prefix, sub_paths in sub_items:
                sub_name = f"{base_name}__{prefix.lstrip('/')}"
                _register(sub_name, sub_name, js_file, sub_paths, prefix)

    # ── Step 3: _other (无 js_file 的路径) ──
    if no_file:
        _register('_other', '_other', '', no_file)

    # ── Step 4: 排序 (_other 放最后) ──
    keys = sorted(
        groups.keys(),
        key=lambda k: (groups[k]['module_name'] == '_other',
                       groups[k]['module_name']),
    )
    return {k: groups[k] for k in keys}


# ═══════════════════════════════════════════════════════════
#  XLSX 读取辅助
# ═══════════════════════════════════════════════════════════

def _read_api_xlsx(xlsx_path):
    """读取 api_endpoints.xlsx, 返回 (rows, headers)"""
    from openpyxl import load_workbook
    wb = load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    rows = []
    headers = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            headers = list(row)
            continue
        rows.append(dict(zip(headers, row)))
    wb.close()
    return rows, headers


# ═══════════════════════════════════════════════════════════
#  group 子命令
# ═══════════════════════════════════════════════════════════

def cmd_group(args):
    """读取 XLSX + CSV, 按来源 JS 文件分组, 输出 JSON 到 AI 工作区"""
    api_xlsx = args.api_xlsx
    params_csv = args.params_csv
    ai_dir = args.ai_dir or args.outdir or os.path.dirname(api_xlsx)
    max_g = args.max_group

    os.makedirs(ai_dir, exist_ok=True)

    # ── 1. 读取 api_endpoints.xlsx ──
    path_info = {}
    api_rows = []
    page_route_items = []          # 页面路由单独收集
    if os.path.exists(api_xlsx):
        api_rows, _ = _read_api_xlsx(api_xlsx)
        for row in api_rows:
            path = (row.get('接口') or '').strip()
            method = (row.get('method') or 'UNKNOWN').strip()
            js_file = (row.get('所在JS文件') or '').strip()
            path_type = (row.get('类型') or '待确认').strip()
            if not path:
                continue
            if path_type == '页面路由':
                page_route_items.append((path, {
                    'method': method, 'js_file': js_file, 'type': path_type,
                }))
                continue
            path_info[path] = {'method': method, 'js_file': js_file, 'type': path_type}

    # ── 2. API 分组 (按 JS 文件) ──
    api_groups = group_by_js_file(path_info, max_group=max_g)

    api_out = {
        '_meta': {
            'total_endpoints': len(path_info),
            'total_page_routes': len(page_route_items),
            'total_modules': len(api_groups) + (1 if page_route_items else 0),
            'generated_by': 'group_apis.py (minapp v1.1)',
            'grouping_strategy': 'js_file',
        },
        'modules': {},
    }
    for idx, (key, group) in enumerate(api_groups.items(), 1):
        mid = f"m{idx:02d}_{group['module_name']}"
        paths = group['paths'] if isinstance(group['paths'], list) else []
        api_out['modules'][mid] = {
            'module_name': group['module_name'],
            'source_file': group.get('source_file', ''),
            'prefix': group.get('prefix', ''),
            'apis': [
                {
                    'method': info.get('method', 'UNKNOWN'),
                    'path': path,
                    'js_file': info.get('js_file', ''),
                    'type': info.get('type', '待确认'),
                    'function': '',
                    'risk_note': '',
                }
                for path, info in paths
            ],
            'group_summary': '',
        }

    # ── 2b. 页面路由作为独立 _pages 模块 ──
    if page_route_items:
        next_idx = len(api_groups) + 1
        api_out['modules'][f"m{next_idx:02d}_pages"] = {
            'module_name': '_pages',
            'source_file': '',
            'prefix': '/_pages',
            'apis': [
                {
                    'method': info.get('method', ''),
                    'path': path,
                    'js_file': info.get('js_file', ''),
                    'type': '页面路由',
                    'function': '',
                    'risk_note': '',
                }
                for path, info in page_route_items
            ],
            'group_summary': '',
        }

    # ── 3. 写入 api_groups.json ──
    api_json_path = os.path.join(ai_dir, 'api_groups.json')
    with open(api_json_path, 'w', encoding='utf-8') as f:
        json.dump(api_out, f, ensure_ascii=False, indent=2)

    mod_sizes = [len(m['apis']) for m in api_out['modules'].values()]
    print(f"[+] API 分组完成 (按 JS 文件):")
    print(f"    API 端点: {len(path_info)} → {len(api_groups)} 个模块")
    print(f"    页面路由: {len(page_route_items)} 条 (_pages 模块)")
    if mod_sizes:
        print(f"    每组: {min(mod_sizes)}-{max(mod_sizes)} 条 (均值 {sum(mod_sizes)//len(mod_sizes)})")
    print(f"    输出: {api_json_path}")

    # ── 4. 读取 params.csv ──
    params_by_file = defaultdict(list)
    param_count = 0
    if os.path.exists(params_csv):
        with open(params_csv, 'r', encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                param_count += 1
                param = (row.get('参数') or '').strip()
                js_file = (row.get('所在JS文件') or '').strip()
                desc = (row.get('参数中文描述') or '').strip()
                if param and not param.startswith('[分组汇总]'):
                    params_by_file[js_file].append({
                        'param': param,
                        'source': (row.get('提取来源') or '').strip(),
                        'current_desc': desc,
                    })

    # ── 5. 参数分组 (按来源 JS 文件) ──
    param_out = {
        '_meta': {
            'total_params': param_count,
            'total_groups': 0,
            'generated_by': 'group_apis.py (minapp)',
        },
        'groups': {},
    }

    pidx = 0
    for js_file, params in sorted(params_by_file.items(), key=lambda x: -len(x[1])):
        pidx += 1
        gid = f"p{pidx:02d}"
        if len(params) > 30:
            param_out['groups'][gid] = {
                'source_file': js_file,
                'params': params[:30],
                'params_total': len(params),
                'group_summary': '',
            }
        else:
            param_out['groups'][gid] = {
                'source_file': js_file,
                'params': params,
                'params_total': len(params),
                'group_summary': '',
            }

    param_out['_meta']['total_groups'] = len(param_out['groups'])

    # ── 6. 写入 param_groups.json ──
    param_json_path = os.path.join(ai_dir, 'param_groups.json')
    with open(param_json_path, 'w', encoding='utf-8') as f:
        json.dump(param_out, f, ensure_ascii=False, indent=2)

    pg_sizes = [len(g['params']) for g in param_out['groups'].values()]
    print(f"\n[+] 参数分组完成:")
    print(f"    总参数: {param_count}")
    print(f"    分组数: {len(param_out['groups'])}")
    if pg_sizes:
        print(f"    每组: {min(pg_sizes)}-{max(pg_sizes)} 条")
    print(f"    输出: {param_json_path}")


# ═══════════════════════════════════════════════════════════
#  merge 子命令
# ═══════════════════════════════════════════════════════════

def cmd_merge(args):
    """读取 AI 填好的 JSON, 合并回 XLSX + CSV"""
    api_groups_path = args.api_groups
    param_groups_path = args.param_groups
    outdir = args.outdir or os.path.dirname(api_groups_path)
    os.makedirs(outdir, exist_ok=True)

    if api_groups_path and os.path.exists(api_groups_path):
        _merge_api_xlsx(api_groups_path, outdir)

    if param_groups_path and os.path.exists(param_groups_path):
        _merge_params(param_groups_path, outdir)


def _merge_api_xlsx(json_path, outdir):
    """合并 api_endpoints.xlsx — 测试状态下拉 + 条件格式 + 模块汇总列"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.formatting.rule import FormulaRule
    from openpyxl.worksheet.datavalidation import DataValidation

    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    wb = Workbook()
    ws = wb.active
    ws.title = "接口清单"

    # ── 表头 (7列: 原6列 + 模块汇总) ──
    headers = ['接口', '类型', '接口功能', '测试状态', '所在JS文件', 'method', '模块汇总']
    hdr_fill = PatternFill(start_color="4472C4", end_color="4472C4", fill_type="solid")
    hdr_font_white = Font(bold=True, color="FFFFFF")
    for col_idx, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col_idx, value=h)
        cell.font = hdr_font_white
        cell.fill = hdr_fill
        cell.alignment = Alignment(horizontal='center')

    # ── 样式 ──
    fill_vuln = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")
    fill_tested = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    fill_skip = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")
    summary_fill = PatternFill(start_color="D6E4F0", end_color="D6E4F0", fill_type="solid")
    summary_font = Font(bold=True)
    summary_align = Alignment(wrap_text=True, vertical='top')

    # ── 写入数据 ──
    row_idx = 2
    total_endpoints = 0
    total_modules = 0

    for mid, module in data.get('modules', {}).items():
        total_modules += 1
        mod_name = module.get('module_name', '')
        summary_text = module.get('group_summary', '')
        group_start = row_idx

        for api in module.get('apis', []):
            total_endpoints += 1
            func = api.get('function', '')
            risk = api.get('risk_note', '')
            func_display = func
            if risk:
                func_display = f"{func}  [{risk}]" if func else f"[{risk}]"

            ws.cell(row=row_idx, column=1, value=api.get('path', ''))
            ws.cell(row=row_idx, column=2, value=api.get('type', '待确认'))
            ws.cell(row=row_idx, column=3, value=func_display)
            ws.cell(row=row_idx, column=5, value=api.get('js_file', ''))
            ws.cell(row=row_idx, column=6, value=api.get('method', ''))
            row_idx += 1

        group_end = row_idx - 1

        # 第 7 列: 合并单元格写入模块汇总
        if summary_text:
            if group_end > group_start:
                ws.merge_cells(
                    start_row=group_start, start_column=7,
                    end_row=group_end, end_column=7,
                )
            cell = ws.cell(row=group_start, column=7, value=summary_text)
            cell.alignment = summary_align
            cell.fill = summary_fill
            cell.font = summary_font

    last_data_row = row_idx - 1

    # ── 数据验证: 测试状态下拉 ──
    if last_data_row >= 2:
        dv = DataValidation(
            type="list",
            formula1='"未测,已测,有漏洞,跳过"',
            allow_blank=True,
            showErrorMessage=True,
            errorTitle="无效输入",
            error="请从下拉列表中选择测试状态",
        )
        dv.sqref = f"D2:D{last_data_row}"
        ws.add_data_validation(dv)

    # ── 条件格式 ──
    if last_data_row >= 2:
        cf_range = f"A2:G{last_data_row}"
        ws.conditional_formatting.add(cf_range, FormulaRule(
            formula=['$D2="有漏洞"'], fill=fill_vuln, stopIfTrue=True))
        ws.conditional_formatting.add(cf_range, FormulaRule(
            formula=['$D2="已测"'], fill=fill_tested, stopIfTrue=True))
        ws.conditional_formatting.add(cf_range, FormulaRule(
            formula=['$D2="跳过"'], fill=fill_skip, stopIfTrue=True))

    # ── 列宽 / 冻结 / 筛选 ──
    col_widths = {
        'A': 45, 'B': 10, 'C': 50, 'D': 10,
        'E': 30, 'F': 10, 'G': 45,
    }
    for col_letter, width in col_widths.items():
        ws.column_dimensions[col_letter].width = width
    ws.freeze_panes = 'A2'
    if last_data_row >= 2:
        ws.auto_filter.ref = f"A1:G{last_data_row}"

    xlsx_path = os.path.join(outdir, 'api_endpoints.xlsx')
    wb.save(xlsx_path)

    print(f"[+] api_endpoints.xlsx 已生成:")
    print(f"    接口: {total_endpoints} 条")
    print(f"    模块: {total_modules} 个 (汇总已合并到第7列)")
    print(f"    输出: {xlsx_path}")


def _merge_params(json_path, outdir):
    """合并 params.csv — 含分组汇总行"""
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    rows = []
    total_params = 0
    total_groups = 0

    for gid, group in data.get('groups', {}).items():
        total_groups += 1
        source = group.get('source_file', '')
        summary = group.get('group_summary', '')

        for p in group.get('params', []):
            total_params += 1
            rows.append({
                '参数': p.get('param', ''),
                '提取来源': p.get('source', ''),
                '是否参数': p.get('is_param', ''),
                '参数中文描述': p.get('description', p.get('current_desc', '')),
                '所在JS文件': source,
            })

        # 分组汇总行
        total_in_file = group.get('params_total', len(group.get('params', [])))
        summary_display = summary
        if total_in_file > len(group.get('params', [])):
            extra = total_in_file - len(group.get('params', []))
            summary_display = f"(本文件共 {total_in_file} 个参数, 展示前 {len(group.get('params', []))} 个) {summary}"
        rows.append({
            '参数': f'[分组汇总] {source}',
            '提取来源': '',
            '是否参数': '',
            '参数中文描述': summary_display,
            '所在JS文件': '',
        })

    csv_path = os.path.join(outdir, 'params.csv')
    fieldnames = ['参数', '提取来源', '是否参数', '参数中文描述', '所在JS文件']
    with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)

    print(f"[+] params.csv 已合并:")
    print(f"    参数: {total_params} 条")
    print(f"    分组汇总: {total_groups} 条")
    print(f"    输出: {csv_path}")


# ═══════════════════════════════════════════════════════════
#  CLI 入口
# ═══════════════════════════════════════════════════════════

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='API 分组与合并工具 (wx-minapp-recon Phase 3.5)')
    sub = parser.add_subparsers(dest='command', help='子命令')

    # ── group ──
    g = sub.add_parser('group', help='读取 XLSX + CSV, 按 JS 文件分组, 输出 JSON 到 AI 工作区')
    g.add_argument('api_xlsx', help='api_endpoints.xlsx 路径')
    g.add_argument('params_csv', help='params.csv 路径')
    g.add_argument('--ai-dir', help='AI 工作区目录 (JSON 输出到此, 默认: --outdir 或 XLSX 所在目录)')
    g.add_argument('--outdir', '-o', help='备用输出目录 (当 --ai-dir 未指定时使用)')
    g.add_argument('--max-group', type=int, default=30,
                   help='单个 JS 文件最大接口数, 超过则按路径前缀拆分 (默认: 30)')

    # ── merge ──
    m = sub.add_parser('merge', help='读取 AI 填好的 JSON, 合并回 XLSX + CSV')
    m.add_argument('--api-groups', required=True,
                   help='AI 填好的 api_groups.json')
    m.add_argument('--param-groups', required=True,
                   help='AI 填好的 param_groups.json')
    m.add_argument('--outdir', '-o', help='输出目录 (默认: JSON 所在目录)')

    args = parser.parse_args()
    if args.command == 'group':
        cmd_group(args)
    elif args.command == 'merge':
        cmd_merge(args)
    else:
        parser.print_help()
