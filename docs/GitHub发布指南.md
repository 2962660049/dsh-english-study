# 把「英语学习小助手」上传到 GitHub —— 从零开始的完整操作指南

> 你完全不了解 Git 也没关系。**每一步都可以照着命令原样复制**，每一步后面都写了「你应该看到什么」。
> 遇到和预期不一样的地方就停下来，不要继续往下做。

---

## 〇、先看结论（30 秒）

**可以安全上传。** 我已经把整个工作区排查过一遍，结论是：

| 项目 | 结果 |
| --- | --- |
| 你的智谱 API Key 出现在几个文件里 | **只有 1 个**：`data\store.json` |
| 这个文件会不会被上传 | **不会**（已被 `.gitignore` 挡住，并有三层防护） |
| 最终会上传的文件数 | **63 个** |
| 最终会上传的总体积 | **约 0.70 MB**（很轻，秒传） |
| 被排除的文件 | 约 190 个（密钥、私人照片、63 MB 词典、第三方文档、重复副本） |

而且上传用的那 63 个文件，我已经用一个专门的检查脚本验证过：**没有密钥、没有不该提交的目录。**

> ⚠️ 一件最要紧的事，请先记住：**在 `git push` 之前，任何东西都不会离开你的电脑。**
> `git add` 和 `git commit` 都只是在你自己的硬盘上打存档点。所以哪怕中途搞错了，只要还没 push，就随时可以推倒重来。

---

## 一、上传前我做了什么检查（这是为什么你敢放心）

### 1.1 密钥排查：只在一处

我把工作区里 246 个文件（排除 `node_modules` 这类依赖目录）逐个读了一遍，用四种方式去找你的 Key：

1. **完整的 Key**（49 个字符）
2. **Key 的前 12 位**（有些人会把 Key 截断使用）
3. **Key 的后 12 位**
4. **通用密钥形态**：智谱的 `id.secret` 格式、OpenAI 的 `sk-`、Google 的 `AIza`、AWS 的 `AKIA`、GitHub 的 `ghp_`

结果：

```
=== FULL API KEY appears in ===
  data\store.json
=== key HEAD(12) appears in ===
  data\store.json
=== key TAIL(12) appears in ===
  data\store.json
```

**只有 `data\store.json` 一处。** 源码、脚本、文档、README、`version1.0` 打包副本里全都没有。
（`version1.0\data\store.json` 是之前打包时脱敏过的版本，里面的 Key 已经是空字符串。）

### 1.2 顺带发现的其他敏感内容（不是 Key，但你要知道）

