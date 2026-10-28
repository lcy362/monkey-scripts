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

1. 改代码，并把头部 `@version` 末位 +1（版本号没变则不会发版）
2. `git commit && git push`
3. 等 Greasyfork 自动同步，到脚本「历史」页确认新版本

> 仓库一旦私有化，Greasyfork 将无法读取 raw 文件，同步和 webhook 都会失效。
