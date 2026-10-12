# dsh-English-study-workplace

「英语学习小助手」的工作区。插件本体在 [packages/dsh-english-study](packages/dsh-english-study)，项目说明见 [PROJECT.md](PROJECT.md)。

Node 不在 PATH 上，统一用 `tools\node.cmd`：

```powershell
.\tools\node.cmd .\tools\smoke-host.mjs      # 宿主：存储、幂等、适配器、结果归一化
.\tools\node.cmd .\tools\smoke-web.mjs       # 前端：ui/db/tts/api/store/组件/路由/五个视图
.\tools\node.cmd .\tools\probe-api.mjs       # 对运行中的 DSH 发真实 HTTP 请求
.\tools\node.cmd .\tools\check-modules.mjs   # 沿真实浏览器模块图抓取每个 import
```

| 目录 | 内容 |
| --- | --- |
| `packages\dsh-english-study\` | 插件（宿主 `lib\` + 免构建前端 `web\`） |
| `data\` | 运行时数据：`store.json`、`images\`、`dictionary\ecdict.csv` |
| `docs\` | DSH 插件 API 研究、开源项目调研、v1 归档 |
| `study\` | 学习材料产出（日记改写等） |
| `tools\` | 全部测试与维护脚本 |

打开方式：`http://127.0.0.1:19387/english-study/`，或 DSH 右下角的「英语学习」按钮。

> **宿主侧代码只在 DSH 启动时加载**。改完 `lib\*.js` 要重启 DSH；`web\` 下的静态资源刷新浏览器即可。
