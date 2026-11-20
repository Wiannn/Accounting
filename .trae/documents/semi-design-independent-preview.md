# Semi Design 独立试用环境计划

## Context
当前账本是根目录直接发布的原生 HTML/CSS/JavaScript 应用，没有构建流程，数据存于 IndexedDB。用户希望实际下载并配置 Semi Design，但先建立独立试用环境，不改变现有账本及线上页面。Semi Design 是 React 组件库，因此使用独立的 Vite + React 子项目验证。

## 实施范围
- 新环境仅放在 `semi-preview/`，不引用或修改根目录 `index.html`、`app.css`、`app.js`、`xlsx.min.js`。
- 不读取、写入或迁移 `company-ledger`，演示状态仅使用 React 内存状态。
- 不迁移现有四个页面，不修改 GitHub Pages 配置，不把试用产物发布为账本线上版本。

## 文件与配置
新建以下最小文件：
- `semi-preview/package.json`：React、React DOM、Semi UI、Semi Icons 依赖，以及 Vite 的 `dev`、`build`、`preview` 脚本。
- `semi-preview/package-lock.json`：由 npm 生成，锁定依赖版本。
- `semi-preview/vite.config.js`：React 插件、相对构建资源路径、本机开发端口 5173 和构建预览端口 4173。
- `semi-preview/index.html`：独立 HTML 入口。
- `semi-preview/src/main.jsx`：挂载 React，并引入 Semi 官方样式。
- `semi-preview/src/App.jsx`：最小验证页面。
- `semi-preview/src/App.css`：试用页布局，样式类使用 `semi-preview-` 前缀。
- `semi-preview/.gitignore`：忽略 `node_modules/`、`dist/` 和日志。

不引入 TypeScript、Router、状态库、SheetJS、Service Worker 或服务端。

## 实施步骤
1. 检查本机 Node.js、npm 和 Semi 的 React peer 依赖，选择兼容版本安装，不使用强制绕过依赖冲突的参数。
2. 创建独立 Vite + React（JavaScript）项目，安装 `@douyinfe/semi-ui`、`@douyinfe/semi-icons` 及构建依赖。
3. 用 Semi 的 Card、Tag、Input、Button、Modal、Toast 和图标制作一个手机端可用的最小演示：输入回显、计数、重置、弹窗确认均只操作内存状态。
4. 页面明确标注“独立试用，不连接公司账本数据”。
5. 启动开发服务器，通过浏览器验证组件样式、图标和交互，再执行生产构建并验证构建预览。
6. 确认根目录账本文件无差异；仅提交并推送 `semi-preview/` 源码与锁文件，不提交依赖目录或构建产物。现有 GitHub Pages 入口和账本版本号保持不变。

## 验证
- `npm --prefix semi-preview run build` 成功，产物仅生成在 `semi-preview/dist/`。
- 打开 `http://127.0.0.1:5173`，确认无白屏、无组件样式或图标加载错误，输入、计数、重置、弹窗和 Toast 可用。
- 打开 `http://127.0.0.1:4173` 复核构建结果。
- 试用页不请求现有账本文件，不创建或访问 `company-ledger`。
- 根目录账本文件无 Git 差异，现有线上网址和功能不变。
