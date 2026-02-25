import type { RouteConfig } from "react-flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    notFound: () => import("./routes/not-found.js"),
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
        id: "user-detail",
        path: "users/:id",
        component: () => import("./routes/users/detail.js"),
      },
      {
        id: "slow",
        path: "slow",
        component: () => import("./routes/slow.js"),
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
