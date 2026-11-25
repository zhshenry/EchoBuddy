---
version: alpha
name: EchoBuddy
description: Windows 离线听写浮窗及设置界面的 UI 规范
colors:
  ink: "#25282C"
  muted: "#656B70"
  surface: "#FFFFFF"
  primary: "#E9384E"
  accent-deep: "#B9253B"
  tint: "#FCEBED"
  link: "#185ABD"
typography:
  title:
    fontFamily: &ui-font '"Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.35
  section-title:
    fontFamily: *ui-font
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: *ui-font
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  transcript:
    fontFamily: *ui-font
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.65
  control:
    fontFamily: *ui-font
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.35
  secondary:
    fontFamily: *ui-font
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  link:
    fontFamily: *ui-font
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.35
  caption:
    fontFamily: *ui-font
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: 7px
  window: 14px
  widget: 28px
spacing:
  control-height: 32px
  compact-height: 28px
  inline-control-width: 156px
  inline-segment-width: 74px
  option-row-height: 30px
  segment-height: 22px
  window-button-size: 30px
  tool-button-size: 36px
  microphone-size: 42px
components:
  inline-settings-control:
    width: "{spacing.inline-control-width}"
    height: "{spacing.compact-height}"
  inline-update-action:
    width: "{spacing.inline-segment-width}"
    height: "{spacing.compact-height}"
    typography: "{typography.control}"
  text-button:
    height: "{spacing.control-height}"
    rounded: "{rounded.control}"
    typography: "{typography.control}"
  segmented-item:
    height: "{spacing.segment-height}"
    rounded: "{rounded.control}"
    typography: "{typography.control}"
  selected-segment:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.accent-deep}"
  compact-link:
    height: "{spacing.compact-height}"
    typography: "{typography.link}"
  more-settings-link:
    textColor: "{colors.link}"
  window:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.window}"
  window-button:
    size: "{spacing.window-button-size}"
    textColor: "{colors.muted}"
  tool-button:
    size: "{spacing.tool-button-size}"
  microphone:
    size: "{spacing.microphone-size}"
    backgroundColor: "{colors.primary}"
---

# EchoBuddy UI 设计规范

## Overview

EchoBuddy 是中文界面的 Windows 离线听写工具。悬浮条用头像和声波显示听写状态，右侧麦克风负责开始和结束。设置、转写和语言选择沿用同一套文字层级和控件尺寸，让用户在其他应用旁边也能快速读清和操作。

本文覆盖听写浮窗、转写气泡、浮窗设置、识别语言面板和独立设置窗口。[运行样式](src/widget/widget.css)集中定义字号、字重和尺寸。调整公共规则时，同步更新本文的对应数值。

## Colors

正文用 `--ink`，辅助信息用 `--muted`，卡片用 `--surface`，分区用 `--line`。麦克风和选中态沿用头像配色，`--accent` 对应主色，`--acc-deep` 用于选中文字和焦点提示，`--tint` 用于选中底色。「更多设置」用 `--link` 的蓝色文字和齿轮图标，悬停时加下划线。

## Typography

字体按 `Segoe UI`、`Microsoft YaHei UI`、系统无衬线字体的顺序回退。标题、正文、按钮和快捷键标签共用这个字体栈。下表以 CSS 像素为单位。

| 文字层级 | 字号 | 字重 | 行高 | 例子 |
| --- | --- | --- | --- | --- |
| 一级标题 | 18 px | 700 | 1.35 | 「设置」「EchoBuddy 设置」 |
| 二级标题 | 13 px | 600 | 1.35 | 「录音模式」「写入时机」「识别语言」「本次转写」「图标样式」「贴边自动收起」 |
| 正文 | 14 px | 400 | 1.5 | 普通段落 |
| 转写正文 | 14 px | 400 | 1.65 | 已转写内容和实时草稿 |
| 控件文字 | 13 px | 400 | 1.35 | 按钮、输入框、语言选项和设置导航 |
| 浮窗状态提示 | 12 px | 400 | 1.5 | 听写反馈、更新通知 |
| 文字链接 | 12 px | 400 | 1.35 | 「更多设置」「更新日志」 |
| 注释 | 11 px | 400 | 1.5 | 设置说明、更新状态。版本号、键帽和控件内的短说明行高为 1.35 |