| 位置 | 里面有什么 | 默认处理 |
| --- | --- | --- |
| `data\store.json` | Key **+ 你的日记原文** | ✅ 已排除 |
| `data\images\*.jpg` | 你上传的手写照片 | ✅ 已排除 |
| `data\cache\*` | 测试用的临时图片 | ✅ 已排除 |
| `study\日记改写-六级提升-01.md` | 你的日记原文精修稿，**而且用的是旧术语「网页处理区」** | ✅ 已排除 |
| `tools\make-handwriting-fixture.py`<br>`tools\fixtures\handwriting-01.png` | 测试样张，**内容就是你的日记正文** | ✅ 已排除（你已决定不上传） |
| `docs\dsh-plugin-api.md` 等 | 你自己的研究笔记，原先含 `C:\Users\<用户名>\...` 这类绝对路径（会暴露 Windows 用户名） | ✅ 已脱敏为 `%USERPROFILE%`（30 处） |
| `docs\dsh-api\`（129 个文件） | **DSH 官方的包文档**，是从应用包里抄出来的，不是你的作品 | ✅ 已排除 |
| `.dsh-asar\` | DSH 应用本体的解包副本 | ✅ 已排除 |

### 1.3 体积与第三方内容

| 内容 | 大小 | 处理 | 原因 |
| --- | --- | --- | --- |
| `data\dictionary\ecdict.csv` | 62.88 MB | ✅ 排除 | 第三方词典（skywind3000/ECDICT，MIT 协议）。不用上传——仓库里已经有一个 `tools\fetch-ecdict.mjs`，一条命令就能下载 |
| `version1.0\data\dictionary\ecdict.csv` | 62.88 MB | ✅ 排除 | 同上，而且是重复副本 |
| `version1.0\`（55 个文件） | 63.66 MB | ✅ 排除 | 它是 `packages\` 的**打包副本**，不是源码。放进仓库会让同一个插件出现两份，还会让体积翻倍。要分享的话应该作为 **Release 附件** |
| `node_modules\`、`.pnpm-store\` | — | ✅ 排除 | 依赖和缓存，任何人 clone 之后自己装 |
| `docs\PROJECT-v1-归档.md` | 41 KB | ✅ 排除 | 已作废的旧设计稿，和你「不留旧路径」的原则一致 |

> 顺带说一句：GitHub 对单个文件的限制是 **100 MB**，超过 50 MB 会警告。62.88 MB 的词典其实**勉强能推上去**，但会让每个 clone 仓库的人都被迫下载 63 MB，而且那是别人的版权作品。改成「用脚本下载」是更专业的做法。

---

## 二、最终会被上传的 63 个文件

```
LICENSE                             1        MIT 开源协议
.gitattributes                      1
.gitignore                          1
PROJECT.md                          1        项目说明（达成目标的路径）
README.md                           1        工作区说明
prompt.md                           1        给另一个 DSH 会话的建站提示词
package.json                        1
pnpm-lock.yaml                      1
pnpm-workspace.yaml                 1
data/                               5        store.example.json + 4 个 .gitkeep
docs/                               4        3 份你自己的 API 研究笔记 + 这份指南
packages/dsh-english-study/        23        ★ 插件本体（宿主 + 前端 + 样式）
tools/                             22        ★ 测试与维护脚本
```

**总计 63 个文件、735,970 字节（约 0.70 MB）。** 其中真正是你的作品的核心是 `packages\`（23 个文件）和 `tools\`（22 个文件）。

---

## 三、我已经帮你准备好的 5 个文件

这些是上传前**必须**有的，我已经写好并验证过：

### 3.1 `.gitignore` —— 决定「哪些东西永远不进 Git」

这是整个方案里最重要的一个文件。它的第一段就是密钥防线：

```gitignore
# ---- 密钥与个人数据：绝对不提交 -------------------------------------------
data/store.json
data/store.local.json
.env
*.key
```

**⚠️ 千万不要删掉 `data/store.json` 这一行。** 删了它，你的 Key 下一次提交就会被推上去。

### 3.2 `.gitattributes` —— 统一换行符

Windows 用 CRLF、Linux/macOS 用 LF。没有这个文件，别人 clone 之后会看到「整个文件都被改了」的假改动。这个文件让仓库里统一存 LF。

### 3.3 `tools\check-secrets.mjs` —— 提交前的密钥检查（**核心保险**）

```powershell
.\tools\node.cmd .\tools\check-secrets.mjs
```

它会：

- 用 `git ls-files --cached --others --exclude-standard` 取出**这次提交真正会包含的文件清单**（即遵守 `.gitignore` 之后的结果，而不是全盘扫描）；
- 拿真实 Key 及其片段、5 种通用密钥形态、以及非空的 `"apiKey": "…"` 去这份清单里搜；
- 检查 `data/store.json`、`version1.0\`、`docs\dsh-api\`、`.dsh-asar\` 有没有混进来；
- **发现问题就中止，退出码 1。**

它**从不打印密钥本身**，只打印路径和「前 4 位 + 长度」这种无法还原的指纹 —— 所以你把运行日志贴给别人看是安全的。

我已经在真实索引上跑过一次，结果是通过：

```
=== 3. 禁止提交的路径 ===
  ✓ data/store.json  —— 不在清单里
  ✓ version1.0  —— 不在清单里
  ✓ docs/dsh-api  —— 不在清单里
  ✓ .dsh-asar  —— 不在清单里
  ✓ node_modules  —— 不在清单里
  ✓ .pnpm-store  —— 不在清单里
