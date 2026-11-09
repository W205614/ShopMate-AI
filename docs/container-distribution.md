# 容器分发与第三方源码

API 和 Web 镜像适用于 Linux/amd64，分别发布到 `ghcr.io/w205614/shopmate-ai-api` 和 `ghcr.io/w205614/shopmate-ai-web`。版本使用不可覆盖的 `vX.Y.Z` 标签；部署时可进一步固定为 Release 中记录的摘要。不发布 npm 包，也不重新分发 Caddy。

## 获取和启动

克隆项目、从 `.env.example` 初始化 `.env`，按 [README](../README.md#快速部署) 设置管理员密码和数据目录。在 `.env` 中增加以下两行即可直接使用公开镜像，无需安装 Node.js/npm 或本机构建，也无需 GitHub 登录：

```dotenv
API_IMAGE=ghcr.io/w205614/shopmate-ai-api:v0.1.3
WEB_IMAGE=ghcr.io/w205614/shopmate-ai-web:v0.1.3
```

```sh
docker compose pull api web
docker compose up -d --no-build --wait
docker compose ps
```

启动后访问 `http://localhost:18086/api/health`，应返回 `{"status":"ok"}`，再打开商城。日常停止使用 `docker compose stop`，再次启动使用 `docker compose up -d --no-build --wait`。这条入口只需拉取两个镜像，不会执行 Compose 中的 `build` 配置。

主分支可能领先镜像，镜像内容以对应 Release 的提交为准。需要从源码构建时，将两个镜像变量改为 `shopmate-ai-api:local` 和 `shopmate-ai-web:local`，再按 README 执行带 `--build` 的启动命令。其他架构需要自行构建，不能假定已有原生镜像。

镜像仍需要配置、业务卷及上传文件。已有环境升级前准备一致的恢复资料，保留原数据和密钥；不使用 `down -v`。生产入口仍按[生产指南](production.md)独立配置。

## 许可及对应源码

项目原创部分使用 MIT；镜像中第三方部分按各自许可分发。Node.js、Nginx、Alpine 包、Poppler、字体、sharp/libvips 及其依赖保留原许可，不由项目 MIT 重新授权。运行依赖中的 LICENSE/NOTICE 保留在原安装路径，Web 的浏览器依赖、项目及字体许可位于 `/licenses/`，图片署名在 `/images/credits.json`。

每个容器发布版本的 Release 附带 `container-sources-vX.Y.Z.tar.gz` 和 `SHA256SUMS`，提供：

- API/Web 实际安装的 Alpine 包名、版本、许可、来源和构建提交。
- 各 Alpine 包对应提交的 APKBUILD、补丁和安装脚本，以及由官方 `abuild fetch verify` 下载并校验的源文件；包括 GCC Runtime Library Exception 等上游文件。
- 实际 Node.js 版本的源码及完整许可；Nginx 对应版本源码及许可。
- 实际 sharp-libvips 版本的上游构建脚本、平台配置、全部组件源码、补丁及第三方通知；组件版本与镜像内 `versions.json` 逐项匹配。
- npm 包声明和原有许可/通知、浏览器构建生成的许可、字体许可和图片署名，以及文件摘要。

下载源码包后先核对外层 SHA-256，再解压并核对包内 `SHA256SUMS`。源码保留原许可、版权及修改说明。Alpine 的重建按对应 APKBUILD 和 `abuild` 流程执行；libvips 按附带的 sharp-libvips `build.sh linuxmusl-x64` 和平台 Dockerfile 执行。源文件已经附带，不依赖本项目作者临时提供。

镜像以聚合方式分发独立程序；Poppler 通过子进程调用，libvips 由 sharp 加载。使用者可以修改、重新构建和替换第三方组件，Dockerfile 与应用源码公开提供；没有添加阻止调试 LGPL 组件或替换共享库的限制。相关义务以源码包中的原许可正文为准。

## 维护发布

Alpine 源文件优先从官方 `distfiles` 镜像取得，仍由 APKBUILD 的原始摘要校验；镜像缺失时按 `abuild` 原有流程访问上游，任何获取或摘要错误均中止。源码收集作为依赖镜像验收的独立 CI 作业，传输失败后可只重跑该作业，不必重新执行已经通过的交易测试。

先在目标提交上完成 `Application validation`，保留其中验收过的镜像和已校验源码材料。创建新的版本 Tag 后，手动运行 `Publish validated containers`，填写版本及成功 CI 的 run ID。该流程核对提交和成功状态，下载同一镜像和源码材料，再创建草稿 Release 并推送版本化镜像；不重新构建、不部署生产，也不更新 `latest`。

新建 GHCR 包可能初始为私有。维护者须按公开发布范围设置包可见性，发布附带源码材料的 Release，再匿名拉取并核对镜像摘要、来源和许可入口。完成这些检查后才将本轮交付记为公开可用。Packages 列表读取失败与镜像推送、指定版本读取分别判断。
