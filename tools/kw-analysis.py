import csv
import re
import sys
from collections import Counter, defaultdict

PATH = (
    sys.argv[1]
    if len(sys.argv) > 1
    else r"C:\Users\rockking00\Desktop\seoagent\Keyword Stats 2026-10-21 at 09_35_24.csv"
)

text = open(PATH, encoding="utf-16").read()
rows = [r for r in text.splitlines() if r.strip()]
header = rows[2].split("\t")
data = [r.split("\t") for r in rows[3:]]

kws = []
for r in data:
    kw = r[0].strip()
    try:
        vol = int(r[2])
    except (ValueError, IndexError):
        vol = 0
    comp = r[5].strip() if len(r) > 5 else ""
    kws.append((kw, vol, comp))

print(f"关键词 {len(kws)} 条，合计月搜索量 {sum(v for _, v, _ in kws):,}")
print("竞争度分布：", dict(Counter(c for _, _, c in kws)))

# ---- 归一化：去掉中文字之间的空格（Google 后台的中文分词空格）----
def normalize(s):
    s = s.lower().replace("\u3000", " ").replace("\xa0", " ")
    s = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

LEX = [
    "搜索引擎优化", "网站管理员工具", "网站管理员", "google search console",
    "搜索引擎", "初学者", "优化师", "管理员", "关键词", "关键字", "独立站",
    "搜索量", "排名", "优化", "推广", "投放", "广告", "工具", "教程", "指南",
    "公司", "服务", "培训", "书籍", "招聘", "兼职", "运营", "流程", "规则",
    "描述", "提交", "查询", "分析", "收录", "外贸", "网站", "搜索", "谷歌",
    "百度", "知乎", "免费", "价格", "费用", "怎么做", "如何", "是什么",
    "search console", "youtube", "ahrefs", "lanyan", "seo", "google",
]
LEX.sort(key=len, reverse=True)

def tokenize(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c.isspace():
            i += 1
            continue
        if c.isascii() and (c.isalnum() or c in "+-."):
            j = i
            while j < len(s) and s[j].isascii() and (s[j].isalnum() or s[j] in "+-."):
                j += 1
            # 合并 "search console" 这类多词英文
            for w in LEX:
                if s.startswith(w, i):
                    out.append(w)
                    i += len(w)
                    break
            else:
                out.append(s[i:j])
                i = j
            continue
        for w in LEX:
            if s.startswith(w, i):
                out.append(w)
                i += len(w)
                break
        else:
            out.append(c)
            i += 1
    return out

term_count = Counter()
term_vol = Counter()
term_examples = defaultdict(list)
pairs = Counter()

for kw, vol, _ in kws:
    terms = [t for t in tokenize(normalize(kw)) if len(t) > 1 or t.isascii()]
    for t in set(terms):
        term_count[t] += 1
        term_vol[t] += vol
        if len(term_examples[t]) < 3:
            term_examples[t].append(kw)
    for a, b in zip(terms, terms[1:]):
        pairs[f"{a} + {b}"] += 1

print("\n=== 单词频次 TOP 22 ===")
print(f"{'词':<14}{'出现在':>6}{'条数':>4}{'合计月搜索量':>12}  代表关键词")
for t, c in term_count.most_common(22):
    print(f"{t:<14}{c:>4} 条 {c / len(kws) * 100:>5.1f}% {term_vol[t]:>8,}  {' / '.join(term_examples[t])}")

print("\n=== 二元组合 TOP 15 ===")
for p, c in pairs.most_common(15):
    print(f"{p:<28}{c}")

print("\n=== 搜索量 TOP 12 ===")
for kw, vol, comp in sorted(kws, key=lambda x: -x[1])[:12]:
    print(f"{vol:>6}  {kw}  ({comp})")