=== 结论 ===
  ✅ 通过：没有发现密钥，也没有发现不该提交的路径。可以 commit / push。
```

### 3.4 `tools\install-git-hooks.mjs` —— 让检查自动化

```powershell
.\tools\node.cmd .\tools\install-git-hooks.mjs
```

装一个 `pre-commit` 钩子：以后**每次 `git commit` 都会自动先跑一遍密钥检查**，不合格就中止提交。
这样即使你哪天忘了手动检查，也不会推出密钥。

### 3.5 `tools\make-example-store.mjs` + `data\store.example.json`

`data\store.json` 不上传，但别人 clone 之后就不知道数据长什么样。所以生成了一份脱敏的样板：**Key 是空字符串、日记和词库全部清空、默认设置保留**。别人一看就知道 Key 该填在哪个字段。
（需要重新生成时：`.\tools\node.cmd .\tools\make-example-store.mjs`）

---

## 四、Git 和 GitHub 是什么（一分钟看懂）

| 名词 | 白话解释 |
| --- | --- |
| **Git** | 装在你电脑上的「存档系统」。每存一次档就记一个版本，以后随时能翻回去 |
| **仓库（repository）** | 被 Git 管理的那个文件夹。你现在的 `D:\dsh-English-study-workplace` 马上就会变成仓库 |
| **commit（提交）** | 一次「存档」。存的是这一批改动的快照 |
| **暂存区（stage）** | 存档前的购物车。`git add` 把文件放进去，`git commit` 才真正存档 |
| **GitHub** | 一个网站，帮你把仓库放到云端。它和 Git 是两回事，GitHub 只是众多托管服务之一 |
| **remote（远程）** | 你给云端仓库起的代号，通常叫 `origin` |
| **push（推送）** | 把本地的存档传到云端。**只有这一步会让数据离开你的电脑** |
| **pull（拉取）** | 反过来，把云端的改动拿下来 |

你只需要记住这一条：**`add` 和 `commit` 都是本地的，`push` 才联网。**

---

## 五、第 1 步：设置你的身份

Git 每次存档都要记录「是谁存的」。先设置一次，以后不用再设。

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

**关于邮箱的隐私提示**：如果你不想公开真实邮箱，用 GitHub 提供的匿名邮箱。去 GitHub 网页 → 右上角头像 → Settings → Emails，页面里会看到一个 `xxxxxxx+用户名@users.noreply.github.com` 形式的地址，用它：

```powershell
git config --global user.email "1234567+yourname@users.noreply.github.com"
```

顺便建议再设一条，避免 Windows 的换行符自动转换和 `.gitattributes` 打架：

```powershell
git config --global core.autocrlf false
```

还有一条纯粹为了看着舒服：默认状态下 Git 会把中文文件名显示成 `"docs/GitHub\345\217\221..."` 这种转义形式。设成下面这样就能正常显示中文：

```powershell
git config --global core.quotepath false
```

**验证**：

```powershell
git config --global user.name
git config --global user.email
```

应该输出你刚填的两行。参考：你这台机器上 Git 是 `2.56.0.windows.2`，已经装好了，不用再装。

---

## 六、第 2 步：建立本地仓库

> 💡 **这一步我已经帮你做过了**（只是在本机建库，没有提交、没有联网）。你可以直接跳到第 3 步。
> 我执行的命令是 `git init -b main`，它在工作区里创建了一个隐藏的 `.git` 文件夹。
> 如果你不想要，删掉 `D:\dsh-English-study-workplace\.git` 这个文件夹就回到原样了。

如果你以后要在别的项目上重复这套流程，这一步是：

```powershell
cd D:\dsh-English-study-workplace
git init -b main
```

`-b main` 是让主分支叫 `main`（GitHub 的默认叫法），免得以后还要改名。

**验证**：

```powershell
git status
```

应该看到类似 `On branch main` / `No commits yet` / 一大堆 `Untracked files`。这些「未跟踪」的文件就是即将要提交的候选。

**⚠️ 顺序很重要**：`.gitignore` 必须在 `git add` **之前**就位。如果先 add 了 `data\store.json`，它就已经进入 Git 了，之后再加 `.gitignore` 是不会自动生效的（得用 `git rm --cached` 手动踢出去）。我们是先写好 `.gitignore` 才建库的，所以没有这个问题。

---

## 七、第 3 步：放进暂存区并逐项检查 ← **最关键的一步**

这一步决定了最终会上传什么。**请务必慢慢看。**

### 7.1 把所有文件加入暂存区

```powershell
cd D:\dsh-English-study-workplace
git add -A
```

`-A` 是「全部」的意思。注意：`.gitignore` 里列出的东西**不会被加进去**，哪怕用了 `-A`。

### 7.2 数一下文件数

```powershell
(git status --short).Count
```

**你应该看到 `63`。**

如果数字明显不对（比如 190 多），说明 `.gitignore` 没生效，**停下来别往下做**。

### 7.3 看一眼清单里有没有不该有的东西

```powershell
git status --short
```

每一行开头的 `A` 表示「新增」。请特别检查**没有**出现下面这些：

```
✗ data/store.json          ← 出现这个 = 你的 Key 要泄露了，立刻停下
✗ version1.0/...
✗ docs/dsh-api/...
✗ .dsh-asar/...
✗ node_modules/...
✗ data/images/...
✗ study/...
```

想更精确地只看「含 store 字样的文件」：

```powershell
git status --short | Select-String "store"
```

**应该只出现一行**：`A  data/store.example.json`（注意是 `.example`）。

### 7.4 跑密钥检查（最后一道闸）

```powershell
.\tools\node.cmd .\tools\check-secrets.mjs
```

**你应该看到最后一行是**：

```
  ✅ 通过：没有发现密钥，也没有发现不该提交的路径。可以 commit / push。
