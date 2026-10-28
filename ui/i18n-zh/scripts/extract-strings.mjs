#!/usr/bin/env node
/**
 * Bifrost UI 文案提取器（零依赖）
 *
 * 用途：
 *   1. 从 ui/ 源码中提取所有“用户可见的英文文案”候选
 *   2. 与 zh-CN.json 词典做差集，找出尚未翻译的文案
 *      —— 上游更新后跑一次，就知道新增了哪些待翻译文案
 *
 * 用法：
 *   node ui/i18n-zh/scripts/extract-strings.mjs              # 打印缺失文案（按出现次数排序）
 *   node ui/i18n-zh/scripts/extract-strings.mjs --all        # 打印全部候选文案
 *   node ui/i18n-zh/scripts/extract-strings.mjs --json       # 输出 JSON（机器可读）
 *   node ui/i18n-zh/scripts/extract-strings.mjs --todo       # 写入 ui/i18n-zh/TODO.md
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, "../..");
const DICT_PATH = resolve(__dirname, "../dict/zh-CN.json");
const TODO_PATH = resolve(__dirname, "../TODO.md");

const SKIP_DIRS = new Set(["node_modules", "out", "dist", ".git", "i18n-zh", "public"]);
const EXTS = [".tsx", ".ts"];

/** 只作为“属性值”提取的白名单：这些位置一定是 UI 文案 */
const ATTR_PROPS = [
	"title",
	"label",
	"description",
	"placeholder",
	"aria-label",
	"alt",
	"tooltip",
	"helperText",
	"emptyMessage",
	"confirmText",
	"cancelText",
	"header",
];

/** TS 关键字 / 代码噪声，不当作文案 */
const CODE_NOISE = new Set([
	"Promise",
	"Record",
	"Set",
	"Map",
	"Array",
	"string",
	"number",
	"boolean",
	"void",
	"any",
	"unknown",
	"null",
	"undefined",
	"object",
	"Partial",
	"Required",
	"Readonly",
	"Record<string",
	"Bifrost",
]);

const isLikelyUiText = (s) => {
	if (typeof s !== "string") return false;
	const t = s.trim();
	if (t.length < 2 || t.length > 120) return false;
	if (CODE_NOISE.has(t)) return false;
	if (!/[A-Za-z]/.test(t)) return false; // 必须含字母
	// 代码片段特征
	if (/[(){}\[\]<>=|&;]|=>|\.\.\.|::|^\*|\*$/.test(t)) return false;
	if (/^(https?:|\/|\.\/|data:|#)/.test(t)) return false; // URL / 路径 / 锚点
	if (/\benv\.[A-Z0-9_]+/.test(t)) return false; // 输入框示例：us-east-1 or env.AWS_REGION
	if (/x{4,}/.test(t)) return false; // 占位示例：proj_xxxxxxxx
	if (/^(new Set|new Map|, |\.\.\.)/.test(t)) return false; // 代码噪声
	if (/VariantProps|Props$/.test(t)) return false;
	if (/^[A-Z_]+$/.test(t) && t.length <= 4) return false; // 常量缩写：ID / API / URL
	if (/^[a-z]/.test(t) && !/\s/.test(t)) return false; // 小写单词=变量名/值
	if (/\b(fn|const|return|import|export|className|props|useState)\b/.test(t)) return false;
	if (t.split(/\s+/).length === 1 && !/^[A-Z][A-Za-z-]*$/.test(t)) return false;
	return true;
};

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (!SKIP_DIRS.has(name)) walk(p, out);
		} else if (EXTS.some((e) => name.endsWith(e)) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) {
			out.push(p);
		}
	}
	return out;
}

/** 提取属性白名单里的字面量：title: "X" / placeholder="X" / label={"X"} */
const ATTR_RE = new RegExp(
	`(?:^|[\\s{,(])(?:${ATTR_PROPS.map((p) => p.replace("-", "\\-")).join("|")})\\s*[:=]\\s*(?:"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|\\{\\s*"([^"]*)"\\s*\\})`,
	"g",
);

/** 提取 JSX 文本节点：>文案<（同行闭合，排除含代码符号的行内表达式） */
const JSX_LINE_RE = />([^<>{}\n]{2,120}?)</g;

const hits = new Map(); // text -> count
const files = walk(UI_ROOT);

for (const file of files) {
	const src = readFileSync(file, "utf8");
	const rel = relative(UI_ROOT, file).replace(/\\/g, "/");
	const record = (text, line) => {
		if (!isLikelyUiText(text)) return;
		const key = text.trim();
		if (!hits.has(key)) hits.set(key, { count: 0, files: new Map() });
		const e = hits.get(key);
		e.count++;
		e.files.set(rel, line);
	};

	// 1) 属性白名单
	for (const m of src.matchAll(ATTR_RE)) {
		const text = m[1] ?? m[2] ?? m[3];
		if (text) record(text, lineOf(src, m.index));
	}

	// 2) JSX 文本（逐行，避免跨行噪声）
	const lines = src.split("\n");
	lines.forEach((line, i) => {
		if (line.includes("//") && !line.includes("http")) return; // 跳过注释行
		for (const m of line.matchAll(JSX_LINE_RE)) {
			const text = m[1];
			if (text.includes("=") || text.includes("&&")) continue;
			record(text, i + 1);
		}
	});
}

function lineOf(src, idx) {
	let n = 1;
	for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
	return n;
}

const dict = JSON.parse(readFileSync(DICT_PATH, "utf8"));
const translated = new Set(Object.keys(dict.strings ?? {}));
const sorted = [...hits.entries()].sort((a, b) => b[1].count - a[1].count);
const missing = sorted.filter(([k]) => !translated.has(k));

const args = new Set(process.argv.slice(2));

if (args.has("--json")) {
	console.log(
		JSON.stringify(
			{
				total: sorted.length,
				translated: sorted.length - missing.length,
				missing: missing.map(([text, meta]) => ({
					text,
					count: meta.count,
					where: [...meta.files.entries()].slice(0, 3).map(([f, l]) => `${f}:${l}`),
				})),
			},
			null,
			"\t",
		),
	);
	process.exit(0);
}

if (args.has("--todo")) {
	const lines = [
		"# 待翻译文案（自动生成）",
		"",
		`- 候选文案总数：**${sorted.length}**`,
		`- 已翻译：**${sorted.length - missing.length}**`,
		`- 待翻译：**${missing.length}**`,
		"",
		"> 把英文原文作为 key，中文译文作为 value 加入 `dict/zh-CN.json` 的 `strings` 字段即可。",
		"",
		"| 出现次数 | 英文原文 | 位置 |",
		"| --- | --- | --- |",
		...missing.map(([text, meta]) => {
			const where = [...meta.files.keys()].slice(0, 2).join("<br>");
			return `| ${meta.count} | \`${text.replace(/\|/g, "\\|")}\` | ${where} |`;
		}),
		"",
	];
	writeFileSync(TODO_PATH, lines.join("\n"), "utf8");
	console.log(`已写入 ${relative(process.cwd(), TODO_PATH)}（待翻译 ${missing.length} 条）`);
	process.exit(0);
}

const list = args.has("--all") ? sorted : missing;
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) || 200 : 200;
console.log(`候选文案 ${sorted.length} 条，已翻译 ${sorted.length - missing.length} 条，待翻译 ${missing.length} 条\n`);
for (const [text, meta] of list.slice(0, limit)) {
	console.log(`${String(meta.count).padStart(4)}  ${text}`);
}
if (list.length > limit) console.log(`\n…… 共 ${list.length} 条，仅显示前 ${limit} 条（--limit=N 调整）`);
