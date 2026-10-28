# Bifrost 简体中文语言包（外挂式）

给 [maximhq/bifrost](https://github.com/maximhq/bifrost) 的 Web 控制台加中文界面，**不改任何上游组件代码**。

> **仓库地址**：<https://github.com/sagezhj/bifrost>（fork 自 maximhq/bifrost，汉化在 `zh-cn` 分支）
> **远程布局**：`upstream` → maximhq/bifrost（拉更新）、`fork` → sagezhj/bifrost（推汉化）

---

## 为什么这么做

上游 UI 没有 i18n 框架，800+ 个 `.tsx` 里的文案全部硬编码。直接改源码做汉化，等于把整棵树重写一遍，**上游每次更新都会大面积冲突**，最后只能放弃同步。

所以这里用外挂方案：

```
上游源码（一个字节都不改）
        │
        ├── ui/i18n-zh/loader.ts      ← 运行时遍历 DOM，把屏幕上的英文按词典换成中文
        ├── ui/i18n-zh/dict/zh-CN.json ← 词典（唯一需要持续维护的文件）
        └── ui/i18n-zh/vite-plugin-zh.ts ← 把上面的 loader 注入 index.html
                │
        ui/vite.config.mts 里只多两行（import + 调用）
```

上游更新时：**只有 `vite.config.mts` 那两行可能冲突**（位置在 plugins 数组里，冲突一眼可解），词典是纯新增文件，永远不会冲突。新增的英文文案只是"没被翻译"，界面照常工作。

---

## 工作原理

`loader.ts` 在 React 渲染前后做三件事：

1. **首屏**：`DOMContentLoaded` 后遍历 `document.body`，替换文本节点与白名单属性（`placeholder` / `title` / `aria-label` / `alt`）；
2. **增量**：`MutationObserver` 监听新增节点与文本变化 —— React 重渲染、路由切换、弹窗、toast 都会被覆盖；
3. **兜底**：首屏后 300ms / 1500ms 各补扫一次，应对懒加载。

匹配规则：

- `strings`：**精确匹配**整段文本（区分大小写），如 `"Providers": "服务商"`；
- `patterns`：正则匹配带变量的文案，如 `Page 3 of 12` → `第 3 页 / 共 12 页`。

安全边界：`script` / `style` / `pre` / `code` / `textarea` / `contenteditable` 内部一律不动；只替换**精确命中词典**的文本，所以模型名、服务商名、日志原文等动态内容不会被误伤。

---

## 使用

编译进镜像（推荐）：

```bash
cd ui
npm install
npm run build          # 产物输出到 out/ 并复制到 transports/bifrost-http/ui
```

只想起本地看效果：

```bash
cd ui && npm install && npm run dev    # http://localhost:3000
```

**构建英文原版**（临时对比 / 排查问题）：

```bash
BIFROST_ZH=0 npm run build
```

**运行时切换**：控制台执行 `window.__bifrostZh.disable()` 会记住偏好并刷新回英文；`window.__bifrostZh.enable()` 切回中文；`window.__bifrostZh.stats()` 看当前词条数与已替换节点数。

---

## 维护词典

打开 `dict/zh-CN.json`，往 `strings` 里加一条即可，key 必须与界面上出现的英文**完全一致**（含大小写与标点）：

```json
"Virtual Keys": "虚拟密钥"
```

带变量、数字的文案用 `patterns`：

```json
{ "re": "^Showing (\\d+)-(\\d+) of ([\\d,]+)$", "to": "显示第 $1-$2 条 / 共 $3 条" }
```

### 找漏翻的地方

```bash
# 列出还没翻译的文案（按出现频次排序）
node ui/i18n-zh/scripts/extract-strings.mjs

# 看全部候选文案
node ui/i18n-zh/scripts/extract-strings.mjs --all --limit=500

# 生成待办清单 TODO.md（含每条文案出现的文件位置）
node ui/i18n-zh/scripts/extract-strings.mjs --todo
```

当前进度：候选 2433 条，已覆盖 621 条（高频文案基本覆盖，剩余以长尾短语为主）。

### 改完词典后跑一下回归测试

```bash
node ui/i18n-zh/scripts/test-loader.mjs
```

不需要 `npm install`，自带极简 DOM stub，验证精确匹配、属性替换、插值拆分、跳过 code/pre 等核心行为。

### 术语表（保持全站一致）

| English | 中文 |
| --- | --- |
| Provider | 服务商 |
| Virtual Key | 虚拟密钥 |
| Guardrail | 护栏 |
| Relay | 中继 |
| Agent | 智能体 |
| Skill | 技能 |
| Incident | 事件 |
| Budget | 预算 |
| Tokens | Token（不译） |
| MCP / Warp | 保留英文 |

---

## 同步上游更新

```bash
# 首次：把上游加为远程
git remote add upstream https://github.com/maximhq/bifrost.git

# 每次上游更新
git fetch upstream dev
git checkout zh-cn
git merge upstream/dev          # 冲突只会在 ui/vite.config.mts 的 plugins 那两行

# 复查新增文案（上游新功能带来的英文）
node ui/i18n-zh/scripts/extract-strings.mjs --limit=100
```

也可直接跑封装脚本，把上面三步一次做完：

```bash
bash ui/i18n-zh/scripts/sync-upstream.sh
```

---

## 已知限制

| 限制 | 说明 | 缓解 |
| --- | --- | --- |
| 首屏可能闪一下英文 | 替换发生在渲染之后 | 300ms 补扫；介意可加首屏遮罩（未默认开启，避免白屏风险） |
| Canvas / 图表内文字 | 图表库把文字画在 canvas 上，DOM 遍历碰不到 | 需改图表配置，暂不处理 |
| 被拆碎的插值文案 | `<span>Page {a} of {b}</span>` 会拆成多个文本节点 | 已实现「整元素匹配」处理，但复杂嵌套仍可能漏 |
| 与词典同名的用户数据 | 例如客户名恰好叫 `Global` 会被译成「全局」 | 概率极低；可按页面加 `[data-i18n-zh='off']` 排除 |

---

## 目录结构

```
ui/i18n-zh/
├── loader.ts                 # 运行时替换引擎（约 250 行）
├── vite-plugin-zh.ts         # 注入 loader 到 index.html
├── dict/zh-CN.json           # 词典（唯一日常维护文件）
├── scripts/extract-strings.mjs # 文案提取 / 覆盖率检查
├── TODO.md                   # 自动生成的待翻译清单
└── README.md
```
