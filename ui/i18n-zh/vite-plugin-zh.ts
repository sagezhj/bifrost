/**
 * Bifrost 中文语言包 —— Vite 插件
 * ---------------------------------------------------------------------------
 * 唯一作用：把运行时引擎注入到 index.html，并把 <html lang> 改成 zh-CN。
 * 不参与任何业务编译逻辑，不修改上游组件。
 *
 * 关闭方式：
 *   BIFROST_ZH=0 npm run build    # 构建一个纯英文版本
 */

import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export interface ZhI18nOptions {
	/** 是否启用中文替换，默认 true；也可用环境变量 BIFROST_ZH=0 关闭 */
	enabled?: boolean;
}

export function zhI18n(options: ZhI18nOptions = {}): Plugin {
	const enabled = options.enabled ?? process.env.BIFROST_ZH !== "0";
	let root = "";

	return {
		name: "bifrost-zh-cn",
		// 提前于 Vite 内置 html 插件运行，确保注入的 module script 进入构建图
		enforce: "pre",

		configResolved(config) {
			root = config.root;
			if (!enabled) {
				this.info?.("[zh-CN] 已禁用（BIFROST_ZH=0），构建英文原文版本");
				return;
			}
			const dictPath = path.join(root, "i18n-zh", "dict", "zh-CN.json");
			try {
				const dict = JSON.parse(fs.readFileSync(dictPath, "utf8")) as {
					strings?: Record<string, string>;
					patterns?: unknown[];
				};
				const entries = Object.keys(dict.strings ?? {}).length;
				const rules = (dict.patterns ?? []).length;
				this.info?.(`[zh-CN] 词典已加载：${entries} 条精确词条 + ${rules} 条正则规则`);
			} catch (err) {
				this.warn?.(`[zh-CN] 词典读取失败：${(err as Error).message}`);
			}
		},

		transformIndexHtml: {
			order: "pre",
			handler(html) {
				if (!enabled) return html;
				return {
					html: html.replace(/<html\s+lang="en"/, '<html lang="zh-CN"'),
					tags: [
						{
							tag: "script",
							attrs: { type: "module", src: "/i18n-zh/loader.ts" },
							injectTo: "head-prepend",
						},
					],
				};
			},
		},
	};
}

export default zhI18n;
