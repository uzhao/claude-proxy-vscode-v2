#!/usr/bin/env python3
"""
分析 claude-proxy 请求日志，对比不同 provider 的缓存行为。

每个 jsonl = 一次 POST /v1/messages 调用（不是 agent loop）。关键字段:
  ev=request          客户端原始请求(Athropic 格式)
  ev=upstream_request 转换后发往上游的请求(deepseek=原样 / openai=responses / amd=chat)
  ev=upstream_chunk   上游 SSE 分片(含 usage,可看 cached_tokens)

三种模式:
  archive  把指定 provider 的请求归档到 --out 目录,避免被 200 个滚动清理吞掉
  analyze  按 provider×session 计算相邻两轮「上游 body 最长公共前缀」,量化前缀稳定性
  usage    按 provider 统计上游返回的 cached_tokens / prompt_tokens,算真实缓存命中率

示例:
  python3 tools/cache-analysis.py archive --provider amd --out /tmp/amd-logs
  python3 tools/cache-analysis.py analyze --dir /tmp/claude-proxy-logs
  python3 tools/cache-analysis.py usage   --dir /tmp/claude-proxy-logs
"""

import argparse
import json
import os
import re
import shutil
from collections import defaultdict


def provider_of(url: str) -> str:
    """从上游 URL 识别 provider。"""
    url = url or ""
    if "api.deepseek.com" in url:
        return "deepseek"
    if "api.openai.com" in url:
        return "openai"
    if "developer.amd.com.cn" in url:
        return "amd"
    if "modelscope" in url:
        return "modelscope"
    if "sensenova" in url:
        return "sensenova"
    return "unknown"


def sse_data_payloads(text: str):
    """从一段 SSE 原始文本里逐个 yield 每个 data: 的 JSON 负载。

    兼容 amd 的 `data:{...}\\nid:N` 多行格式,以及标准纯 `data:`。
    """
    for part in re.split(r"\n\n", text):
        for line in part.split("\n"):
            line = line.strip()
            if not line.startswith("data:"):
                continue
            p = line[5:].strip()
            if not p or p == "[DONE]":
                continue
            try:
                yield json.loads(p)
            except Exception:
                continue


def iter_usage(d):
    """从一个 SSE 负载里 yield usage(chat 在顶层 usage;responses 在 response.usage)。"""
    if isinstance(d.get("usage"), dict):
        yield d["usage"]
    r = d.get("response")
    if isinstance(r, dict) and isinstance(r.get("usage"), dict):
        yield r["usage"]


def load_req(path: str):
    """读一个 jsonl,返回 (session_id, begin_t, 原始 body, 上游 body, provider)。"""
    sess = None
    t0 = None
    req = None
    up = None
    prov = None
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                ev = o.get("ev")
                if ev == "begin":
                    t0 = o.get("t")
                elif ev == "request":
                    sess = (o.get("headers") or {}).get("x-claude-code-session-id")
                    req = o.get("body")
                elif ev == "upstream_request":
                    prov = provider_of(o.get("url", ""))
                    up = o.get("body")
    except Exception:
        return None
    if sess is None or t0 is None:
        return None
    return sess, t0, req, up, prov or "unknown"


def load_usage(path: str):
    """读一个 jsonl,返回 (session_id, begin_t, provider, 最后一个带真实 token 数的 usage dict)。"""
    sess = None
    t0 = None
    url = ""
    usage = None
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                o = json.loads(line)
                ev = o.get("ev")
                if ev == "begin":
                    t0 = o.get("t")
                elif ev == "request":
                    sess = (o.get("headers") or {}).get("x-claude-code-session-id")
                elif ev == "upstream_request":
                    url = o.get("url", "")
                elif ev == "upstream_chunk":
                    for d in sse_data_payloads(o.get("text", "")):
                        for u in iter_usage(d):
                            usage = u
    except Exception:
        return None
    if sess is None or t0 is None or usage is None:
        return None
    return sess, t0, provider_of(url), usage


def upstream_items(up):
    for k in ("messages", "input"):
        if k in up and isinstance(up[k], list):
            return up[k]
    return None


def item_fp(item):
    def clean(v):
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items() if k != "cache_control"}
        if isinstance(v, list):
            return [clean(x) for x in v]
        return v
    return json.dumps(clean(item), ensure_ascii=False, sort_keys=True)


def common_prefix(a, b):
    n = 0
    for x, y in zip(a, b):
        if item_fp(x) == item_fp(y):
            n += 1
        else:
            break
    return n


def scan_dir(directory):
    rows = []
    for fn in sorted(os.listdir(directory)):
        if not fn.endswith(".jsonl"):
            continue
        r = load_req(os.path.join(directory, fn))
        if r:
            rows.append((fn,) + r)
    rows.sort(key=lambda r: (r[1], r[2]))
    return rows


