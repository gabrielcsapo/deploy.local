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
      {
        id: "shared-ui",
        path: "shared-ui",
        component: () => import("./routes/shared-ui.js"),
      },
      {
        id: "redirect-destination",
        path: "redirect-destination",
        component: () => import("./routes/redirect-destination.js"),
      },
      {
        id: "redirect-302",
        path: "redirect-302",
        component: () => import("./routes/redirect-302.js"),
      },
      {
        id: "redirect-301",
        path: "redirect-301",
        component: () => import("./routes/redirect-301.js"),
      },
    ],
  },
];
