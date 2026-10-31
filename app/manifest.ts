import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Resale HQ",
    short_name: "Resale HQ",
    description: "Selling our shit, one thing at a time: what we've got, offers, profit and notes.",
    start_url: "/",
    display: "standalone",
    background_color: "#141416",
    theme_color: "#f2b705",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/apple-icon", type: "image/png", sizes: "180x180" },
    ],
  };
}