```

如果看到 `❌` 和 `exit code: 1`：**不要提交**。按它给出的提示把对应路径加到 `.gitignore`，然后执行 `git rm --cached <那个路径>`，再重新跑一遍检查。

---

## 八、第 4 步：第一次提交（存档）

建议先装好那个自动钩子，让以后的每次提交都自带检查：

```powershell
.\tools\node.cmd .\tools\install-git-hooks.mjs
```

然后提交：

```powershell
git commit -m "初始提交：英语学习小助手 DSH 插件（识图日记 + 文本处理 + 单词库）"
```

如果装了钩子，你会先看到密钥检查的输出，然后是类似这样的结果：

```
[main (root-commit) 3f2a1b9] 初始提交：英语学习小助手 DSH 插件（识图日记 + 文本处理 + 单词库）
 63 files changed, 12000 insertions(+)
```

**验证**：

```powershell
git log --oneline
```

应该只有一行，就是你刚才那次提交。

`git commit` 还有一个好处：**它只在本地**。你现在反悔还来得及 —— 想撤销这次提交用 `git reset --soft HEAD~1`。

---

## 九、第 5 步：在 GitHub 上创建远程仓库

这一步必须用浏览器。

1. 打开 <https://github.com> 并登录（还没账号就先注册，免费）。
2. 点右上角的 **`+`** → **New repository**。
3. **Repository name** 填：`dsh-english-study`
   （用英文名，因为这会变成网址的一部分。你也可以换成别的。）
4. **Description**（可选）填：`DSH 插件：手写日记识图入库 + 文本纠错翻译 + 单词库复习`
5. **选择可见性** —— 这一步要想清楚：

   | 选项 | 含义 | 建议 |
   | --- | --- | --- |
   | **Public** | 全世界都能看到、能下载 | 想给别人用、想放进简历，就选它 |
   | **Private** | 只有你自己（和你邀请的人）能看到 | **第一次上传建议先选 Private**，等确认仓库里确实没有私密内容，再在 Settings 里改成 Public |

6. **⚠️ 下面三个勾全部不要勾**：
   - ❌ Add a README file
   - ❌ Add .gitignore
   - ❌ Choose a license
   
   原因：你本地已经有 README 和 `.gitignore` 了。如果 GitHub 也帮你建一份，两边内容不一样，你第一次推送就会撞上冲突，对新手来说很难处理。

7. 点 **Create repository**。
8. 创建成功后页面会显示一段命令。找到 **HTTPS** 那个地址，长得像：

   ```
   https://github.com/你的用户名/dsh-english-study.git
   ```

   把这个地址记下来（页面上有个复制按钮）。

---

## 十、第 6 步：连接并推送

### 10.1 告诉本地仓库「云端在哪」

把下面命令里的地址换成你自己那串：

```powershell
cd D:\dsh-English-study-workplace
git remote add origin https://github.com/你的用户名/dsh-english-study.git
```

**验证**：

```powershell
git remote -v
```

应该输出两行，一行 `(fetch)`、一行 `(push)`，地址都是你刚填的。

如果提示 `remote origin already exists`，说明已经加过了，可以改用：

```powershell
git remote set-url origin https://github.com/你的用户名/dsh-english-study.git
```

### 10.2 确认分支叫 main

```powershell
git branch -M main
```

### 10.3 推送（第一次联网）

```powershell
git push -u origin main
```

`-u` 是「记住这个对应关系」，以后直接 `git push` 就行。

### 10.4 第一次会让你登录 GitHub

**这一步是新手最容易卡住的地方。** GitHub 从 2021 年起就不允许用账号密码推送了。你有两条路：

**路线 A（推荐，最省事）：用 Git 自带的凭据管理器**

因为你是 Windows 上装的 Git，通常自带 **Git Credential Manager**。执行 `git push` 后会自动弹出一个窗口：

- 选 **Sign in with your browser**（用浏览器登录）
- 浏览器打开 GitHub 授权页 → 点 **Authorize**
- 回到命令行，推送会自己继续

成功后凭据会存进 Windows 凭据管理器，以后不用再登。

**路线 B：手动创建访问令牌（PAT）**

如果没弹出窗口，或者你更喜欢手动控制：

1. 打开 <https://github.com/settings/tokens?type=beta>
2. **Generate new token**（Fine-grained token）
3. **Token name** 随便填，比如 `dsh-english-study-push`
4. **Expiration** 选 90 天或自定义
5. **Repository access** → 选 **Only select repositories** → 选中你刚建的 `dsh-english-study`
6. **Permissions** → 展开 **Repository permissions** → 找到 **Contents** → 设为 **Read and write**
7. 点 **Generate token**，把那一长串 `github_pat_...` **复制下来**（离开页面就再也看不到）
8. 回到命令行执行 `git push`，当它问：
   - `Username:` 填你的 GitHub 用户名
   - `Password:` **粘贴那个 token**（注意：不是你的账号密码）

### 10.5 成功的输出

```
Enumerating objects: 75, done.
Counting objects: 100% (75/75), done.
Writing objects: 100% (75/75), 990.00 KiB | 2.1 MiB/s, done.
To https://github.com/你的用户名/dsh-english-study.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

