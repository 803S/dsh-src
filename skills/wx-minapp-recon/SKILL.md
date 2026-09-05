---
name: wx-minapp-recon
description: 微信小程序安全审计工具。扫描电脑上的微信小程序 wxapkg 包，使用 wedecode 反编译后提取 API 接口路径、参数名、敏感信息（30+种：邮箱/手机/密钥/Token/AK/Webhook等）、云开发环境 ID、app.json 配置泄露、wx.request API 地址等，并由 AI 回填接口功能与参数中文描述。当用户要求"扫描小程序"、"反编译小程序"、"小程序安全审计"、"审计小程序代码"、"分析小程序接口"时触发。
---

<!-- [dsh-src 接入说明] 本 skill 是 dsh-src 运行时能力（id: wx-minapp-recon）的仓库副本，
     扫描/反编译的是【本机微信客户端缓存里已有的 wxapkg 包】。前置条件：目标小程序必须已
     在本机微信中打开过（含登录态）。因此当目标含小程序资产时：先 src_user_todo
     (kind=manual-test, title="请在微信打开目标小程序并确认登录") 提待办移交用户，用户完成
     后再执行本 skill 的扫描→反编译→提取流水线；script 执行走 src_run_capability
     （异步挂起待审，用户批准后经 src_resolve_approval 拿输出）。产出以 src_record_observation
     固化，文件产物放本次 engagement 的探测目录。 -->

# 微信小程序安全审计

## 工作流程概览

```
用户触发: "帮我审计微信小程序" / "扫描电脑上的小程序"

Phase 1: 小程序包扫描  ──→  scan_wxapkg.py 扫描默认路径+用户选择
Phase 2: 反编译        ──→  run_decompile.py 调用wedecode反编译
Phase 3: 提取分析      ──→  extract_minapp.py 增强提取+导出(XLSX/CSV)
Phase 3.5: 分组        ──→  group_apis.py 按模块分组输出JSON
Phase 4: AI语义分析    ──→  AI(LLM)逐组读取JSON并回填接口功能/参数描述
Phase 5: 合并          ──→  group_apis.py merge 合并回XLSX/CSV
```

## Phase 1: 扫描小程序包

自动扫描微信默认缓存目录，列出全部小程序供用户选择。

```bash
python <skill_dir>/scripts/scan_wxapkg.py [--dir <path>] [--resolve-names] [--json] [--check-env] [--quick]
```

| 参数 | 说明 |
|------|------|
| `--dir` | 指定自定义扫描目录（默认扫描微信缓存路径） |
| `--resolve-names` | 通过解包 `app-config.json` 提取 tabBar 文字作为名称提示（约 2-3 秒/个） |
| `--json` | JSON 格式输出（非交互） |
| `--check-env` | 仅检查环境（Node.js / wedecode） |
| `--quick` | 跳过所有额外处理（包括名称解析） |

**输出**: 交互式列表，用户选择后输出选中包的 JSON 信息（含主包路径、分包列表）。

### 名称解析效果示例

```
[新版xwechat] [1] 寄快递/查快递/会员福利/生活服务/我的 (wxd4185d00bf7e08ac)
[新版xwechat] [2] 推广/我的 (wx6f7d3e01eebe7b88)
```

## Phase 2: 反编译

使用 wedecode CLI 反编译选中的 wxapkg 包。

```bash
python <skill_dir>/scripts/run_decompile.py -i <main_pkg_path> -o <output_dir> --sub <sub_pkg_1> <sub_pkg_2> ...
```

参数说明:
- `-i` / `--input`: 主包路径 (`__APP__.wxapkg`)
- `-o` / `--output`: 输出目录
- `--sub`: 分包路径列表（可选）

**前置条件**: 需要 Node.js 环境和 wedecode 全局安装 (`npm i wedecode -g`)

**输出**: 反编译后的源码目录，包含 JS/WXML/WXSS/JSON 等文件。

## Phase 3: 增强提取与导出

对反编译后的所有源码文件执行增强提取，包括通用敏感信息和小程序专项检测。

```bash
python <skill_dir>/scripts/extract_minapp.py <decompiled_dir> --outdir <output_dir> --ai-dir <ai_workspace_dir>
```

参数说明:
- `--outdir`: 最终交付物输出目录（`recon/`）
- `--ai-dir`: AI 工作区输出目录（`_ai_workspace/minapp-recon/`），不指定时默认与 `--outdir` 相同

**最终交付物** → `{output_dir}/`（`recon/`，人看的）:

