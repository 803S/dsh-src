---
name: src-rules-scraper
description: 抓任意厂商SRC规则。SRC站全是SPA,内容在JSON API非HTML,用performance面板找API。
---

# SRC 规则抓取（SPA 通用方法论）

## 核心思路

SRC 平台（安全应急响应中心）几乎都是 Vue/React SPA。curl 拿到的 HTML 是空壳，
规则正文由后端 JSON API 动态渲染。抓取路径不是爬 DOM，而是**找到数据 API 直接调**：

```
curl 探测(确认SPA) → browser_navigate(渲染) → performance 找真实API
→ 浏览器上下文调API(复用登录态) → JSON 取原始内容 → 去HTML标签成纯文本
```

比爬 DOM 稳：API 返回的是结构化原始数据，不受分页/懒加载/富文本组件影响。

## 流程

### Step 1: curl 探测，确认目标形态

```bash
curl -sL --max-time 10 -o /dev/null -w "HTTP %{http_code}" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  "https://target-src.example.com"
```

- HTTP 200 + 内容能直接 grep 到规则文字 → 静态站，直接抓，结束
- HTTP 200 但 `<div id="app"></div>` 空壳 + app.js/manifest.js/vendor.js → SPA，走 Step 2
- 域名猜不中 → 先搜 "厂商名 + SRC/安全应急响应中心" 确认域名

### Step 2: 浏览器导航，让 SPA 渲染

browser_navigate 到目标 URL，看 snapshot：
- 渲染成功 → 记下导航菜单（首页/奖励标准/提交漏洞/公告/规则），这些就是路由名
- 渲染失败/空白 → 看 console 是否 JS 报错，可能是 hash 路由需要具体路径

### Step 3: 找路由（页面切换）

优先级从高到低：

1. **Vue 站点**（最常见，美团）：
```js
document.querySelector('#app').__vue__.$router.options.routes
// 返回所有路由 path，如 /home, /newsList, /newsContent/:id
```
2. **React 站点**（小米属于此类，`__vue__` 为空）：
   直接下载 `main.*.chunk.js` 并正则 `path:"/[^"]+"` 提取路由。小米实测：
   `path:"/notice/detail/:id"`, `path:"/blogdetail/:id"` 等 25 条。
   ```js
   fetch('https://cdn.../static/js/main.e166478d.chunk.js').then(r=>r.text()).then(t=>{
     [...new Set(t.match(/path\s*:\s*["'][^"']+["']/g))];
   })
   ```
3. **hash 路由直接改 URL**：`https://target.com/#/notice`，SPA 自己切换，不需要真路由配置
4. 兜底：从导航菜单点击逐页试，导航后立刻查 performance

### Step 4: performance 面板找真实 API（万能钥匙）

在浏览器 console 执行（browser_console expression）：

```js
performance.getEntriesByType('resource')
  .filter(r => r.name.includes('/api/'))
  .map(r => r.name)
```

页面加载时前端调过的所有后端 API 都在这里，直接看到 API 路径和参数格式。
先导航到规则/公告页面再执行，确保目标 API 已被触发。

> 坑：按关键词过滤（announce/standard/content）不通用。小米的 API 叫 `/api/v1/posts` 和 `/api/v1/post`，
> 用 `includes('/api/')` 最稳，拿到后再看命名规律试详情接口（小米：列表是 `/posts`，详情是 `/post?id=`，易混）。

### Step 5: 浏览器上下文调 API（复用登录态）

直接 curl API 可能失败（无 cookie/风控拦截），在浏览器 console 里调最稳：

```js
new Promise(function(resolve) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/announce/list?typeId=0&curPage=1&perPage=50', true);
  xhr.withCredentials = true;
  xhr.onload = function() { resolve(xhr.status + '|' + xhr.responseText.substring(0, 8000)); };
  xhr.onerror = function() { resolve('error'); };
  xhr.send();
}).then(function(r){ return r; })
```

