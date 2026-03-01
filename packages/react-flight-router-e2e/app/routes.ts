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
        id: "actions",
        path: "actions",
        component: () => import("./routes/actions.js"),
      },
      {
        id: "request-info",
        path: "request-info",
        component: () => import("./routes/request-info.js"),
      },
    ],
  },
];
