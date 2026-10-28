# monkey-scripts

自用油猴脚本集合。

## 脚本列表

| 文件 | Greasyfork |
|---|---|
| `zhihu_comment_time.user.js` | [482871 · 【知乎增强】评论时间精确到秒](https://greasyfork.org/zh-CN/scripts/482871) |
| `slack.user.js` | [483047 · 摸鱼助手-知乎](https://greasyfork.org/zh-CN/scripts/483047) |

## 发布流程

Greasyfork 直接从本仓库的 raw 文件同步代码，无需手动粘贴：

```
https://raw.githubusercontent.com/lcy362/monkey-scripts/main/zhihu_comment_time.user.js
https://raw.githubusercontent.com/lcy362/monkey-scripts/main/slack.user.js
```

改脚本时按顺序做三件事即可，Greasyfork 会在 webhook 触发后自动拉取并发布：

1. 改代码，并把头部 `@version` 末位 +1
2. `git commit && git push`
3. 等 Greasyfork 自动同步，到脚本「历史」页确认新版本

关于版本号：Greasyfork 判断"有没有更新"看的是**代码是否与当前最新版本逐字节相同**
（`lib/script_importer/script_syncer.rb`：`sv.code == last_saved_sv.code` → `:unchanged`），
与 `@version` 无关。代码变了但版本号没变时，它照样会生成一个新版本记录，只是给作者一条
`version_not_incremented` 警告（`app/models/script_version.rb`），而用户端的 Tampermonkey /
Violentmonkey 靠 `@version` 比较决定是否升级，所以**不会有任何人拿到这次更新**。
结论：必须递增 `@version`，否则等于白发一版。

> 仓库一旦私有化，Greasyfork 将无法读取 raw 文件，同步和 webhook 都会失效。
