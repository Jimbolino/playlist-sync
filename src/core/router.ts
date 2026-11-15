import type { SiteAdapter } from "./types.js";
import { ahProductsAdapter } from "../adapters/ahProducts.js";
import { imdbChartAdapter } from "../adapters/imdbChart.js";
import { jumboProductsAdapter } from "../adapters/jumboProducts.js";
import { nl538HouseAdapter } from "../adapters/nl538House.js";
import { teatimeChartsAdapter, teatimePlaylistAdapter } from "../adapters/teatimeWayback.js";

const adapters: SiteAdapter[] = [
  imdbChartAdapter,
  teatimePlaylistAdapter,
  teatimeChartsAdapter,
  nl538HouseAdapter,
  ahProductsAdapter,
  jumboProductsAdapter,
];

export function matchAdapter(url: string): SiteAdapter | undefined {
  return adapters.find((a) => a.match(url));
}

export function listAdapters(): SiteAdapter[] {
  return [...adapters];
}
