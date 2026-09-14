# 小红书 P1 配图

小红书笔记《写代码的软件，被我做成了手账本》的配图，用 HTML 渲染后截图生成。

## 产出

全部 1080 × 1440（小红书 3:4），`out/` 目录：

| 文件 | 用途 | 内容 |
|---|---|---|
| `cover.png` | 封面（第 1 张） | 手写体大字 + 倾斜的 app 窗口贴纸 |
| `full.png` | 第 2 张 | 手绘·纸面 整屏 |
| `kraft.png` | 第 3 张 | 深色·牛皮纸 整屏 |
| `detail.png` | 第 4 张 | 五处细节特写（药丸 / 审批卡 / 本轮修改 / 会话卡 / 虚线内衬） |
| `workflow.png` | 第 5 张 | **收藏钩子**：一个人用 AI 做软件的 7 步工作流 |

## 重新生成

```bash
cd prototypes/xhs-p1
node render.mjs cover full kraft detail workflow   # 可只渲染单张
```

渲染走 playwright-core(从 gstack skill 借的)`channel: "chrome"`,2x 出图后用 `sips` 降采样到 1080×1440。

## 实现说明

- **样式复用设计稿**：`sketch.css` 是从 `../theme-sketch-redesign.html` 里抽出来的 `<style>` 块，所以配色、圆角配方、硬阴影、虚线内衬、纸纹都和 app 内的手绘主题一致。改设计稿后重新抽一次即可同步。
- **字体**：直接引 `apps/desktop/node_modules/lxgw-wenkai-webfont` 里捆绑的霞鹜文楷（400 + 700），与 app 内是同一套。
- **图标抖动**：和 `apps/desktop/src/renderer/index.html` 一样挂一枚 `#sk-wobble` SVG 滤镜，`svg.tabler-icon` 走 `filter:url(#sk-wobble)`。图标字典 `ICONS` 抄自设计稿。
- **`?shot=` 路由**：`render.html?shot=cover|full|kraft|detail|workflow`，每张严格 1080×1440。
- **窗口画高**：`.cover .cols{min-height:950px}` / `.bleed .cols{min-height:1120px}`，让 app 窗口在竖版里铺满或自然出血裁切。

## ⚠️ 界面截图是「按设计稿重绘」的，不是真机截图

`cover` / `full` / `kraft` 里的 app 界面是按 `theme-sketch-redesign.html` 的标记重绘的 mockup，不是从运行中的 app 截的图。

差异风险：真机上的实际文案、会话列表、Git 状态与这里不同。**发之前建议用真机截图替换**——把 `render.html` 里 `appWindow()` 返回的那段标记，换成 `<img src="你的截图.png">` 即可，封面的大字和贴纸版式不用动。

`detail.png` 与 `workflow.png` 是纯设计排版（卡片拼贴 / 清单），不涉及"假装是截图"，可直接用。