看到 `* [new branch] main -> main` 就是成功了。

---

## 十一、第 7 步：在 GitHub 上验收

**请一定做这一步**，别推完就走。

1. **刷新仓库页面。** 应该能看到 `README.md` 被渲染成首页，文件列表里有 `packages`、`tools`、`PROJECT.md`、`prompt.md`。
2. **点进 `data` 文件夹。** 里面**应该只有 5 项**：`store.example.json` 和 4 个 `.gitkeep`。
   **绝对不应该有 `store.json`。** 如果看到了，立刻跳到 §十三。
3. **确认这些文件夹不存在**：`version1.0`、`docs/dsh-api`、`.dsh-asar`、`node_modules`。
4. **本地再查一遍**：

   ```powershell
   git ls-files | Select-String "store"
   ```

   应该只有 `data/store.example.json` 一行。

5. **看一眼最终提交的文件清单**：

   ```powershell
   git ls-files | Measure-Object -Line
   ```

   应该是 `63`。

6. **（可选，最保险）用 GitHub 自己的搜索**：在仓库页面上方的搜索框里点一下，选 **In this repository**，搜 `apiKey`。搜到的应该只有源码里的字段名和 `store.example.json` 里的空字符串 `"apiKey": ""`，**不应该有任何一串真实的密钥字符**。

