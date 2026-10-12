# dsh-english-study · 英语学习小助手

一个挂在 DSH 里的个人英语学习闭环插件。它只做一件事：把**你手写的、已经翻译成英文的日记**和**你随手粘贴的文本**变成可复习的单词库。

- 入口：`http://127.0.0.1:19387/english-study/`（也可以点右下角「英语学习」按钮）
- 数据：`data\store.json`、`data\images\`、`data\dictionary\ecdict.csv`
- 唯一模型：**智谱 GLM-4V-Flash**（官方免费，支持图片）

---

## 1. 它识别什么

| 功能区 | 输入 | 做什么 |
| --- | --- | --- |
| **日记分区** | 一张手写照片（抄写标注稿） | 提取英文原文 + 识别被椭圆圈出的单词 → **自动入库**；一天可写多篇 |
| **其它文本处理区** | 单词 / 长句 / 整段文本 / 粘贴的图片 | 中文译成英文、英文纠正错误 → 确认后进入英文界面 → **点词入库** |
| **标注单词库** | —— | 两种排序复习、展开详情、导出 CSV / Anki / JSON |

日记区**没有**手动点词标注：椭圆已经替你标好了，识别完直接进库。
日记区**没有**纠错步骤：那页纸在抄写之前就已经翻译好了，模型只做提取。
文本区**一定先出英文**：不论输入中文、英文还是中英混合，第二环节的预览里一个汉字都不会留。

---

## 2. 模型与费用

| 服务 | 要付费吗 | 能力 | 说明 |
| --- | --- | --- | --- |
| **智谱 GLM-4V-Flash** | **不要** | 图片 + 文本 | 官方文档写明是「完全免费的图像理解模型」。实测 15 秒读完整页手写。 |
| 本地 ECDICT 词典 | 不要 | 释义 / 音标 / 词形变化 | 65 MiB 离线词库，首次查词时载入，空闲 10 分钟后自动释放内存。 |
| 浏览器 Web Speech API | 不要 | 朗读 | `speechSynthesis`，`en-US`，语速 0.9，断网可用。 |

模型只用来：读图、抄写正文、识别圈词、判定语言、翻译、纠错、补充固定搭配。
音标、释义、词性、词形变化一律走本地 ECDICT。

「识别手写日记」会先后发出**三次小请求**（抄写正文 → 找圈词 → 找固定搭配），而不是一次大请求。
原因见 `lib/llm.js` 里的注释：GLM-4V-Flash 的输出上限实测为 1024 tokens，一次问完时模型为了塞进所有字段会**静默漏掉圈出的单词**（实测 15/17）；拆开后找回 17/17。圈词那一步还会跑两次取并集，因为单次结果有波动（6 次里 4 次 17/17、2 次 15/17，且漏的总是同一行的同一对词）。

文本区同理：**按行处理**，一次最多 8 行；回复被 1024 token 截断时把这一组对半拆分重问，而不是丢掉。

另一个细节：`response_format={"type":"json_object"}` **只发给返回 JSON 的任务**（抄写正文、文本区、单词详情）；圈词和固定搭配这两种「一行一个」的任务不带这个参数——它们的正确答案本来就不是 JSON，带上反而可能被严格实现该参数的提供方判成解析失败。

免费 Key：<https://bigmodel.cn/usercenter/proj-mgmt/apikeys> → 填进「设置」页。

---

## 3. 安装

```powershell
cd D:\dsh-English-study-workplace
.\tools\node.cmd .\tools\patch-profile-bundles.mjs    # 把插件写进 profile 的 bundles（幂等）
dsh plugin --profile desktop add D:\dsh-English-study-workplace\packages\dsh-english-study
```

两点注意：

1. **宿主侧代码只在 DSH 启动时加载**。改完 `lib\*.js` 必须重启 DSH；`web\` 下的静态资源刷新浏览器即可。
2. `link:` 装进来的本地插件**不会**出现在 DSH 的插件市场页（那页读的是远程目录）。判断装没装好要看 profile 的 `package.json`：`dependencies` 里有 `link:` 条目，且 `dsh.profile.bundles` 里有 `dsh-english-study`。

---

## 4. 目录

```
packages\dsh-english-study\
├─ package.json          # dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # 宿主侧那一行
├─ README.md
├─ lib\
│  ├─ index.js           # HTTP 路由、存储、ECDICT、结果归一化
│  ├─ llm.js             # GLM 适配器 + 四个提示词 + 三次请求的契约 + JSON 兜底解析
│  ├─ store.js           # 原子 JSON 存储 + 幂等账本
│  └─ client.js          # DSH 浏览器侧：主面板 + 右下角入口
└─ web\                  # 免构建 ESM 前端（没有打包器）
   ├─ index.html
   ├─ styles.css
   └─ js\{app,router,store,api,db,tts,ui,components,parse}.js
      └─ views\{home,diary,webtest,vocab,settings}.js
