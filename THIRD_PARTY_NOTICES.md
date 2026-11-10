# 第三方代码与素材

ShopMate-AI 的原创代码与文档使用 [MIT](LICENSE)。依赖、字体及照片保留各自的版权与许可；项目 MIT 许可不重新授权这些材料。

## 浏览器分发

前端使用 Vue、Vue Router、Pinia、Element Plus、Lucide、QRCode 及其间接依赖。构建通过 [Vite 的 `build.license`](https://vite.dev/config/build-options#build-license) 从实际打包模块生成 `dist/licenses/dependencies.md`，保留依赖许可与版权正文。构建后的 JavaScript 注明该文件的位置，Web 镜像同时包含 `/licenses/shopmate.txt`。更新依赖后重新构建，不手动修改生成文件。

Libre Franklin 字体使用 SIL Open Font License 1.1，正文与作者声明位于 [字体许可](frontend/public/licenses/libre-franklin.txt)。24 张商品示意图分别采用 CC0、CC BY 或 CC BY-SA；作者、来源、许可和文件摘要见 [图片清单](frontend/public/images/credits.json)，处理方式及署名要求见[素材说明](docs/assets.md)。压缩后的 CC BY-SA 图片继续按原许可提供。

## 服务端及构建依赖

准确版本与完整依赖树由 [后端锁文件](backend/package-lock.json)和[前端锁文件](frontend/package-lock.json)固定。npm 安装包中的 LICENSE、NOTICE 和其他版权声明应随原包保留；不能只复制 JavaScript 后去掉许可文件。后端未将依赖打包合并，API 镜像保留安装包中的声明。

主要运行依赖使用 MIT、ISC、BSD 或 Apache-2.0 等许可。`jszip` 的双许可选择 MIT；`sharp` 使用 Apache-2.0，其预编译 libvips 及相关本机组件还包含 LGPL 及其他许可，详见 [sharp 许可](https://github.com/lovell/sharp/blob/main/LICENSE)与 [sharp-libvips](https://github.com/lovell/sharp-libvips)。不将这些本机库解释为项目自有 MIT 代码。

Alipay SDK 使用基于上游 4.14.0 的本地 `4.14.0-shopmate.1` 补丁包。仅将两个 AES 文本辅助函数从停止维护的 crypto-js 改为 Node 内置 crypto，保留原协议、签名及请求实现；随包补齐上游原始 MIT 许可。上游归档、摘要、源补丁和重建方式见[修改说明](third_party/alipay-sdk/CHANGES.md)与[原许可](third_party/alipay-sdk/LICENSE)。该依赖只随应用镜像交付，没有发布到 npm。

锁文件也记录平台可选包和构建工具。Lightning CSS 的 MPL-2.0 适用于其本身，未作为服务端组件或独立二进制随本次源码 Release 发布；其上游源码见 [Lightning CSS](https://github.com/parcel-bundler/lightningcss)。

## 容器再分发

Dockerfile 使用官方 Node.js、Nginx/Alpine 基础镜像，API 另安装 Poppler、字体及 libvips 相关组件。它们包含 GPL、LGPL、MPL、OFL 等独立许可。`v0.1.0`、`v0.1.1` 仅发布源码；从 `v0.1.2` 起，API/Web 镜像的分发流程另外收集实际版本的对应源码、Alpine 构建配方、补丁、许可与摘要，随对应 Release 提供。具体内容、获取与替换组件的方法见[容器分发说明](docs/container-distribution.md)。

API 镜像另保留 sharp-libvips `v1.3.4` 的[完整第三方通知](third_party/sharp-libvips-1.3.4-NOTICES.txt)，原文来自其[上游版本](https://github.com/lovell/sharp-libvips/blob/v1.3.4/THIRD-PARTY-NOTICES.md)，SHA-256 为 `6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe`。升级该包时须同步核对通知和源码收集流程，不手动改写上游许可。使用依赖、镜像或素材时按各自原许可处理。
