import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    children: [
      {
        id: "home",
        index: true,
        component: () => import("./routes/home.js"),
      },
      {
        id: "about",
        path: "about",
        component: () => import("./routes/about.js"),
      },
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        children: [
          {
            id: "dashboard-index",
            index: true,
            component: () => import("./routes/dashboard/index.js"),
          },
          {
            id: "dashboard-settings",
            path: "settings",
            component: () => import("./routes/dashboard/settings.js"),
          },
        ],
      },
      {
        id: "posts",
        path: "posts",
        component: () => import("./routes/posts/layout.js"),
        children: [
          {
            id: "posts-index",
            index: true,
            component: () => import("./routes/posts/index.js"),
          },
          {
            id: "post-detail",
            path: ":id",
            component: () => import("./routes/posts/detail.js"),
          },
        ],
      },
      {
        id: "user-detail",
        path: "users/:id",
        component: () => import("./routes/users/detail.js"),
      },
    ],
  },
];
