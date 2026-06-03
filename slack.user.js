// ==UserScript==
// @name         摸鱼助手-知乎
// @namespace    https://lichuanyang.top/
// @version      2.0
// @description  摸鱼辅助工具，移除知乎logo, 移除问题页面的大标题
// @author       流沙
// @match        https://www.zhihu.com/*
// @match        https://zhuanlan.zhihu.com/*
// @icon         http://zhihu.com/favicon.ico
// @grant        GM_addStyle
// @license MIT
// ==/UserScript==


(function() {
    'use strict';

    GM_addStyle(`
      /* 隐藏问题页面大标题 */
      .QuestionHeader-title {
        display: none !important;
      }

      /* 隐藏知乎 logo（顶栏 + 其他区域） */
      a[aria-label="知乎"] svg,
      a[aria-label="首页"] svg {
        display: none !important;
      }

      /* 调整正文图片宽度 */
      .ztext img.content_image[data-size="normal"],
      .ztext img.origin_image[data-size="normal"],
      .ztext .content_image[data-size="normal"],
      .ztext .origin_image[data-size="normal"] {
        width: 50%;
      }
    `);

    // 定期清理可能漏掉的动态加载 logo
    const observer = new MutationObserver(() => {
      const logo = document.querySelector('a[aria-label="知乎"] svg, a[aria-label="首页"] svg');
      if (logo) logo.style.display = 'none';
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();

