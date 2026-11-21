# 打印（PrintBox）

通过绿联 NAS 直连局域网打印机，直接在 NAS 上打印 PDF 与图片，无需先下载到手机。

## 功能

- 打印 PDF、JPEG、PNG；
- 支持 Excel（xlsx/xls）与 Word（docx）文档：浏览器端解析并渲染为图片后打印（PPT 请先转 PDF）；
- 打印机自动发现（IPP/AirPrint 631 与 RAW 9100）与手动添加；
- 文件管理：目录树 + 面包屑 + 缩略图网格 + 搜索/类型筛选 + 路径直达 + 收藏/最近；
- 打印参数：份数、纸张、单双面、彩色/黑白、缩放；
- 打印队列：排队/打印中/完成/失败，可取消与重试；
- 打印历史、测试页、打印机状态（缺纸/忙碌等）；
- 手机相册/本地文件上传打印、网页链接下载后打印。

## 技术架构

- 后端：Go（静态编译），SQLite 记录打印机、任务、收藏与设置；
- 打印：自实现最小 IPP 客户端（Print-Job / Get-Printer-Attributes），RAW 9100 兜底；
- 前端：原生 ES Module 单页应用，系统风格，深色模式；
- 安装形态：UGOS Pro UPK（`open_type: inner`），端口 21020。

## 本地开发

```bash
go build -o .bin/qsl_print ./cmd/qsl_print
./.bin/qsl_print -addr :21020 -data ./_devdata -web ./web
```

浏览器打开 http://127.0.0.1:21020 。

## 打包

```bash
bash scripts/build.sh
```

产物：`build_dir/pkgs/upk/{amd64,arm64}_nasync_com.bd1bwg.print_<version>.upk`。

## 版本

- 0.1.4：打印范围（页码）；处理中状态；顶栏交互（logo 回主页、打印机列表、多选）；临时目录修复；授权引导。
- 0.1.1：修复 IPP 属性分组（0x0400）；PDF 经 pdftoppm 渲染为 JPEG 打印；电脑端入口精简（默认共享/上传目录、最近与收藏入口）；修复多选条误显示。
- 0.1.0：MVP（文件浏览、PDF/图片打印、队列、历史、测试页、状态监控、发现打印机）。

## 许可

GPL-3.0（见 LICENSE）。开发者：BD1BWG。技术支持：support@fire-tnt.cn。

## 开源与许可

本项目采用 **GNU General Public License v3.0（GPL-3.0）** 开源，全文见 [LICENSE](LICENSE)。

- 版权人：BD1BWG（2026）
- 源码仓库：<https://github.com/GOhaochen/printbox>
- 隐私政策：[docs/privacy-policy.md](docs/privacy-policy.md)
- 第三方组件许可：见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)
- 安装包构建：`bash scripts/build.sh`（需 Go 1.26+、ImageMagick、ugcli）

> 按 GPL-3.0 要求，分发安装包时须同时提供对应源码。
