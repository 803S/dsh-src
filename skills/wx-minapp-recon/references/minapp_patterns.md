# 微信小程序敏感信息模式参考

## 1. 小程序配置文件 (app.json)

| 字段 | 安全风险 | 说明 |
|------|---------|------|
| `pages[]` | 信息泄露 | 暴露全部页面路径，包含 admin/debug 等隐藏页面 |
| `tabBar` | 信息泄露 | 暴露主要功能入口 |
| `plugins` | 供应链风险 | 暴露使用了哪些第三方插件 |
| `permission` | 信息泄露 | 暴露 scope 权限声明 |
| `networkTimeout` | 配置泄露 | 暴露网络超时配置 |

## 2. 云开发 (微信云开发 TCB)

| 模式 | 示例 | 风险 |
|------|------|------|
| `wx.cloud.init({env: "xxx"})` | `env: "prod-123abc"` | 暴露云环境 ID |
| `cloud.callFunction({name: "xxx"})` | `name: "login"` | 暴露云函数名称 |
| `wx.cloud.database()` | 直接调用 | 可能未做权限校验 |
| `env: process.env.xxx` | 环境变量引用 | 可能暴露配置 |

## 3. 微信 API 调用

| API | 风险 |
|-----|------|
| `wx.request({url: "..."})` | 暴露后端 API 地址 |
| `wx.uploadFile({url: "..."})` | 暴露上传接口地址 |
| `wx.downloadFile({url: "..."})` | 暴露下载接口地址 |
| `wx.connectSocket({url: "..."})` | 暴露 WebSocket 地址 |

## 4. 常见敏感配置模式

```
// appid/secret 直接硬编码
"appid": "wx1234567890abcdef"
"appSecret": "abc123def456..."
"AppSecret": "xxxxx"

// 第三方服务密钥
"amap_key": "xxxxx"      // 高德地图
"tencent_map_key": "xxxx" // 腾讯地图
"bd_map_key": "xxxx"     // 百度地图
"sentry_dsn": "xxxx"     // Sentry 错误监控
"umeng_appkey": "xxxx"   // 友盟
"jpush_appkey": "xxxx"   // 极光推送
```

## 5. 小程序包路径

| 微信版本 | 默认路径 |
|---------|---------|
| 新版 (xwechat) | `%APPDATA%\Tencent\xwechat\radium\Applet\packages` |
| 旧版 (WeChat Files) | `%USERPROFILE%\Documents\WeChat Files\Applet` |

## 6. 分包结构

```
__APP__.wxapkg       # 主包（核心逻辑）
__sub_<name>.wxapkg   # 分包（按功能拆分，延迟加载）
```

## 7. 反编译产物结构

```
output/
├── app.json              # 全局配置
├── app.js                # 全局逻辑
├── app.wxss              # 全局样式
├── pages/                # 页面
│   └── index/
│       ├── index.js
│       ├── index.wxml
│       ├── index.wxss
│       └── index.json
├── components/           # 公共组件
├── project.config.json   # 项目配置
└── sitemap.json          # 搜索配置
```

## 8. 通用 JS 敏感信息模式

详见同级目录 `js-recon-security` skill 的 `references/patterns.md`，包括：
- 邮箱、手机号、IP、身份证
- 云平台 AccessKey（阿里云/AWS/腾讯云/谷歌云等）
- JWT/Bearer/GitHub/GitLab Token
- PEM 私钥
- Webhook（Slack/飞书/钉钉/企业微信）
- Grafana Token
