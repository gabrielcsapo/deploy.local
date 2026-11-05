import { navigation, type NavItem } from "../components/sidebar-nav";

const flatItems: NavItem[] = navigation.flatMap((section) => section.items);

export function getPrevNext(currentSlug: string): {
  prev: NavItem | null;
  next: NavItem | null;
} {
  const index = flatItems.findIndex((item) => item.slug === currentSlug);
  if (index === -1) return { prev: null, next: null };

  return {
    prev: index > 0 ? flatItems[index - 1] : null,
    next: index < flatItems.length - 1 ? flatItems[index + 1] : null,
  };
}
