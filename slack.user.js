// ==UserScript==
// @name         摸鱼助手-知乎
// @namespace    https://lichuanyang.top/
// @version      1.0
// @description  摸鱼辅助工具，移除知乎log, 移除问题页面的大标题
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
      .PageHeader .QuestionHeader-title {
        display: none;
      }
      .css-1hlrcxk {
        display: none;
      }
      .css-olurbu img.content_image[data-size="normal"], .css-olurbu img.origin_image[data-size="normal"] {
        width: 50%;
      }
    `);


})();

