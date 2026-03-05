import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    notFound: () => import("./routes/not-found.js"),
    error: () => import("./routes/error.js"),
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
        id: "broken",
        path: "broken",
        component: () => import("./routes/broken.js"),
      },
      {
        id: "dashboard",
        path: "dashboard",
        component: () => import("./routes/dashboard/layout.js"),
        notFound: () => import("./routes/dashboard/not-found.js"),
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
        id: "user-layout",
        path: "users/:id",
        component: () => import("./routes/users/layout.js"),
        children: [
          {
            id: "user-index",
            index: true,
            component: () => import("./routes/users/index.js"),
          },
          {
            id: "user-posts",
            path: "posts",
            component: () => import("./routes/users/posts.js"),
          },
        ],
      },
      {
        id: "slow",
        path: "slow",
        component: () => import("./routes/slow.js"),
      },
      {
        id: "suspense",
        path: "suspense",
        component: () => import("./routes/suspense/layout.js"),
        children: [
          {
            id: "suspense-index",
            index: true,
            component: () => import("./routes/suspense/index.js"),
          },
        ],
      },
      {
        id: "tabs",
        path: "tabs",
        component: () => import("./routes/tabs/layout.js"),
        children: [
          {
            id: "tabs-index",
            index: true,
            component: () => import("./routes/tabs/index.js"),
          },
          {
            id: "tabs-settings",
            path: "settings",
            component: () => import("./routes/tabs/settings.js"),
          },
          {
            id: "tabs-activity",
            path: "activity",
            component: () => import("./routes/tabs/activity.js"),
          },
        ],
      },
      {
        id: "loading-demo",
        path: "loading-with-component",
        component: () => import("./routes/loading-demo/layout.js"),
        loading: () => import("./routes/loading-demo/loading-skeleton.client.js"),
        children: [
          {
            id: "loading-demo-index",
            index: true,
            component: () => import("./routes/loading-demo/index.js"),
          },
          {
            id: "loading-demo-slow-child",
            path: "slow-child",
            component: () => import("./routes/loading-demo/slow-child.js"),
          },
        ],
      },
      {
        id: "error-demo",
        path: "error-with-component",
        component: () => import("./routes/error-demo/layout.js"),
        error: () => import("./routes/error-demo/error-fallback.client.js"),
        children: [
          {
            id: "error-demo-index",
            index: true,
            component: () => import("./routes/error-demo/index.js"),
          },
          {
            id: "error-demo-client-error",
            path: "client-error",
            component: () => import("./routes/error-demo/client-error-wrapper.js"),
          },
        ],
      },
      {
        id: "perf",
        path: "perf",
        component: () => import("./routes/perf.js"),
      },
      {
        id: "login",
        path: "login",
        component: () => import("./routes/login.js"),
      },
      {
        id: "register",
        path: "register",
        component: () => import("./routes/register.js"),
      },
      {
        id: "profile",
        path: "profile",
        component: () => import("./routes/profile.js"),
      },
      {
        id: "shared-ui",
        path: "shared-ui",
        component: () => import("./routes/shared-ui.js"),
      },
      {
        id: "explore",
        path: "explore",
        component: () => import("./routes/explore/layout.js"),
        children: [
          {
            id: "explore-index",
            index: true,
            component: () => import("./routes/explore/index.js"),
          },
          {
            id: "explore-universe",
            path: ":universe",
            component: () => import("./routes/explore/universe.js"),
            children: [
              {
                id: "explore-galaxy",
                path: ":galaxy",
                component: () => import("./routes/explore/galaxy.js"),
                children: [
                  {
                    id: "explore-system",
                    path: ":system",
                    component: () => import("./routes/explore/system.js"),
                    children: [
                      {
                        id: "explore-planet",
                        path: ":planet",
                        component: () => import("./routes/explore/planet.js"),
                        children: [
                          {
                            id: "explore-continent",
                            path: ":continent",
                            component: () => import("./routes/explore/continent.js"),
                            children: [
                              {
                                id: "explore-country",
                                path: ":country",
                                component: () => import("./routes/explore/country.js"),
                                children: [
                                  {
                                    id: "explore-region",
                                    path: ":region",
                                    component: () => import("./routes/explore/region.js"),
                                    children: [
                                      {
                                        id: "explore-city",
                                        path: ":city",
                                        component: () => import("./routes/explore/city.js"),
                                        children: [
                                          {
                                            id: "explore-district",
                                            path: ":district",
                                            component: () => import("./routes/explore/district.js"),
                                            children: [
                                              {
                                                id: "explore-street",
                                                path: ":street",
                                                component: () =>
                                                  import("./routes/explore/street.js"),
                                                children: [
                                                  {
                                                    id: "explore-building",
                                                    path: ":building",
                                                    component: () =>
                                                      import("./routes/explore/building.js"),
                                                    children: [
                                                      {
                                                        id: "explore-floor",
                                                        path: ":floor",
                                                        component: () =>
                                                          import("./routes/explore/floor.js"),
                                                        children: [
                                                          {
                                                            id: "explore-room",
                                                            path: ":room",
                                                            component: () =>
                                                              import("./routes/explore/room.js"),
                                                          },
                                                        ],
                                                      },
                                                    ],
                                                  },
                                                ],
                                              },
                                            ],
                                          },
                                        ],
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