---

## 十二、以后的日常流程

每次改完代码想同步到 GitHub，就是这五条：

```powershell
cd D:\dsh-English-study-workplace
git add -A
.\tools\node.cmd .\tools\check-secrets.mjs      # 检查（装了钩子的话可以省略，提交时自动跑）
git commit -m "一句话说明这次改了什么"
git push
```

想先看看这次改了哪些文件：

```powershell
git status          # 概览
git diff            # 逐行看还没 add 的改动
git log --oneline   # 看历史存档
```

**两个必须记住的坑**：

- **不要养成 `git add -f data/store.json` 的习惯。** `-f` 是「强制」，会无视 `.gitignore`。这是唯一能绕过防线的操作。
- **`git commit --no-verify` 会跳过密钥钩子。** 除非你非常确定，否则别用。

---

## 十三、万一密钥真的泄露了怎么办

**如果 `data/store.json` 已经推到了 GitHub，请按这个顺序处理。**

### 第 1 件事（最要紧，先做这个）

**去智谱控制台把那把 Key 删掉或重置。**

- 打开 <https://bigmodel.cn/usercenter/proj-mgmt/apikeys>
- 找到那把 Key → 删除，或者新建一把然后删掉旧的
- 把新的 Key 填回网页的「设置」页

**为什么这一步最重要**：密钥一旦公开，就只能当作**已经泄露**。即使你随后从 GitHub 上删掉文件，搜索引擎、GitHub 的缓存、别人的 fork 都可能已经存了一份。清理历史只是止损，**换密钥才是真正的修复**。

### 第 2 件事：把文件从 Git 里踢出去（但不删本地文件）

```powershell
git rm --cached data/store.json
git commit -m "移除误提交的 store.json"
git push
```

注意 `--cached`：它只把文件从 Git 的跟踪列表里移除，**不会删你硬盘上的文件**。如果漏了这个参数，你的真实数据就被删了。

### 第 3 件事：清理历史记录

上面那条只让文件从**最新**版本消失，**历史提交里还在**。要彻底清掉需要重写历史。装 `git-filter-repo` 之后：

```powershell
git filter-repo --path data/store.json --invert-paths
git push --force --all
```

对新手来说，如果仓库刚建、只有一两次提交，**更简单的办法是：在 GitHub 上把整个仓库删掉，重做一个干净的**，然后重新按 §六～§十 走一遍。反正现在总共才 0.70 MB。

### 第 4 件事：检查有没有被用过

去智谱控制台的用量/账单页面看一眼，确认没有异常的调用记录。

---

## 十四、可选的加分项

| 想做的事 | 怎么做 |
| --- | --- |
| **加开源协议** | 在 GitHub 仓库页点 **Add file → Create new file**，文件名 `LICENSE`，右边会出现 **Choose a license template**，选 MIT 就会自动填好。这一步只是告诉别人「可以怎么用你的代码」 |
| **把 `version1.0` 打包给同学** | 本地压缩成 `version1.0.zip`，在 GitHub 仓库页右侧 **Releases → Create a new release** 上传成附件。这样既不用进 Git 历史，别人又能下载 |
| **让 GitHub 自动跑测试** | 建 `.github/workflows/test.yml`，内容让它在每次 push 后跑 `tools\smoke-host.mjs` 等离线脚本。注意：这些脚本不联网、不花钱，适合放进 CI |
| **让仓库更容易被搜到** | 仓库页右上角 ⚙️ → **Topics** 填 `dsh-plugin`、`english-learning`、`ocr`、`glm` |
| **写清楚怎么装** | 现在根目录的 `README.md` 偏「工作区备忘」，建议补上：项目是什么、截图、安装三步、Key 怎么填、已知限制。这份文档决定别人会不会用你的东西 |