选中的分段项和设置导航用 600 字重。更新区的 EchoBuddy 标识也用 13 px／600。正文保留常规字重，用段落和间距区分内容。

文案使用简体中文和中文标点。标题用简短的名词短语，按钮直接写动作，如「检查更新」「复制文字」。普通提示先交代状态，再给可执行的下一步。数字与单位之间留一个空格，如「2 分钟」「2 小时」。

## Layout

浮窗设置的二级标题靠左，对应控件靠右并垂直居中，行内上留 7 px、下留 8 px。录音模式和写入时机的分段组为 156 × 28 px。点击「前往反馈」收起浮窗设置，并打开独立设置的「问题反馈」页。浮窗里的「前往反馈」与「检查更新」共用按钮样式，宽度按单个分段项计算，高度按分段组外框计算，为 74 × 28 px，右侧对齐，文字居中。独立设置的「写入时机」和「识别语言」沿用浮窗的控件尺寸和选中配色。浮窗的设置区预留滚动条位置，展开和滚动时维持横向对齐。

独立设置的「语音」「个性化」「快捷键」「版本更新」「问题反馈」共用首行起点。首行距内容区顶部 17 px，标题在 32 px 高的区域内垂直居中。标题左边距为 24 px，窄窗口为 14 px。切换分类从页面顶部开始。

「更多设置」位于浮窗「设置」标题同一行的右侧。

独立设置的「语音」页在识别语言下方提供「声纹库」。标题与「识别语言」同级左对齐，新增入口在标题右侧。细圆角框只围住名单，姓名从框边缩进，使用 12 px 常规字重。说明位于名单下方，行尾菜单提供重新录入和删除。点击姓名原位改名，沿用会议标题的 Enter、失焦保存和 Esc 取消规则。录入区在名单上方显示当前对象、样本进度和朗读提示。

个性化页在图标色板下加一条细分割线。「贴边自动收起」右侧的「是／否」沿用「角色／图形」的等宽分段控件。

贴边收起时，左、右侧控件为 44 × 110 px，顶部为 144 × 44 px。贴屏的一侧平齐，朝向屏幕内的一侧保留圆角。待机用箭头提示展开方向，录音时原位置显示红点与计时。麦克风和停止按钮共用 32 × 32 px 的固定位置。

会议模式将「写入时机」替换为「录音来源」，两项沿用 156 × 28 px 的分段布局，选中时同时显示勾选标记。「更多设置」的六个分类共用同一个窗口，默认窗口尺寸为 960 × 580 个逻辑像素，首次打开时以屏幕可用区域为上限。切换分类时保持窗口尺寸和位置。「会议记录」的内容区并列显示历史和详情。较窄时，历史列表移到详情上方，可横向滚动。历史条目以浅粉底色标记当前会议，文字缩进始终一致。播放器下方按时间排列说话人、录音来源和转写，点时间所在行即可跳播。

会议详情顶部的「说话人」随转写滚动始终可见。右上方的名单按首次发言排序，显示每个人的发言段数和试听时间。正在改名的条目使用浅粉底色，编辑区紧随该条目。

切换录音模式时，选中底色沿分段控件滑动，工具栏的声波和会议状态、下方的写入时机和录音来源交叉淡入淡出。使用浮窗统一的 200 毫秒过渡，两处内容在原位置切换。「减少动态效果」开启时立即切换。

## Elevation & Depth

浮窗、语言面板和独立设置窗口用白底、细边框和轻阴影与桌面区分。面板内用细分隔线区分设置组，选中项用浅底色提示。

