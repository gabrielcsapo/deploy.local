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
        id: "notes",
        path: "notes",
        component: () => import("./routes/notes-layout.js"),
        children: [
          {
            id: "new-note",
            path: "new",
            component: () => import("./routes/new-note.js"),
          },
          {
            id: "note-detail",
            path: ":id",
            component: () => import("./routes/note-detail.js"),
          },
        ],
      },
    ],
  },
];