```

前端刻意**不引入打包器**：纯 ESM，加一个 30 行的 `h()` 代替 JSX。改完刷新浏览器就生效。

---

## 5. HTTP 路由

宿主挂在 `ctx.webServer` 上，`routeBase = /english-study`。API 全在 `/english-study/api/*`，比 SPA 前缀长，所以永远优先匹配。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 版本、数据目录、词典状态、当前服务与 Key 是否已配置 |
| GET | `/api/state` | 全量状态：日记、标注事件、词库、设置（**不含 Key**） |
| GET | `/api/settings` | 公共设置视图 + 四个提示词 + `defaultPrompts` |
| POST | `/api/settings` | 保存设置（Key、模型、提示词、TTS、复习间隔） |
| POST | `/api/images` | 图片入库，按 `sha256` 前 32 位命名 |
| GET | `/api/images/:id` | 取图 |
| POST | `/api/llm/study` | 读手写照片 → 英文原文 + 圈出的单词 + 固定搭配（**只认图片，不写库**） |
| POST | `/api/llm/normalize` | 文本/图片 → 英文 + 纠错 + 逐句中英（**不写库**） |
| POST | `/api/llm/lexeme` | 单词详情：先本地 ECDICT，缺了再问模型 |
| POST | `/api/diary/import` | **一键**：读图 + 写日记 + 圈词入库（幂等） |
| POST | `/api/diary` | 保存 / 更新日记条目 |
| POST | `/api/diary/delete` | 删除日记 |
| POST | `/api/vocab/annotate` | 加入单词库（幂等） |
| POST | `/api/vocab/update` | 改学习状态 / 收藏 / 备注 |
| POST | `/api/vocab/delete` | 删除词条 |
| GET | `/api/vocab/export?format=csv\|anki\|json` | 导出（CSV 带 BOM，Excel 不乱码） |

---

## 6. 可靠性（对照验收项）

| 编号 | 要求 | 实现位置 |
| --- | --- | --- |
| R1 | 提交按钮防重复 | 每个提交处 `if (submitting) return` + 立刻 `disabled` + loading 文案；关键写操作带 `requestId`，宿主按幂等账本去重 |
| R2 | 超时 + 指数退避 | `api.js` 统一 30 s（LLM 120 s）；失败按 1s → 2s → 4s 重试，最多 3 次；用尽后弹明确错误 + 手动「重试」 |
| R3 | 请求状态与 UI 状态绑定 | loading 全部由请求 Promise 的 `finally` 收尾；`guarded()` 错误边界包住每个视图，白屏不可能 |
| R4 | 离线检测 | 断网禁用提交并提示；写操作进 IndexedDB outbox 排队，联网后按顺序自动重发（只有 4xx 才丢弃） |
| R5 | LLM 独立超时 + 格式校验 + 降级 | 单独 120 s 超时；`extractJson` 容忍围栏和前后废话；解析失败返回 `degraded:true` + 原文 + 「重新解析」；全局串行队列保证同时只有一个模型请求 |
| R6 | 数据持久化 | 浏览器 IndexedDB 缓存 + 服务端 `data\store.json`（原子写），乐观更新 + 待同步标记 + 每分钟自动同步 |

---

## 7. 开发与测试

Node 不在 PATH 上，统一用 `tools\node.cmd`：

```powershell
.\tools\node.cmd .\tools\smoke-host.mjs      # 宿主：存储、幂等、适配器、结果归一化
.\tools\node.cmd .\tools\smoke-web.mjs       # 前端：ui/db/tts/api/store/组件/路由/五个视图
.\tools\node.cmd .\tools\smoke-parse.mjs     # 本地双语解析器
.\tools\node.cmd .\tools\check-dict.mjs      # ECDICT 词形变化抽查
.\tools\node.cmd .\tools\check-modules.mjs   # 沿真实浏览器模块图抓取每个 import
.\tools\node.cmd .\tools\probe-api.mjs       # 对运行中的 DSH 发真实 HTTP 请求
.\tools\node.cmd .\tools\seq-probe.mjs       # 对运行中的 DSH 验证多篇日记的页码校验
.\tools\node.cmd .\tools\normalize-probe.mjs # 文本区三例真连 GLM（空行 / 去空行 / 中英混合）
.\tools\node.cmd .\tools\probe-study-direct.mjs # 手写识图真连 GLM，不需要重启
.\tools\node.cmd .\tools\check-llm-live.mjs  # 真连一次 GLM（花额度，需要 Key）
.\tools\node.cmd .\tools\check-env.mjs       # 环境自检
```

`check-modules.mjs` 和 `probe-api.mjs` 都是对**运行中的服务**下断言，所以能抓到单元测试看不见的问题——例如 `.modal-layer` 少了 `[hidden]{display:none}`，整页被一层黑膜盖住、什么都点不了。这类 CSS 缺陷只能对着**真正被送达的产物**断言。

---

## 8. 已知限制

- GLM-4V-Flash 是免费模型，**速度不稳定**：实测一页手写约 12 秒（三次请求），高峰期更慢。每次请求超时给到 120 秒。
- 手写识别质量取决于字迹。圈词那一步偶发多认一个页面里存在、但没被圈过的词（实测 18 个结果里 1 个）：这是刻意的取舍——**漏词是静默失败，多词是可见且可删的**。界面提供「重新识别」，单词库也能直接删。
- GLM-4V-Flash 的输出上限是 **1024 tokens**（实测 `max_tokens` 填 2048 会被拒：`code 1210 max_tokens参数非法：限制数值范围[1,1024]`），所以描述性字段一律不交给模型，全部由本地词典提供。
- ECDICT 的词形变化是**稀疏**的（只有 46 000 多条带变化）。`beautiful` 这类形容词本来就没有变化，属正常。
- 本地词典**没有例句**，例句由模型补；模型没给就是空。
- 日记区不做中英对照——那页纸本身已经是英文，中文只出现在单词释义里。
- 一天多篇是**懒创建**的：点「下一篇」只跳转，那一页的记录只有导入成功才建立；宿主会拒绝 `seq > 1` 而前一篇不存在的请求（`400 page-order`），所以不会出现「有第 1、3 篇没有第 2 篇」。
- 文本区按行处理，一次请求最多 8 行；回复被 1024 token 截断时宿主会把这一组对半拆分重问，行数多时请求次数和耗时都会上升（实测 10 行约 21 秒）。
- 朗读依赖系统里装有英文语音；没有英文音色时 `speechSynthesis` 会用默认音色读英文。