| 文件 | 说明 |
|------|------|
| `api_endpoints.xlsx` | 接口清单（6列：接口, 类型, 接口功能, 测试状态, 所在JS文件, method） |
| `params.csv` | 参数清单（5列：参数, 提取来源, 是否参数, 参数中文描述, 所在JS文件） |
| `sensitive_findings.csv` | 敏感信息汇总表（三列：类型, 值, 所在文件） |
| `report.txt` | 人类可读审计报告 |

**AI 工作区产物** → `{ai_workspace_dir}/`（`_ai_workspace/minapp-recon/`，AI 处理用）:

| 文件 | 说明 |
|------|------|
| `report.json` | 结构化数据（全量） |
| `report_params.txt` | 参数提取报告 |
| `noise_candidates.json` | 可回溯噪音候选，记录被移出主表的路径/敏感信息及过滤原因 |

### 噪音候选与可回溯过滤

提取器采用分级过滤：

- `hard`：高度确定的误提取，如空路径、hash 片段、HTML/SVG 编码残片、图片文件名邮箱误报。
- `soft`：高概率噪音但仍可能有业务含义，如静态资源后缀路径、依赖路径、版本化资源路径、`.wxss` 中出现的路径候选。

带 query string 的路径会归一化后进入主表（如 `/page?id=1` → `/page`），原始带参形式写入 `noise_candidates.json` 便于回溯。敏感信息提取会对中国身份证号做出生日期和校验位校验；样式/SVG 中碰巧匹配到的坐标型 IP 会作为 `soft` 候选记录。

主表默认只输出保留项，所有被移出的项写入 `_ai_workspace/minapp-recon/noise_candidates.json`。如果接口数量异常偏少、怀疑下载/预览类接口被误移出，优先检查该文件，不要直接判定为未发现。

### 接口 XLSX 列说明

- **类型列**：脚本依据 `app.json` 页面路由表（主包 + 分包）自动区分 `API 端点` / `页面路由`
- **接口功能列**：提取阶段留空，Phase 4 AI 填入
- **测试状态列**：下拉菜单 `[未测/已测/有漏洞/跳过]`，条件格式自动变色（红/绿/灰）
- **method 列**：HTTP 方法，小程序静态分析通常无法确定，留空供人工补充

### 参数 CSV 列说明

- **提取来源列**：脚本自动标注参数提取策略（API请求、URL参数、请求配置、对象属性、变量解构等），同一参数多来源时保留优先级最高的
- **是否参数列**：Phase 4 AI 判断（`是`/`否`/`待确认`）
- **参数中文描述列**：Phase 4 AI 仅对 `是否参数` 为"是"的参数填入

### 通用提取（30+种）

| 类别 | 内容 |
|------|------|
| API路径 | `/api/xxx` 格式接口路径（噪声已自动过滤） |
| 参数提取 | ParamX 小程序版 v1.1：对象属性(含引号)/解构/函数参数/wx.request配置/API请求/URL参数/路由参数等 9 种策略 |
| 后端URL | `http(s)://` 开头的后端地址 |
| 敏感信息 | 邮箱/手机/IP/身份证/AK/SK/JWT/密钥/Token/Webhook/Grafana/GitHub/GitLab |
| 云AK | 阿里云/腾讯云/AWS/谷歌云/金山云/火山引擎/京东云 |
| 注释 | 单行/多行/HTML注释（常含遗留信息） |

### 小程序专项提取

| 类别 | 内容 |
|------|------|
| app.json 配置 | 页面路由列表、tabBar、插件声明、权限声明 |
| 云开发 env | `wx.cloud.init` 中的环境 ID |
| 云函数 | `cloud.callFunction` 中的函数名 |
| wx API 地址 | `wx.request`/`uploadFile`/`downloadFile` 中的 URL |
| 疑似密钥 | 配置中的 `secret`/`AppSecret` 等字段值 |

## Phase 3.5: 接口与参数分组

将 Phase 3 导出的接口和参数按模块分组，输出结构化 JSON 供 AI 逐组分析。页面路由单独收入 `_pages` 模块，API 端点按**来源 JS 文件**分组，参数按来源 JS 文件分组。

```bash
python <skill_dir>/scripts/group_apis.py group <recon_dir>/api_endpoints.xlsx <recon_dir>/params.csv --ai-dir <ai_workspace_dir>
```

参数说明:
- 位置参数 1: `api_endpoints.xlsx` 路径
- 位置参数 2: `params.csv` 路径
- `--ai-dir`: JSON 输出目录（`_ai_workspace/minapp-recon/`）
- `--max-group`: 单个 JS 文件最大接口数，超过则按 depth-1 路径前缀拆分为子模块（默认 30）

**输出** → `{ai_workspace_dir}/`（`_ai_workspace/minapp-recon/`）:

| 文件 | 说明 |
|------|------|
| `api_groups.json` | 按模块分组的接口数据（含 `_meta` 统计） |
| `param_groups.json` | 按 JS 文件分组的参数数据 |

