/**
 * Bifrost 中文语言包 —— 运行时外挂引擎
 * ---------------------------------------------------------------------------
 * 设计目标：**零侵入**。
 *   - 不 import / 不修改任何上游组件与逻辑，只在渲染完成后把界面上的英文文案
 *     按词典替换成中文；
 *   - 上游组件怎么重构都不影响本文件（它只认「屏幕上出现的文字」）；
 *   - 上游更新时，只有新出现的文案需要补词典，绝不会产生 merge 冲突。
 *
 * 工作原理：
 *   1. 首屏：DOMContentLoaded 后遍历一次 body，替换文本节点与白名单属性；
 *   2. 之后：MutationObserver 监听新增节点 / 文本变化（React 重渲染、弹窗、toast、
 *      动态加载的页面），命中词典就替换。
 *
 * 词典：./dict/zh-CN.json
 *   strings  —— 精确匹配（英文原文 → 中文），最常用
 *   patterns —— 正则匹配，用于带变量/数字的文案，如 "Showing 1-20 of 300"
 *
 * 开关：localStorage["bifrost:lang"] = "en" 可临时关掉中文（刷新生效）；
 *       控制台里 window.__bifrostZh.disable() / enable() 也可切换。
 */

import dictFile from "./dict/zh-CN.json";

type Dictionary = {
	meta?: { locale?: string; upstream?: string; updated?: string };
	strings?: Record<string, string>;
	patterns?: { re: string; to: string; flags?: string }[];
};

const dict = dictFile as unknown as Dictionary;

/** 需要翻译的属性（其余属性一律不动，避免破坏 aria/逻辑） */
const ATTR_NAMES = ["placeholder", "title", "aria-label", "alt"] as const;

/** 这些元素内部的文字不翻译（代码、脚本、样式、用户输入区） */
const SKIP_SELECTOR = [
	"script",
	"style",
	"noscript",
	"pre",
	"code",
	"kbd",
	"samp",
	"textarea",
	"[data-i18n-zh='off']",
	"[contenteditable='true']",
].join(",");

const strings: Record<string, string> = dict.strings ?? {};
const patterns: { re: RegExp; to: string }[] = (dict.patterns ?? []).map((p) => ({
	re: new RegExp(p.re, p.flags ?? ""),
	to: p.to,
}));

const STORAGE_KEY = "bifrost:lang";
let enabled = true;
let observer: MutationObserver | null = null;
let scheduled = false;
let translatedCount = 0;

/** 统一的查表：先精确匹配，再走正则规则 */
function translate(raw: string): string | undefined {
	if (!raw) return undefined;
	// 保留首尾空白，避免破坏 inline 布局
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
	const lead = m?.[1] ?? "";
	const core = m?.[2] ?? "";
	const tail = m?.[3] ?? "";
	if (!core) return undefined;

	const exact = strings[core];
	if (exact !== undefined) return lead + exact + tail;

	for (const p of patterns) {
		if (p.re.test(core)) {
			p.re.lastIndex = 0;
			return lead + core.replace(p.re, p.to) + tail;
		}
	}
	return undefined;
}

function shouldSkip(node: Node): boolean {
	const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
	if (!el) return true;
	return !!el.closest(SKIP_SELECTOR);
}

function translateTextNode(node: Text): void {
	const value = node.nodeValue;
	if (!value) return;
	const zh = translate(value);
	if (zh === undefined || zh === value) return;
	node.nodeValue = zh;
	translatedCount++;
}

function translateAttributes(el: Element): void {
	for (const name of ATTR_NAMES) {
		const value = el.getAttribute(name);
		if (!value) continue;
		const zh = translate(value);
		if (zh !== undefined && zh !== value) el.setAttribute(name, zh);
	}
}

/**
 * 整元素匹配：处理被 JSX 插值拆碎成多个文本节点的文案，
 * 例如 <span>Page {n} of {total}</span> 会生成 "Page " / "3" / " of " / "5" 四个节点，
 * 单节点匹配永远失败。这里只在「元素的所有子节点都是文本节点」时才动手，
 * 把译文写进第一个文本节点、其余清空 —— 节点本身保留，React 后续更新不会报错。
 */
