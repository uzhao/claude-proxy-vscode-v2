# Prompt 缓存命中率调查：AMD 端点 10.5% 的根因与各 Provider 行为差异

日期：2026-09-01

## 0. 结论摘要

- 通过本代理请求 **AMD**（`developer.amd.com.cn/radeon/api`，走 Chat Completions 转换）时，token 层面缓存命中率实测 **10.5%**（总 cached 470,784 / 总 prompt 4,465,554）。
- **根因**：Claude Code 客户端请求中，稳定可缓存的前缀只有约 **7500 token**（billing + 「You are Claude Code…」+ CLAUDE.md 主体）；紧跟其后的每轮动态注入（git status / `<total_tokens>` / `changed on disk`）每轮都在变。AMD 做的是**严格连续前缀树**，在第一个动态点失配，导致其后约 90% 的输入（含全部历史对话）无法命中。
- 命中率低主要来自**结构性约束**（客户端稳定前缀短 + 动态注入挡路），而非代理转换破坏前缀；但代理侧确有两点已确认的缺陷（见 §4）。

---

## 1. 背景

- Claude Code 客户端通过本代理把 `/v1/messages` 请求转换转发到各 provider。
- 用户观察到：**openai 官网缓存命中率约 90%，而 amd 极低**，需要定位原因。
- 调查手段：解析 `/tmp/claude-proxy-logs` 的请求日志 + 直接 curl 各端点对照流式/非流式行为。

---

## 2. AMD 端点实测数据

来源：同一个 session `57c65508` 的 57 个连续请求（另有 1 个独立 session），从上游流式响应的 `usage.prompt_tokens_details.cached_tokens` 提取。

| 指标 | 值 |
|---|---|
| 请求数（有 usage） | 58 |
| 总 prompt_tokens | 4,465,554 |
| 总 cached_tokens | 470,784 |
| **token 层面命中率** | **10.5%** |
| 有命中的请求 | 46 / 58（约 79%） |
| 命中率分布 | 全部落在 10%~12%，无一个超过 30% |

关键走势（cached 恒定，prompt 持续增长）：

```
pt=60592  ct=0      rate=0.0%     （首个请求，无缓存）
pt=62300  ct=6656   rate=10.7%
pt=64678  ct=7936   rate=12.1%
pt=68530  ct=7936   rate=11.6%
...
pt=96345  ct=7936   rate≈8%       （cached 恒定 ~7500，prompt 一路涨，命中率持续下滑）
```

**cached_tokens 恒定在 6656~7936 之间**，不随 prompt_tokens 增长——说明每次只命中「开头固定的一小段」，其余全部失配。

旁的佐证：
- `cost_details.cached_input_cost` 在 40/51 个请求里非 0（命中有成本折扣，命中是真实的）。
- `prompt_tokens_details.cache_write_tokens` 恒 0（AMD 不在此字段回报写入，不作为主要结论依据）。

---

## 3. 根因分析

### 3.1 Claude Code 客户端请求结构

以相邻两个请求做完整 diff 得到（session `57c65508`）：

- 客户端用 4 处 `cache_control` 断点：顶层 `system[1]`、`system[2]`、`messages[45]`、`messages[47]`（断点每轮前移）。
- 顶层 `system[2]`（约 11797 字符）带 `cache_control`，但**尾部约 380 字符是 git status + Recent commits**（`M docs/...`、`?? ...`），这串每轮随工作区变化。
- messages 里散落三类每轮注入的动态内容：
  1. `<total_tokens>N tokens left</total_tokens>`（每轮新增一条，`N` 随消耗递减）。
  2. `Note: ... changed on disk since ...`（IDE 磁盘变更提示）。
  3. `[Request interrupted by user for tool use]` 这类临时标记——在本轮存在，**下一轮被客户端清理**（历史消息存在一轮性的「归一化」改写）。

结论：客户端请求的**稳定前缀只有开头的 ~7500 token**，之后的动态注入把「稳定段」和「历史对话」隔开。

### 3.2 代理转换的影响（非根因，但有影响）

