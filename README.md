# 跨文化背景阅读研究

阅读研究系统：三轮阅读、阅读理解与体验问卷、SUS/UEQ、可选访谈意向，以及管理员报告和导出。

## 本机启动

需要 Node.js 22 或更新版本，无需安装依赖。

```sh
node server.cjs
```

访问 `http://127.0.0.1:8765/LDreader_experiment.html`。

AI 配置可参考 `.ldreader-ai.example.json`，复制为本机 `.ldreader-ai.json` 后填写；该文件已排除提交。也可使用环境变量 `LDREADER_AI_KEY`、`LDREADER_AI_MODEL`、`LDREADER_AI_BASE_URL`。管理员密码通过 `LDREADER_ADMIN_PASSWORD` 配置。

## jdweb 同站点入口

招募图为 `assets/research-recruitment.png`。jdweb 集成后首页第一条广告进入 `/research/`，原问卷保留为第二条。

jdweb 使用独立静态页面和 `/research/api/` 接口，共用 Nitro 进程，不占用官网 `/api/`。前端会自动识别研究路径，原本的本机路径继续可用。

维护研究源码后，在 jdweb 仓库执行：

```sh
node scripts/sync-research.mjs /path/to/LDreader-Research-Study
```

公网运行须在 jdweb 服务端设置 `LDREADER_PUBLIC_ORIGIN` 为实际官网 HTTPS 来源（不带路径），并配置 AI 和管理员环境变量。默认仍只允许本机来源；不信任客户端的转发头。推送源码不等于完成生产部署。

## 数据范围

当前问卷、AI 调用记录、访谈意向和编号占用保存在参与者各自浏览器中，报告展示该浏览器的记录；尚无跨设备集中存储或统一编号互斥。清除浏览器数据会删除尚未导出的记录。面向远程招募前，需要另行实现集中数据收集。

本机配置、参与者导出数据和内部研究文档不纳入源码发布。

## 验证

```sh
node tests/ldreader.test.cjs
node tests/ai-server.test.cjs
git diff --check
```

测试使用内存记录和本机模拟 AI 服务，不发送文学材料到外部接口。
