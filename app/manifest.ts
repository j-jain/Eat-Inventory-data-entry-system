import type { MetadataRoute } from "next";

/** PWA manifest — installable on warehouse phones (Add to Home Screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EAT Inventory",
    short_name: "EAT",
    description:
      "EAT storage-room inventory data-entry — receiving, sorting, pick list, assembly, dispatch.",
    start_url: "/dashboard",
    display: "standalone",
    background_color: "#F4F6DB",
    theme_color: "#BFDA3D",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
