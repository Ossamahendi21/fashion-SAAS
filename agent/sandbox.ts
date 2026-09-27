import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

/**
 * The stylist never runs commands (every shell/file tool is disabled in agent/tools), but eve still
 * provisions a sandbox template per agent. Pin the dependency-free just-bash backend so dev and
 * production start without Docker, microsandbox or Vercel Sandbox credentials.
 */
export default defineSandbox({ backend: justbash() });