### 分组规则

- **API 分组（按 JS 文件）**: 每个来源 JS 文件形成一个模块（文件名去 `cx-wechat-` 等前缀后作为模块名）。超过 max_group 的大文件按 depth-1 路径前缀拆分为子模块。无 `js_file` 的路径归入 `_other`
- **页面路由**: 单独收入 `_pages` 模块（详细处理规则见 Phase 4）
- **参数分组**: 按来源 JS 文件聚合，单文件超过 30 个参数时截断并标注总数

## Phase 4: AI 语义分析（大模型执行）

脚本仅生成数据，AI 分析由大模型（当前对话）逐组完成：

**2a. 接口功能分析（逐模块）**

1. 读取 `api_groups.json`，逐个 module 分析：
   - 分析该模块所有 API 路径语义，填入每个 api 的 `function` 字段
   - 如有安全风险，填入 `risk_note` 字段
   - 分析完该模块后，填入 `group_summary`（一句话概括该模块功能和风险点）
2. `type` 字段由脚本自动标注（`API 端点`），**只读不要修改**
3. `function` 字段只写纯功能描述：
   - 路径语义理解（`/pay`=支付, `/user`=用户, `/admin`=管理后台）
   - 上下文推断（小程序名称、tabBar 结构、业务模式）
   - 缩写展开（`detail`=详情, `list`=列表, `sync`=同步）
4. **`_pages` 模块特殊处理**：该模块包含所有页面路由（`type` = `页面路由`），不是安全测试目标：
   - `function` 填页面名称（如"首页"、"个人中心页面"、"订单详情页"）
   - `risk_note` 留空（除非页面路径本身暗示敏感功能，如 `/admin`）
   - `group_summary` 写一句话概括小程序的页面结构（如"共 22 个页面，涵盖首页、职位、个人中心三大模块"）

**AI 填写示例：**

普通 API 模块：
```json
{
  "module_name": "order",
  "apis": [
    {"path": "/order/create", "type": "API 端点", "function": "创建订单", "risk_note": ""},
    {"path": "/order/detail", "type": "API 端点", "function": "查询订单详情", "risk_note": ""},
    {"path": "/order/cancel", "type": "API 端点", "function": "取消订单", "risk_note": "需关注是否有越权取消他人订单"},
    {"path": "/order/export", "type": "API 端点", "function": "导出订单数据", "risk_note": "可能存在未授权批量导出"}
  ],
  "group_summary": "订单管理模块，涵盖创建、查询、取消和导出。cancel 需关注越权风险，export 需关注未授权数据泄露。"
}
```

`_pages` 模块（轻量分析）：
```json
{
  "module_name": "_pages",
  "apis": [
    {"path": "/pages/index/index", "type": "页面路由", "function": "首页", "risk_note": ""},
    {"path": "/pages/order/list", "type": "页面路由", "function": "订单列表页", "risk_note": ""},
    {"path": "/pages/user/center", "type": "页面路由", "function": "个人中心页面", "risk_note": ""}
  ],
  "group_summary": "共 N 个页面，涵盖首页、订单、个人中心三大模块。"
}
```

**2b. 参数分析（逐文件）**

1. 读取 `param_groups.json`，逐个 group 分析：
   - 结合 `source`（提取来源）和参数命名语义，判断每个参数是否为真实 API 参数
   - 填入 `is_param` 字段：`是` / `否` / `待确认`
   - 对 `is_param` 为"是"的参数，推断中文描述填入 `description` 字段
2. 分析完该组后，填入 `group_summary`（一句话概括该文件的参数特征）
3. **判断依据**：
   - 填 `是` — 参数名明确是 API 请求参数（如 userId, token, pageSize），或提取来源为 API请求/URL参数/请求配置 且参数名合理
   - 填 `否` — 明显是框架内部变量、UI 状态、构建配置（如 webpackChunk, componentName, renderMode）
   - 填 `待确认` — 无法确定，留给渗透测试时验证
4. **`description` 字段质量要求** — 必须写出参数的**业务含义**，严禁套皮描述：
   - **正确示例**：`account`→`账号`, `offset`→`分页偏移量`, `addrId`→`地址ID`, `order_id`→`订单编号`, `sourceFrom`→`来源渠道`, `channelNumber`→`渠道编号`, `reasonCode`→`原因代码`, `first_id`→`首级ID`
   - **错误示例（禁止）**：`account`→`请求参数: account`, `offset`→`请求参数: offset` — 这种只是在参数名前加前缀，毫无意义
   - **原则**：描述要让渗透测试人员一眼看懂参数用途，不需要再看英文名。如果参数名本身无法推断出明确含义（如 `T4`、`project`），结合所在接口的业务上下文推断；仍无法确定则留空