function translateElementByPattern(el: Element): void {
	const children = el.childNodes;
	if (children.length === 0 || children.length > 8) return;
	for (const child of Array.from(children)) {
		if (child.nodeType !== Node.TEXT_NODE) return; // 含元素子节点，放弃
	}
	const full = el.textContent ?? "";
	const core = full.trim();
	if (!core || core.length > 160) return;

	for (const p of patterns) {
		if (!p.re.test(core)) continue;
		p.re.lastIndex = 0;
		const zh = core.replace(p.re, p.to);
		if (zh === core) continue;
		const lead = full.slice(0, full.indexOf(core));
		const tail = full.slice(full.indexOf(core) + core.length);
		const first = children[0] as Text;
		if (first.nodeValue === lead + zh + tail) return;
		first.nodeValue = lead + zh + tail;
		for (let i = 1; i < children.length; i++) (children[i] as Text).nodeValue = "";
		translatedCount++;
		return;
	}
}

function walk(root: Node): void {
	if (root.nodeType === Node.TEXT_NODE) {
		if (!shouldSkip(root)) translateTextNode(root as Text);
		return;
	}
	if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
	if (root.nodeType === Node.ELEMENT_NODE) {
		const el = root as Element;
		if (el.matches(SKIP_SELECTOR)) return;
		translateAttributes(el);
		if (patterns.length > 0 && el.childNodes.length > 1) translateElementByPattern(el);
	}
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
		acceptNode(n) {
			if (n.nodeType === Node.ELEMENT_NODE) {
				return (n as Element).matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let current = walker.nextNode();
	while (current) {
		if (current.nodeType === Node.TEXT_NODE) translateTextNode(current as Text);
		else {
			const el = current as Element;
			translateAttributes(el);
			if (patterns.length > 0 && el.childNodes.length > 1) translateElementByPattern(el);
		}
		current = walker.nextNode();
	}
}

/** 合并同一帧内的多次 DOM 变化，避免重复遍历 */
function scheduleFullPass(): void {
	if (scheduled) return;
	scheduled = true;
	requestAnimationFrame(() => {
		scheduled = false;
		walk(document.body);
	});
}

function onMutations(records: MutationRecord[]): void {
	for (const record of records) {
		if (record.type === "attributes") {
			translateAttributes(record.target as Element);
			continue;
		}
		if (record.type === "characterData") {
			const target = record.target as Text;
			if (!shouldSkip(target)) translateTextNode(target);
			continue;
		}
		for (const added of Array.from(record.addedNodes)) {
			if (added.nodeType === Node.TEXT_NODE || added.nodeType === Node.ELEMENT_NODE) walk(added);
		}
		for (const el of Array.from((record.target as Element).children ?? [])) {
			if (el.nodeType === Node.ELEMENT_NODE) translateAttributes(el);
		}
	}
}

function start(): void {
	if (observer) return;
	walk(document.body);
	observer = new MutationObserver(onMutations);
	observer.observe(document.body, {
		childList: true,
		subtree: true,
		characterData: true,
		// React 重渲染时可能把 placeholder / title 重置回英文，这里一并跟进
		attributes: true,
		attributeFilter: [...ATTR_NAMES],
	});
	// 兜底：首屏 skeleton / 懒加载路由可能在首帧之后才渲染
	setTimeout(scheduleFullPass, 300);
	setTimeout(scheduleFullPass, 1500);
	document.documentElement.lang = "zh-CN";
}

function stop(): void {
	observer?.disconnect();
	observer = null;
	document.documentElement.lang = "en";
}

function boot(): void {
	try {
		enabled = localStorage.getItem(STORAGE_KEY) !== "en";
	} catch {
		enabled = true;
	}
	if (!enabled) return;
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start, { once: true });
	} else {
		start();
	}
}

boot();

declare global {
	interface Window {
		__bifrostZh?: {
			enable: () => void;
			disable: () => void;
			apply: () => void;
			stats: () => { entries: number; patterns: number; translated: number; enabled: boolean };
		};
	}
}

window.__bifrostZh = {
	enable() {
		try {
			localStorage.setItem(STORAGE_KEY, "zh-CN");
		} catch {
			/* ignore */
		}
		enabled = true;
		start();
	},
	disable() {
		try {
			localStorage.setItem(STORAGE_KEY, "en");
		} catch {
			/* ignore */
		}
		enabled = false;
		stop();
		location.reload();
	},
	apply: scheduleFullPass,
	stats: () => ({
		entries: Object.keys(strings).length,
		patterns: patterns.length,
		translated: translatedCount,
		enabled,
	}),
};
