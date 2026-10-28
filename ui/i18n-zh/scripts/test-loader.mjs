#!/usr/bin/env node
/**
 * loader.ts 回归测试（零依赖，不需要 npm install）
 *
 * 用一个极简 DOM stub 验证替换引擎的核心行为：
 *   - 精确匹配文本节点
 *   - 首尾空白保留
 *   - JSX 插值拆碎的文案（Page {a} of {b}）整元素匹配
 *   - placeholder / title 等属性
 *   - pre / code 内部不翻译
 *   - 未命中词典的内容不误伤
 *
 * 用法：
 *   node ui/i18n-zh/scripts/test-loader.mjs
 *   （Node < 22.18 需加 --experimental-strip-types）
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = resolve(__dirname, "../..");
const LOADER = resolve(__dirname, "../loader.ts");
const DICT = resolve(__dirname, "../dict/zh-CN.json");

/* ---------- 1. 生成可被 Node 直接执行的 loader 副本（只替换 JSON 导入） ---------- */
const src = readFileSync(LOADER, "utf8");
const patched = src.replace(
	/import dictFile from "\.\/dict\/zh-CN\.json";/,
	`import { readFileSync } from "node:fs";\nconst dictFile = JSON.parse(readFileSync(${JSON.stringify(DICT)}, "utf8"));`,
);
if (patched === src) {
	console.error("!! 未能定位 loader.ts 的词典导入语句，测试中止");
	process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), "bifrost-zh-test-"));
const tmpLoader = join(dir, "loader.ts");
writeFileSync(tmpLoader, patched, "utf8");

/* ---------- 2. 极简 DOM stub ---------- */
class TNode {
	constructor(v) {
		this.nodeType = 3;
		this.nodeValue = v;
		this.parentElement = null;
	}
	get textContent() {
		return this.nodeValue;
	}
}
class ENode {
	constructor(tag) {
		this.nodeType = 1;
		this.tag = tag;
		this.childNodes = [];
		this.attrs = {};
		this.parentElement = null;
	}
	get children() {
		return this.childNodes.filter((c) => c.nodeType === 1);
	}
	get textContent() {
		return this.childNodes.map((c) => c.textContent).join("");
	}
	append(...ns) {
		for (const n of ns) {
			n.parentElement = this;
			this.childNodes.push(n);
		}
		return this;
	}
	matches(sel) {
		const byTag = ["pre", "code", "textarea", "script", "style", "noscript", "kbd", "samp"].includes(this.tag);
		const byAttr = this.attrs["data-i18n-zh"] !== undefined || this.attrs["contenteditable"] === "true";
		if (sel.includes("kbd")) return byTag || byAttr; // 完整的 SKIP_SELECTOR
		if (sel.includes("data-i18n-zh")) return this.attrs["data-i18n-zh"] !== undefined;
		return false;
	}
	closest(sel) {
		let n = this;
		while (n) {
			if (n.nodeType === 1 && n.matches(sel)) return n;
			n = n.parentElement;
		}
		return null;
	}
	getAttribute(k) {
		return this.attrs[k] ?? null;
	}
	setAttribute(k, v) {
		this.attrs[k] = v;
	}
}

const body = new ENode("body");
Object.assign(globalThis, {
	Node: { TEXT_NODE: 3, ELEMENT_NODE: 1, DOCUMENT_FRAGMENT_NODE: 11 },
	NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
	window: globalThis,
	localStorage: { getItem: () => null, setItem() {} },
	requestAnimationFrame: (fn) => setTimeout(fn, 0),
	MutationObserver: class {
		observe() {}
		disconnect() {}
	},
});
globalThis.document = {
	readyState: "complete",
	documentElement: { lang: "en" },
	body,
	addEventListener() {},
	createTreeWalker(root, mask, filter) {
		const accept = (n) => filter.acceptNode(n);
		function* gen(n) {
			for (const c of n.childNodes) {
				if (accept(c) === 2) continue;
				yield c;
				if (c.nodeType === 1) yield* gen(c);
			}
		}
		const it = gen(root);
		return {
			nextNode: () => {
				const r = it.next();
				return r.done ? null : r.value;
			},
		};
	},
};

/* ---------- 3. 测试用例 ---------- */
const wrap = (tag, ...kids) => new ENode(tag).append(...kids);
const exact = wrap("span", new TNode("Providers"));
const spaced = wrap("span", new TNode(" Dashboard "));
const split = wrap("p", new TNode("Page "), new TNode("3"), new TNode(" of "), new TNode("5"));
const input = new ENode("input");
input.attrs.placeholder = "Search virtual keys";
const code = wrap("pre", wrap("code", new TNode("Providers")));
const data = wrap("span", new TNode("openai/gpt-4o-mini"));
const withTitle = wrap("div", new TNode("x"));
withTitle.setAttribute("title", "Expand sidebar");
body.append(wrap("div", exact, spaced, split, input, code, data, withTitle));

await import(pathToFileURL(tmpLoader).href);

let failed = 0;
const check = (label, actual, expect) => {
	const ok = actual === expect;
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}  ->  ${JSON.stringify(actual)}${ok ? "" : `  (期望 ${JSON.stringify(expect)})`}`);
};

check("精确匹配文本节点", exact.textContent, "服务商");
check("保留首尾空白", spaced.textContent, " 仪表盘 ");
check("拆分插值整体匹配", split.textContent, "第 3 页 / 共 5 页");
check("多出的文本节点已清空", split.childNodes[1].nodeValue, "");
check("placeholder 属性", input.getAttribute("placeholder"), "搜索虚拟密钥");
check("title 属性", withTitle.getAttribute("title"), "展开侧边栏");
check("pre/code 内不翻译", code.textContent, "Providers");
check("未命中词典不误伤", data.textContent, "openai/gpt-4o-mini");
check("html lang 已设置", document.documentElement.lang, "zh-CN");

const stats = globalThis.window.__bifrostZh?.stats?.();
console.log("\n引擎统计:", JSON.stringify(stats));
console.log(failed === 0 ? "全部通过 ✅" : `${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