独立设置的识别语言气泡与入口右边缘对齐，优先在按钮下方展开，下方空间不足时向上展开。复选项可连续勾选。

## Shapes

文字按钮和分段选项使用 7 px 圆角，语言入口和窗口图标按钮使用 8 px。独立设置窗和语言面板使用 14 px 圆角。设置和转写工具按钮以及麦克风为圆形。

## Components

| 控件 | 尺寸 | 用法 |
| --- | --- | --- |
| 文字按钮、输入框、设置导航 | 最小高度 32 px | 独立设置的「检查更新」，以及「写入当前光标」「添加」 |
| 行内分段控件 | 组高 28 px，单项最小高度 22 px | 「短听写／会议录音」和「流式输入／整句写入」。每组两项等宽，外框 1 px、内边距 2 px |
| 识别语言入口 | 156 × 28 px | 独立设置的语言选择，与行内分段控件对齐 |
| 浮窗文字按钮 | 74 × 28 px | 「前往反馈」「检查更新」及同一按钮的其他更新状态 |
| 紧凑文字链接 | 最小高度 28 px | 「更多设置」「更新日志」 |
| 语言复选行 | 最小高度 30 px，复选框 15 × 15 px | 整行可点，独立设置和语言面板共用尺寸 |
| 窗口和提示图标按钮 | 30 × 30 px | 最小化、关闭、收起提示 |
| 浮窗工具按钮 | 36 × 36 px | 设置和气泡图标。气泡图标位于齿轮与麦克风之间，短听写时打开本次转写，会议模式时打开会议记录 |
| 浮窗麦克风按钮 | 42 × 42 px | 开始与结束录音 |
| 外观选择 | 头像项高 38 px，色板项高 28 px | 选中项加边框或圆环 |

图标沿用 Phosphor Icons，图标按钮提供可读名称。键盘焦点使用 2 px 轮廓。选中状态同时有字重、底色或勾选标记。当前不可用的功能使用禁用态，提示里写明状态。

## Do's and Don'ts

- 新界面先按用途匹配上表，再复用已有的文字和控件规则。
- 验收时对照实际渲染的字号、字重和点击区，并检查长文案、选中和禁用状态。

## 问题反馈（2026-11-25）

反馈沿用设置表面、字体和主题。EchoBuddy 填写页以「问题描述」作为首行标题，右侧显示字数，标题位置与其他设置页一致；输入框采用浅灰底、7 px 圆角和控件字号，保持固定高度并在内部滚动。操作按钮高 32 px，主操作采用浅粉底色和强调文字，说明与按钮在输入框下方排列，窄窗自动换行。预览以「核对反馈内容」作为首行标题，右侧显示当前状态；描述与版本信息沿用输入框和名单的细边框，反馈历史使用分隔线和可重开的两行列表。填写、预览、发送在同一内容区完成。诊断原文折叠展示，预览阶段已脱敏。提交由明确按钮触发，复制或保存反馈包不标记已送达。描述草稿和已预览反馈保存在本机，切页和关闭不静默丢弃；历史可重开、同编号重试。已提交与已解决分开显示。ONOSAN/CMO 的错误卡沿用共享 Modal，关闭后返回原入口；EchoBuddy 使用现有独立设置页。

反馈方式位于问题输入框下方，使用现有的 32 px 文字控件与灰底选择框，提供自动、在线、内网三项。此处三个固定单选项明确使用原生 select，由浏览器承担选项弹层、键盘选择和屏幕阅读器行为，FeedbackPanel 负责值、禁用及保存；识别语言继续沿用既有多选面板。检测结果、时间、发送位置和 WeLink 维护人放在相邻的次要说明中。预览保留首行位置，在内容上方核对反馈方式；WeLink 摘要可展开查看，沿用正文字体。内网成功状态明确显示摘要已发送及反馈包仍待转交，包的本机位置可换行；复制后仅提示待手动发送。窄窗允许模式选择和重新检测换行，长路径与反馈编号不撑宽页面。
