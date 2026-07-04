export const MAPS_APIKEY: string =
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

export const NAVIGATION_PROVIDER: "google" | "osrm" =
  process.env.EXPO_PUBLIC_NAVIGATION_PROVIDER === "osrm" ? "osrm" : "google";

export const PARKING_STROKE: Record<string, string> = {
  free: "#4285F4",
  paid: "#EF4444",
  unknown: "#6B7280",
};
