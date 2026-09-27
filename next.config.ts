import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {};

/** Mounts the stylist agent in `agent/` on this origin at `/eve/v1/*`, so `useEveAgent` needs no host. */
export default withEve(nextConfig);