分支处理：
- **200** → 直接拿数据，注意看 code 字段（小米用 `code:0` 成功，美团用 `code:200`）
- **401** → 该接口需登录。先试其他公开接口（列表通常公开）；
  确实需要登录的（如美团的 /api/sign/standard），让用户在浏览器里登录后重试。
  小米全站公开，无需登录。
- **404** → 路径拼错。小米实测易错：`/api/v1/posts/238` 404，正确是 `/api/v1/post?id=238`（单复数+query 差异）
- **405** → 换请求方法：GET 换 POST（美团 detail 是 POST，小米是 GET）
- **参数名不对** → 看报错提示反推。美团返回"请传入公告ID"→ 把 `{id:312}` 换成 `{announceId:312}` 成功
- 列表 API 返回的每项通常带 `detail`/`content` 字段或单独的详情接口，用 announceId/newsId 取正文

### Step 6: 清洗富文本，输出纯文本

API 返回的正文是 HTML 富文本（带大量 style/data 属性），在 console 里去标签：

```js
var text = html.replace(/<[^>]+>/g, '\n')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\n{3,}/g, '\n\n').trim();
```

输出给用户时提炼：测试范围(域名/业务清单)、红线/禁止行为、奖励表、评级标准、
与用户当前挖掘方向相关的条款（如 AI 漏洞收录边界）。

## 常见厂商 SRC 域名速查

| 厂商 | 域名 | 形态 | 关键API | 状态 |
|------|------|------|---------|------|
| 美团 MTSRC | security.meituan.com | Vue SPA, hash路由 | /api/announce/list + POST /api/announce/detail (announceId) 公开; /api/sign/standard 需登录 | ✅验证 |
| 小米 MISRC | sec.xiaomi.com | React SPA, hash路由, 飞书富文本 | GET /api/v1/posts?pageNum=&pageSize= + GET /api/v1/post?id= 全公开无鉴权 | ✅验证 |
| 阿里 ASRC | security.alibaba.com | 未验证 | | |
| 腾讯 TSRC | src.qq.com | 未验证 | | |
| 字节 BSRC | src.bytedance.com | 未验证 | | |
| 京东 JSRC | security.jd.com | 未验证 | | |
| 360 | security.360.cn | 未验证 | | |
| 百度 BSRC | src.baidu.com | 未验证 | | |
| 快手 | security.kuaishou.com | 未验证 | | |
| B站 | security.bilibili.com | 未验证 | | |
| 网易 | src.163.com | 未验证 | | |
| 华为 PSIRT | psirt.huawei.com | 未验证 | | |
| 携程 CSRC | security.ctrip.com | 未验证 | | |
| 滴滴 DSRC | sec.didichuxing.com | 未验证 | | |
| 唯品会 VSRC | sec.vip.com | 未验证 | | |

未验证的域名先 curl 确认再进流程。抓到新厂商后**回填本表**（含形态/关键API路径/鉴权情况）。

## 坑与经验

1. **列表公开、详情不一定公开**：优先试列表和公告类接口。
2. **rich text 正文在 JSON 字段里**（detail/content/body），不在 API 顶层，看返回结构。
3. **有些规则是 PDF/图片附件**：API 只返回文件 URL，需要单独下载再提取（ocr-and-documents skill）。
4. **SPA 首次导航 API 未必全触发**：先点进目标页面（公告列表/规则页）再查 performance。
5. **登录墙**：让用户在受控浏览器里手动登录一次，之后的 XHR 全部带登录态。
   不要尝试绕过登录——规则页通常有公开镜像（公告/历史版本）。
6. **海外平台**（HackerOne/Bugcrowd/YesWeHack）不是 SPA+JSON API 模式，
   scope 在 program 页面/GraphQL API 里，方法不同，不要硬套本流程。
7. API 有分页时（curPage/perPage），把 perPage 调大一次拿全，避免翻页。

## 与其他 skill 的衔接

- 微信公众号漏洞方法论文章 → `wechat-mp-reader`（curl+UA 直接抓，非 SPA 流程）
- 拿到 SRC 测试范围后对目标域名做 JS 资产提取 → `js-recon-security`
- 涉及实际测试时遵守 pentest-redteam 的授权 Gate 和该厂商规则红线
