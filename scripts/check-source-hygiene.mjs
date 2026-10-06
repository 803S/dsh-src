// 仅检查受Git跟踪的源码；不扫描依赖或运行产物，不把疑似凭据值打印进CI日志。
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';

export function sourceHygieneIssues(text) {
  const rules = [
    ['私网地址', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g],
    ['疑似凭据', /(?:sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{30,}|xox[bp]-[a-zA-Z0-9-]{10,})/g],
    ['配置凭据', /["']?\b(?:fofaKey(?:Backup\d*)?|apiKey|api_key|accessToken|access_token|clientSecret|client_secret)["']?\s*[:=]\s*(?:["']([a-zA-Z0-9._-]{20,})["']|([a-fA-F0-9]{24,})\b)/g],
  ];
  return rules.flatMap(([kind, pattern]) => [...text.matchAll(pattern)]
    .filter(match => kind !== '配置凭据' || !/^(?:YOUR_|EXAMPLE_|PLACEHOLDER_|fixture-)/i.test(match[1] ?? match[2]))
    .map(match => ({kind, line: text.slice(0, match.index).split('\n').length})));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
  let failures = 0;
  for (const file of files.filter(file => /\.(?:md|mjs|cjs|js|ts|tsx|py|yml|yaml|json)$/.test(extname(file)))) {
    for (const issue of sourceHygieneIssues(readFileSync(file, 'utf8'))) {
      console.error(`${file}:${issue.line}：${issue.kind}（值不输出）`); failures++;
    }
  }
  if (failures) process.exitCode = 1;
  else console.log('源码卫生检查通过：未命中已配置的私网地址和凭据规则。');
}