---

## 十五、速查表（建议贴墙）

| 我想…… | 命令 |
| --- | --- |
| 看现在什么状态 | `git status` |
| 把改动放进暂存区 | `git add -A` |
| 检查有没有密钥 | `.\tools\node.cmd .\tools\check-secrets.mjs` |
| 存档 | `git commit -m "说明"` |
| 上传到 GitHub | `git push` |
| 看历史 | `git log --oneline` |
| 看这次改了哪几行 | `git diff` |
| 看云端地址 | `git remote -v` |
| 撤销上一次提交（保留改动） | `git reset --soft HEAD~1` |
| 把文件移出 Git（不删本地文件） | `git rm --cached <路径>` |
| 看 Git 实际跟踪了哪些文件 | `git ls-files` |
| 查某个文件为什么被忽略 | `git check-ignore -v <路径>` |

---

## 十六、三项决定与公开前的脱敏（已全部执行）

| 决定 | 你的选择 | 实际做了什么 |
| --- | --- | --- |
| 仓库公开还是私有 | **先私有，验证后再公开** | 建仓库时选 **Private**；验收通过后改为公开 |
| 那两个含日记正文的测试样张 | **不上传** | `.gitignore` 第 55–56 行加了 `tools/make-handwriting-fixture.py` 和 `tools/fixtures/`，两者已确认被忽略 |
| 开源协议 | **加 MIT** | 新建了 `LICENSE`（MIT，版权人 `孙文康`） |

### 公开前的脱敏（已做）

准备从私有改成公开时，把「绝对路径里的 Windows 用户名」统一换成了环境变量，**共 30 处**：

| 文件 | 替换处数 |
| --- | --- |
| `docs\dsh-plugin-api.md` | 13 |
| `docs\dsh-plugin-api-notes.md` | 14 |
| `tools\node.cmd` | 1 |
| `tools\pnpm.cmd` | 2 |

替换规则：

- `C:\Users\<用户名>\.dsh\...` → `%USERPROFILE%\.dsh\...`
- `C:\Users\<用户名>\AppData\Local\Temp\...` → `%TEMP%\...`

笔记内容一个字都没有改动，只换了路径前缀。改完已实测：`tools\node.cmd --version` 仍正常输出 `v24.21.0`（`%USERPROFILE%` 在 cmd 里会正常展开）。全仓库复查确认再无该 Windows 用户名。

### 你需要知道的一个副作用

**识图测试跑不了了**：排除样张之后，`tools\probe-study-direct.mjs`、`tools\probe-study.mjs` 需要你自己准备一张「圈了生词的手写英文照片」才能跑。其余离线测试（`smoke-host`、`smoke-web`、`smoke-parse`、`check-*`）完全不受影响 —— 我在排除后重跑过，全部通过（`smoke-host` 142/142、`smoke-web` 91/91、`smoke-parse` 32/0、`check-modules` 25/25）。

---

## 附：这次涉及的文件清单

| 文件 | 作用 |
| --- | --- |
| `.gitignore` | 密钥与个人数据的防线（**最重要**） |
| `.gitattributes` | 统一换行符，避免跨平台假改动 |
| `LICENSE` | MIT 开源协议 |
| `tools\check-secrets.mjs` | 提交前密钥检查，可重复运行 |
| `tools\install-git-hooks.mjs` | 把上面那个检查装成 `pre-commit` 钩子 |
| `tools\make-example-store.mjs` | 生成脱敏的 `data\store.example.json` |
| `data\store.example.json` | 给别人看的空白数据样板（Key 为空） |
| `docs\GitHub发布指南.md` | 就是本文 |
