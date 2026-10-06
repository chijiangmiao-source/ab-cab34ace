# 姿控步骤单 · 多副本收敛演练台

审查员可在页面粘贴包含 **2–4 个副本、最多 40 项生成/投递动作**的姿控步骤单演练，
并**按步骤或整段回放**，逐项查看各副本的可见步骤、等待操作、墓碑及首个拒因。

## 验收性质

| 场景 | 预期 |
| --- | --- |
| 两个副本在同一父步骤后**离线并发插入、再以相反顺序投递** | 收敛为**按稳定操作标识排序**的相同步骤序列 |
| **先撤销祖先**，再收到其下**合法子步骤** | 祖先保留为**不可见墓碑**；子步骤不被拒绝、不株连，仍出现在正确位置（标注于墓碑之下） |
| **乱序操作** | 依赖齐备前等待，齐备后级联且**仅应用一次** |
| **重复投递** | 幂等，不新增步骤或墓碑 |
| **复用操作标识但篡改载荷 / 缺失父项 / 越界序号** | 定位**首个拒因**，既有投影不变；坏数据包只被丢弃，之后的规范投递仍可生效（可自愈收敛） |
| **刷新或关闭后重开** | 操作日志、副本状态恢复为相同的可见序列、等待操作与已应用记录，并能继续接收此前滞留的合法投递 |

## 演练单语法

```
REPLICAS 2|3|4
GEN   <id> insert <标签> [parent=<id|root>] seq=<0..40> [note=<备注>]   # 生成并全员投递
GEN   <id> undo target=<id>                                            # 生成撤销
HOLD  <...同上...>                                                      # 生成但先滞留（离线）
DELIVER <id> [R1,R2]                          # 向指定/全部副本规范投递
DELIVER <id> [R1,R2] SET label=.. seq=.. parent=.. note=..   # 携带篡改信封（复用标识）
```

- `#` 开头为注释；`GEN/HOLD/DELIVER` 动作行总数上限 40。
- 兄弟步骤的最终顺序只由稳定操作标识字典序决定，与投递顺序无关。

## 本地运行

```bash
node scripts/build.mjs          # 引擎自检 + 页面语法检查 + 输出 dist/
PORT=8080 node server.mjs       # http://localhost:8080 ，健康检查 /healthz
```

## Docker Compose

宿主机端口可用 `HOST_PORT` 配置（默认 8080）：

```bash
HOST_PORT=9090 docker compose up --build web
```

一次性验收（**以并发插入、祖先撤销后的迟到子项、重开恢复为验收对象**）：
执行代码测试 → 构建页面 → 对页面和 `/healthz` 做 HTTP 冒烟，完成后退出并以退出码报告结果：

```bash
docker compose build
docker compose run --rm verify     # 全部通过退出码 0；任一失败非 0
```

## 目录

```
public/core.mjs     收敛引擎（树 CRDT、墓碑、等待/级联、拒因、序列化）
public/drill.mjs    演练单解析与多副本编排
public/app.mjs      页面交互（粘贴、逐帧/整段回放、追加滞留投递）
server.mjs          静态页面 + API + 原子持久化 + /healthz
scripts/build.mjs   构建（自检、语法检查、产物汇总）
scripts/smoke.mjs   HTTP 冒烟（页面/健康接口 + 三场景端到端）
test/               node:test 验收测试（21 项）
compose.yaml        web（可配置宿主端口）+ verify（一次性验收）
```