**分析维度参考:**
- 标注高价值参数（认证类、ID类、分页类）
- 关注小程序特有参数（`openid`、`unionId`、`scene`、`formId`、`jsCode`、`encryptedData`、`iv`）

**AI 填写示例：**
```json
{
  "source_file": "pages/order/create.js",
  "params": [
    {"param": "orderId", "source": "URL参数", "is_param": "是", "description": "订单编号"},
    {"param": "openid", "source": "API请求", "is_param": "是", "description": "用户唯一标识"},
    {"param": "totalAmount", "source": "请求配置", "is_param": "是", "description": "订单总金额"},
    {"param": "addrId", "source": "对象属性", "is_param": "是", "description": "收货地址ID"},
    {"param": "pageScrollTop", "source": "变量赋值", "is_param": "否", "description": ""},
    {"param": "showModal", "source": "对象属性", "is_param": "否", "description": ""}
  ],
  "group_summary": "订单创建页参数，4 个真实 API 参数（订单编号、用户标识、金额、地址ID），2 个 UI 状态变量。openid 为高价值认证类参数。"
}
```

## Phase 5: 合并回表

AI 填完 JSON 后，合并回 XLSX 和 CSV 最终交付物。

```bash
python <skill_dir>/scripts/group_apis.py merge --api-groups <ai_workspace_dir>/api_groups.json --param-groups <ai_workspace_dir>/param_groups.json --outdir <recon_dir>
```

**输出** → `{recon_dir}/`（覆盖 Phase 3 的原始文件）:

| 文件 | 说明 |
|------|------|
| `api_endpoints.xlsx` | 接口清单（7列：原6列 + 模块汇总合并单元格） |
| `params.csv` | 参数清单（5列：含分组汇总行） |

## 快速扫描（一键全流程）

```bash
# 1. 扫描小程序
python <skill_dir>/scripts/scan_wxapkg.py
# 2. 反编译
python <skill_dir>/scripts/run_decompile.py -i <main_pkg> -o ./decompile_output/<appid>
# 3. 提取
python <skill_dir>/scripts/extract_minapp.py ./decompile_output/<appid> --outdir ./<appid>/recon --ai-dir ./<appid>/_ai_workspace/minapp-recon
# 4. 分组
python <skill_dir>/scripts/group_apis.py group ./<appid>/recon/api_endpoints.xlsx ./<appid>/recon/params.csv --ai-dir ./<appid>/_ai_workspace/minapp-recon
# 5. AI 逐模块分析 api_groups.json + param_groups.json（见 Phase 4）
# 6. 合并回表
python <skill_dir>/scripts/group_apis.py merge --api-groups ./<appid>/_ai_workspace/minapp-recon/api_groups.json --param-groups ./<appid>/_ai_workspace/minapp-recon/param_groups.json --outdir ./<appid>/recon
```

> `scan_wxapkg.py` 输出的 JSON（含 main_pkg、sub_pkgs、output_dir）可直接作为后续命令的参数。

## 最终产物

```
<appid>/                                  # appid 即顶层目录
├── decompile_output/                     ← Phase 2 反编译源码
├── recon/                                ← 人看的最终交付物
│   ├── api_endpoints.xlsx
│   ├── params.csv
│   ├── sensitive_findings.csv
│   └── report.txt
│
├── _ai_workspace/minapp-recon/           ← AI 工作区 (中间产物)
│   ├── report.json
│   ├── report_params.txt
│   ├── api_groups.json                   ← Phase 3.5 生成, AI 填写后 Phase 5 合并
│   ├── param_groups.json
│   └── noise_candidates.json
│
├── evidence/                             ← 漏洞证据
└── notes.md                              ← 测试笔记
```

> `recon/` 放人看的交付物，`_ai_workspace/minapp-recon/` 放 AI 处理中的中间文件。

## 常见问题

### 同一 appid 出现多次

扫描可能发现同一 appid 来自不同微信用户账号或不同版本。脚本默认选取最新版本（版本号最大的那个），包含该版本的完整分包列表。

## 微信版本与路径

### 新版微信 (xwechat) — 完全支持
- 小程序包存储在 `%APPDATA%\Tencent\xwechat\radium\users\<hash>\applet\packages\<wxappid>\<version>\__APP__.wxapkg`
- wedecode 可直接解密并反编译
- 脚本会自动扫描此路径

### 旧版微信 (WeChat Files) — 完全支持
- 小程序包存储在 `Documents\WeChat Files\Applet\wx{appid}\__APP__.wxapkg`
- wedecode 可直接反编译

> **注意**：分包文件（`_xxx_.wxapkg`、`__sub_xxx__`）需要与主包在同一目录下。
