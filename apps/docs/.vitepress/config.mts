import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

// The default locale (root) is English; Simplified Chinese lives under /zh/.
// Deploys to GitHub Pages at https://zhy0216.github.io/better-trigger/.

const mermaid = {
  // theme variables follow the default VitePress light theme; VitePress dark
  // mode is handled by the plugin automatically.
  theme: "base",
  themeVariables: {
    primaryColor: "#2563eb",
    primaryTextColor: "#0f172a",
    primaryBorderColor: "#93c5fd",
    lineColor: "#64748b",
    fontSize: "14px",
  },
  flowchart: { curve: "basis" },
  sequence: { mirrorActors: false },
};

const sharedHead = [
  ["meta", { property: "og:title", content: "better-trigger" }],
  [
    "meta",
    {
      property: "og:description",
      content:
        "TypeScript-first, PostgreSQL-backed durable execution runtime. Replay-based tasks, cron, retries — no Redis, no ClickHouse.",
    },
  ],
  ["meta", { property: "og:type", content: "website" }],
  [
    "link",
    { rel: "icon", href: "/better-trigger/logo.svg", type: "image/svg+xml" },
  ],
];

export default defineConfig(
  withMermaid({
    lang: "en",
    title: "better-trigger",
    description:
      "TypeScript-first, PostgreSQL-backed durable execution runtime. Replay-based tasks, cron, retries — no Redis, no ClickHouse.",
    base: "/better-trigger/",
    cleanUrls: true,
    ignoreDeadLinks: true,
    head: sharedHead,
    mermaid,
    vite: {
      // mermaid pulls in a large client bundle; raise the warning ceiling so
      // the docs build stays quiet.
      build: { chunkSizeWarningLimit: 2500 },
    },
    themeConfig: {
      logo: { src: "/logo.svg", alt: "better-trigger" },
      search: { provider: "local" },
      socialLinks: [
        { icon: "github", link: "https://github.com/zhy0216/better-trigger" },
      ],
      outline: { level: [2, 3], label: "On this page" },
      editLink: {
        pattern:
          "https://github.com/zhy0216/better-trigger/edit/main/apps/docs/:path",
        text: "Edit this page",
      },
    },
    locales: {
      root: {
        label: "English",
        lang: "en",
        link: "/",
        themeConfig: {
          nav: [
            { text: "Guide", link: "/guide/introduction" },
            { text: "Architecture", link: "/architecture/overview" },
            { text: "Reference", link: "/reference/sdk-api" },
          ],
          sidebar: {
            "/guide/": [
              {
                text: "Guide",
                items: [
                  {
                    text: "Introduction",
                    link: "/guide/introduction",
                  },
                  { text: "Quick start", link: "/guide/quick-start" },
                  { text: "Writing tasks", link: "/guide/writing-tasks" },
                  {
                    text: "Running the daemon",
                    link: "/guide/running-the-daemon",
                  },
                  { text: "Embedded mode", link: "/guide/embedded-mode" },
                  { text: "Deployment & security", link: "/guide/deployment" },
                ],
              },
            ],
            "/architecture/": [
              {
                text: "Architecture",
                items: [
                  {
                    text: "Overview",
                    link: "/architecture/overview",
                  },
                  {
                    text: "Durable execution",
                    link: "/architecture/durable-execution",
                  },
                  { text: "Database", link: "/architecture/database" },
                  { text: "Roadmap", link: "/architecture/roadmap" },
                ],
              },
            ],
            "/reference/": [
              {
                text: "Reference",
                items: [
                  { text: "SDK API", link: "/reference/sdk-api" },
                  {
                    text: "CLI & environment",
                    link: "/reference/cli-and-env",
                  },
                  { text: "REST API", link: "/reference/rest-api" },
                  { text: "Metrics", link: "/reference/metrics" },
                ],
              },
            ],
          },
        },
      },
      zh: {
        label: "简体中文",
        lang: "zh-CN",
        link: "/zh/",
        themeConfig: {
          nav: [
            { text: "指南", link: "/zh/guide/introduction" },
            { text: "架构", link: "/zh/architecture/overview" },
            { text: "参考", link: "/zh/reference/sdk-api" },
          ],
          sidebar: {
            "/zh/guide/": [
              {
                text: "指南",
                items: [
                  { text: "简介", link: "/zh/guide/introduction" },
                  { text: "快速开始", link: "/zh/guide/quick-start" },
                  { text: "编写任务", link: "/zh/guide/writing-tasks" },
                  {
                    text: "运行 daemon",
                    link: "/zh/guide/running-the-daemon",
                  },
                  { text: "嵌入式模式", link: "/zh/guide/embedded-mode" },
                  { text: "部署与安全", link: "/zh/guide/deployment" },
                ],
              },
            ],
            "/zh/architecture/": [
              {
                text: "架构",
                items: [
                  { text: "总览", link: "/zh/architecture/overview" },
                  { text: "持久化执行", link: "/zh/architecture/durable-execution" },
                  { text: "数据库", link: "/zh/architecture/database" },
                  { text: "路线图", link: "/zh/architecture/roadmap" },
                ],
              },
            ],
            "/zh/reference/": [
              {
                text: "参考",
                items: [
                  { text: "SDK API", link: "/zh/reference/sdk-api" },
                  { text: "CLI 与环境变量", link: "/zh/reference/cli-and-env" },
                  { text: "REST API", link: "/zh/reference/rest-api" },
                  { text: "指标", link: "/zh/reference/metrics" },
                ],
              },
            ],
          },
        },
      },
    },
  })
);
