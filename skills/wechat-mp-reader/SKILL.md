---
name: wechat-mp-reader
description: Read and extract content from WeChat public account (微信公众号) articles. Handles anti-scraping with proper User-Agent and extracts full article text.
version: 1.0.0
tags: [wechat, web, scraping, chinese]
---

# 微信公众号文章读取

使用 `curl` + 浏览器 UA 即可绕开微信的反爬，正文是服务端渲染在 `id="js_content"` 里的，不需要 headless 浏览器。

## 使用方法

把文章链接替换到下面的 one-liner 中执行：

```bash
curl -sL --max-time 15 \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" \
  "ARTICLE_URL" | python3 -c "
import sys, re, html
content = sys.stdin.read()

# Title
title = ''
for pat in [r'var msg_title = \"(.*?)\"', r'<meta property=\"og:title\" content=\"(.*?)\"', r'<title>(.*?)</title>']:
    m = re.search(pat, content, re.DOTALL)
    if m:
        title = html.unescape(m.group(1).replace('\\\\n','').strip())
        if title: break

# Author
author = ''
for pat in [r'var nickname = \"(.*?)\"', r'<meta property=\"og:article:author\" content=\"(.*?)\"']:
    m = re.search(pat, content)
    if m:
        author = html.unescape(m.group(1))
        if author: break

# Body from js_content div
m = re.search(r'id=\"js_content\"[^>]*>(.*?)</div>\s*<script[^>]*nonce=', content, re.DOTALL)
if m:
    raw = m.group(1)
    clean = re.sub(r'<[^>]+>', '', raw)
    clean = re.sub(r'&nbsp;', ' ', clean)
    clean = html.unescape(clean)
    clean = re.sub(r' {2,}', ' ', clean)
    clean = re.sub(r'\n{3,}', '\n\n', clean)
    body = clean.strip()

print(f'公众号: {author}')
print(f'标题: {title}')
print(f'正文长度: {len(body)} 字')
print()
print(body)
"
```

## 原理

1. **反爬绕过：** 微信只检查 `User-Agent` 请求头，换正常浏览器 UA 即可。不需要 headless 浏览器、不需要 cookie、不需要验证码。
2. **内容提取：** 微信公众号文章是服务端渲染的，正文完整嵌入在 `<div id="js_content">...</div>` 中，正则去掉 HTML 标签即可得到纯文本。
3. **元信息：** 标题和作者在 JS 变量 `msg_title` / `nickname` 或 `<meta>` 标签中。

## 注意事项

- 部分文章可能包含图片，本方法只能提取文字
- 如果文章过长超出终端缓冲区，可增加 Python 中 `body[:N]` 的截断
- 微信偶尔调整页面结构，如果提取失败，检查 `js_content` 是否改名