- `collectSystem`（`src/translate/openai/request.ts`）把所有 `role: system` 消息抽出来前置合并成一条 `messages[0]`。它**保序**（稳定的 billing/定义/CLAUDE.md 仍排在最前），所以稳定前缀依然在最前面，不是命中率低的主因。
- 转换时**丢弃了 cache_control**（进 4 出 0）。AMD 是自动前缀缓存、不看 cache_control，所以此条对 AMD 影响有限；但丢失了「稳定段 / 动态段」的分段信号。

### 3.3 AMD 端点的匹配方式

AMD 的流式响应默认就返回 usage + `cached_tokens`（无需 `stream_options`），做**连续前缀缓存**。命中路径：

```
[stable ~7500 token][git status / token计数 / changed-on-disk（每轮变）][历史对话…]
        命中 ✓               ✗ 失配 → 之后全部失配
```

前缀树从开头逐 token 匹配：稳定前缀命中，遇到第一个动态 token 即断，其后全部（包括历史对话）无法命中。命中率因此被钉死在「稳定前缀长度 / 总 prompt」，且随对话变长持续下降。

---

## 4. 各 Provider 缓存 / usage 行为对比

| Provider | 格式 / 转换路径 | 流式 usage | `cached_tokens` 字段 | 说明 |
|---|---|---|---|---|
| **amd** | Chat 转换 | 默认返回 | 有 | 实测命中率 10.5% |
| **sensenova** | Chat 转换 | 需 `stream_options.include_usage` | 有 | 加了才返回 usage；流式用 `reasoning_content`，**非流式**用 `reasoning` |
| **modelscope** | Chat 转换 | 需 `include_usage`；默认每帧 usage 恒 0 | **无**（只有 prompt/completion/total） | 不缓存 / 不报告缓存 |
| **deepseek** | Anthropic 原样转发 | — | — | 不经过转换，cache_control 与 system 位置原样保留 |
| **openai** | Responses 转换 | — | 官方口径有 | 官网约 90%（用户报告）；尚未从日志同口径复算（日志已滚动清除） |

流式 / 非流式务必分开看：多个 Chat 端点**非流式返回真实 usage，流式默认不返回**（除非 `include_usage`）。

---

## 5. 代理侧已确认的缺陷（可修复）

1. **`stream_options.include_usage` 缺失**：`buildOpenAIRequest` 固定 `{ model, messages, stream: true }`，未带 `stream_options: { include_usage: true }`。后果：
   - 对 sensenova / modelscope，代理恒流式转发，上游流式就不返回 usage，导致**客户端（Claude Code）拿不到真实 token 数 / cached_tokens**（回传的是 0）。
   - 加 `include_usage` 后（curl 已验证），sensenova / modelscope 都会在流式末尾吐真实 usage。
2. **cache_control 未转发**：Anthropic 侧标注稳定段的 `cache_control` 在转换时被丢弃，虽有 cache_control 的端点（非 AMD）无法据此做分段缓存。

> 注：以上两点都不改变 AMD 10.5% 的结论（AMD 流式本就返回 usage，且不依赖 cache_control）。

---

## 6. 工具

`tools/cache-analysis.py`（对请求日志做分析）：

```bash
python3 tools/cache-analysis.py archive --provider amd --out /tmp/logs   # 归档（躲开 200 个滚动清理）
python3 tools/cache-analysis.py analyze  --dir /tmp/logs                  # 相邻轮上游 body 最长公共前缀
python3 tools/cache-analysis.py usage    --dir /tmp/logs                  # 各端点 token 层面缓存命中率
```

`usage` 子命令已兼容各端点 SSE 差异（AMD 的 `data:{...}\nid:N`、openai 的 `response.usage`、Chat 顶层 `usage`）。

---

## 7. 待办 / 后续

- [ ] 给 `buildOpenAIRequest`（及 `buildResponsesRequest`）补 `stream_options: { include_usage: true }`，修复流式 usage 丢失。
- [ ] 用补丁后收集 sensenova 多轮请求，同口径对比命中率，判断「10.5% 结构性天花板」是否为所有 Chat 中转端点共性，还是 AMD 特有。
- [ ] （可选）如需提升 AMD 命中率，方向是「把动态注入从稳定前缀中挪到末尾」，但会改变模型看到的上下文结构，需权衡。