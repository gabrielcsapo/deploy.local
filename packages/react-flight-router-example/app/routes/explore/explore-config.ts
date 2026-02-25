export interface ExploreLevel {
  level: number;
  name: string;
  paramName: string | null;
  routeId: string;
  borderColor: string;
  bgColor: string;
  sampleValues: string[];
}

export const EXPLORE_LEVELS: ExploreLevel[] = [
  {
    level: 0,
    name: "Explore",
    paramName: null,
    routeId: "explore",
    borderColor: "border-slate-400",
    bgColor: "bg-slate-50",
    sampleValues: [],
  },
  {
    level: 1,
    name: "Universe",
    paramName: "universe",
    routeId: "explore-universe",
    borderColor: "border-violet-400",
    bgColor: "bg-violet-50",
    sampleValues: ["alpha-centauri", "milky-way", "andromeda"],
  },
  {
    level: 2,
    name: "Galaxy",
    paramName: "galaxy",
    routeId: "explore-galaxy",
    borderColor: "border-purple-400",
    bgColor: "bg-purple-50",
    sampleValues: ["spiral-a", "elliptical-b", "irregular-c"],
  },
  {
    level: 3,
    name: "System",
    paramName: "system",
    routeId: "explore-system",
    borderColor: "border-indigo-400",
    bgColor: "bg-indigo-50",
    sampleValues: ["sol", "trappist", "kepler"],
  },
  {
    level: 4,
    name: "Planet",
    paramName: "planet",
    routeId: "explore-planet",
    borderColor: "border-blue-400",
    bgColor: "bg-blue-50",
    sampleValues: ["earth", "mars", "venus"],
  },
  {
    level: 5,
    name: "Continent",
    paramName: "continent",
    routeId: "explore-continent",
    borderColor: "border-cyan-400",
    bgColor: "bg-cyan-50",
    sampleValues: ["europe", "asia", "americas"],
  },
  {
    level: 6,
    name: "Country",
    paramName: "country",
    routeId: "explore-country",
    borderColor: "border-teal-400",
    bgColor: "bg-teal-50",
    sampleValues: ["france", "japan", "brazil"],
  },
  {
    level: 7,
    name: "Region",
    paramName: "region",
    routeId: "explore-region",
    borderColor: "border-emerald-400",
    bgColor: "bg-emerald-50",
    sampleValues: ["provence", "normandy", "brittany"],
  },
  {
    level: 8,
    name: "City",
    paramName: "city",
    routeId: "explore-city",
    borderColor: "border-green-400",
    bgColor: "bg-green-50",
    sampleValues: ["marseille", "paris", "lyon"],
  },
  {
    level: 9,
    name: "District",
    paramName: "district",
    routeId: "explore-district",
    borderColor: "border-lime-400",
    bgColor: "bg-lime-50",
    sampleValues: ["vieux-port", "la-defense", "montmartre"],
  },
  {
    level: 10,
    name: "Street",
    paramName: "street",
    routeId: "explore-street",
    borderColor: "border-yellow-400",
    bgColor: "bg-yellow-50",
    sampleValues: ["rue-republique", "avenue-champs", "boulevard-germain"],
  },
  {
    level: 11,
    name: "Building",
    paramName: "building",
    routeId: "explore-building",
    borderColor: "border-amber-400",
    bgColor: "bg-amber-50",
    sampleValues: ["hotel-dieu", "tour-eiffel", "palais-royal"],
  },
  {
    level: 12,
    name: "Floor",
    paramName: "floor",
    routeId: "explore-floor",
    borderColor: "border-orange-400",
    bgColor: "bg-orange-50",
    sampleValues: ["1", "2", "3"],
  },
  {
    level: 13,
    name: "Room",
    paramName: "room",
    routeId: "explore-room",
    borderColor: "border-red-400",
    bgColor: "bg-red-50",
    sampleValues: ["suite-royale", "chambre-bleue", "salon-vert"],
  },
];

export function buildExplorePath(upToLevel: number, params: Record<string, string>): string {
  let path = "/explore";
  for (let i = 1; i <= upToLevel; i++) {
    const level = EXPLORE_LEVELS[i];
    if (level.paramName) {
      path += "/" + (params[level.paramName] ?? level.sampleValues[0]);
    }
  }
  return path;
}

export function getDefaultFullPath(): string {
  return buildExplorePath(
    EXPLORE_LEVELS.length - 1,
    Object.fromEntries(
      EXPLORE_LEVELS.filter((l) => l.paramName).map((l) => [l.paramName!, l.sampleValues[0]]),
    ),
  );
}