def do_archive(directory, provider, out):
    os.makedirs(out, exist_ok=True)
    rows = scan_dir(directory)
    copied = 0
    for fn, sess, t0, req, up, prov in rows:
        if provider and prov != provider:
            continue
        dst = os.path.join(out, prov)
        os.makedirs(dst, exist_ok=True)
        shutil.copy2(os.path.join(directory, fn), os.path.join(dst, fn))
        copied += 1
    print("归档 %d 个请求到 %s（按 provider 分子目录）" % (copied, out))


def do_analyze(directory):
    rows = scan_dir(directory)
    by_prov = defaultdict(list)
    for fn, sess, t0, req, up, prov in rows:
        by_prov[prov].append((sess, t0, up))

    print("目录 %s 共 %d 个请求\n" % (directory, len(rows)))
    for prov in sorted(by_prov):
        entry = by_prov[prov]
        print("### provider=%s  (%d 个请求)" % (prov, len(entry)))
        by_sess = defaultdict(list)
        for e in entry:
            by_sess[e[0]].append(e)
        for sess, seq in by_sess.items():
            if len(seq) < 2:
                print("  session=%s 仅 %d 个请求,跳过" % (sess, len(seq)))
                continue
            prev_up = None
            hit0 = 0
            total = 0
            for s, t0, up in seq:
                items = upstream_items(up)
                if items is None:
                    prev_up = None
                    continue
                if prev_up is not None:
                    total += 1
                    cp = common_prefix(prev_up, items)
                    if cp == 0:
                        hit0 += 1
                prev_up = items
            print("  session=%s 共 %d 个相邻对,前缀从第0条失配 %d 个 (%d%%)" %
                  (sess, total, hit0, 100 * hit0 // max(total, 1)))
        print()


def do_usage(directory):
    """按 provider 统计 token 层面缓存命中率。"""
    rows = []
    for fn in sorted(os.listdir(directory)):
        if not fn.endswith(".jsonl"):
            continue
        r = load_usage(os.path.join(directory, fn))
        if r:
            rows.append(r)
    rows.sort(key=lambda r: (r[0] or "", r[1] or 0))

    by_prov = defaultdict(list)
    for sess, t0, prov, usage in rows:
        by_prov[prov].append((sess, t0, usage))

    def num(x):
        return x if isinstance(x, (int, float)) else 0

    for prov in sorted(by_prov):
        seq = by_prov[prov]
        tot_pt = 0
        tot_ct = 0
        hit_req = 0
        for sess, t0, u in seq:
            pt = num(u.get("prompt_tokens")) or num(u.get("input_tokens"))
            details = u.get("prompt_tokens_details") or u.get("input_tokens_details") or {}
            ct = num(details.get("cached_tokens"))
            tot_pt += pt
            tot_ct += ct
            if ct > 0:
                hit_req += 1
        print("### %s  (%d 个请求有 usage)" % (prov, len(seq)))
        if tot_pt == 0:
            print("    上游未返回真实 token 数(prompt_tokens 恒 0)")
        else:
            print("    总输入 token=%d  总 cached=%d  → token 命中率 %.1f%%" %
                  (tot_pt, tot_ct, 100 * tot_ct / tot_pt))
            print("    有缓存命中的请求: %d/%d" % (hit_req, len(seq)))
        # 每条请求的命中率分布
        if tot_pt:
            print("    逐请求 cached/input 走势(每 session 前 12 条):")
            by_sess = defaultdict(list)
            for sess, t0, u in seq:
                by_sess[sess].append((t0, u))
            for sess, items in by_sess.items():
                print("      session=%s 共%d请求" % (sess, len(items)))
                for t0, u in items[:12]:
                    pt = num(u.get("prompt_tokens")) or num(u.get("input_tokens"))
                    details = u.get("prompt_tokens_details") or u.get("input_tokens_details") or {}
                    ct = num(details.get("cached_tokens"))
                    rate = 100 * ct / pt if pt else 0
                    print("        pt=%-7d ct=%-7d rate=%.1f%%" % (pt, ct, rate))
        print()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="分析 claude-proxy 缓存行为")
    sub = ap.add_subparsers(dest="cmd", required=True)

    ar = sub.add_parser("archive", help="归档请求日志")
    ar.add_argument("--dir", default="/tmp/claude-proxy-logs")
    ar.add_argument("--provider", default="", help="留空=全部")
    ar.add_argument("--out", required=True)

    an = sub.add_parser("analyze", help="对比各 provider 的缓存前缀稳定性")
    an.add_argument("--dir", default="/tmp/claude-proxy-logs")

    us = sub.add_parser("usage", help="按 provider 统计 token 层面缓存命中率")
    us.add_argument("--dir", default="/tmp/claude-proxy-logs")

    args = ap.parse_args()
    if args.cmd == "archive":
        do_archive(args.dir, args.provider, args.out)
    elif args.cmd == "analyze":
        do_analyze(args.dir)
    else:
        do_usage(args.dir)