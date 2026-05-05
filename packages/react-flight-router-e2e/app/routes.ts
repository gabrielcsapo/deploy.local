import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    slots: {
      modal: [
        {
          id: "photo-modal-layout",
          path: "",
          component: () => import("./routes/photo-modal-layout.js"),
          children: [
            {
              id: "photo-in-modal",
              path: "photo/:id",
              component: () => import("./routes/photo-in-modal.js"),
            },
          ],
        },
      ],
      drawer: [
        {
          id: "cart-drawer-layout",
          path: "",
          component: () => import("./routes/cart-drawer-layout.js"),
          children: [
            {
              id: "cart-in-drawer",
              path: "cart",
              component: () => import("./routes/cart.js"),
            },
          ],
        },
      ],
    },
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
      {
        id: "boundary-page",
        path: "boundary-page",
        component: () => import("./routes/boundary-page.js"),
        loading: () => import("./routes/boundary-loading.client.js"),
        error: () => import("./routes/boundary-error.client.js"),
      },
      {
        id: "streaming-page",
        path: "streaming-page",
        component: () => import("./routes/streaming-page.js"),
      },
      {
        id: "photos",
        path: "photos",
        component: () => import("./routes/photos.js"),
      },
      {
        id: "photo",
        path: "photo/:id",
        component: () => import("./routes/photo.js"),
      },
    ],
  },
];
